import { createConsoleLogger } from '@repo-port-bot/logger'

import {
	renderNeedsHumanIssueBody,
	renderNeedsHumanIssueTitle,
	renderPortPullRequestBody,
	renderPortPullRequestTitle,
	renderSourceComment,
} from './render-body.ts'

import type { Octokit } from '@octokit/rest'
import type { Logger } from '@repo-port-bot/logger'

import type {
	DeliveryResult,
	ExecutionResult,
	PortContext,
	PortDecision,
	PortRunOutcome,
	RepoRef,
} from '../types.ts'

type CommandRunner = (input: {
	command: string[]
	workingDirectory: string
}) => Promise<{ exitCode: number; stderr: string; stdout: string }>

interface DeliverResultOptions {
	octokit: Octokit
	context: PortContext
	decision: PortDecision
	execution?: ExecutionResult
	targetWorkingDirectory: string
	runCommand?: CommandRunner
	logger?: Logger
}

interface CommentOnSourcePrOptions {
	octokit: Octokit
	sourceRepo: RepoRef
	pullRequestNumber: number
	context: PortContext
	outcome: Exclude<PortRunOutcome, 'skipped_not_required'>
	targetPullRequestUrl?: string
	followUpIssueUrl?: string
	runId: string
	logger?: Logger
}

const PORT_BOT_FOOTER = 'Ported-By: repo-port-bot'
const SHORT_SHA_LENGTH = 7

/**
 * Run a command and capture exit code + streams.
 *
 * @param input - Command execution input.
 * @param input.command - Command and arguments to execute.
 * @param input.workingDirectory - Directory where the command should run.
 * @returns Exit code and decoded output.
 */
async function runCommand(input: {
	command: string[]
	workingDirectory: string
}): Promise<{ exitCode: number; stderr: string; stdout: string }> {
	const process = Bun.spawn(input.command, {
		cwd: input.workingDirectory,
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [exitCode, stdoutBytes, stderrBytes] = await Promise.all([
		process.exited,
		new Response(process.stdout).bytes(),
		new Response(process.stderr).bytes(),
	])

	return {
		exitCode,
		stdout: Buffer.from(stdoutBytes).toString('utf8'),
		stderr: Buffer.from(stderrBytes).toString('utf8'),
	}
}

/**
 * Ensure command exits with code 0.
 *
 * @param runner - Command runner.
 * @param command - Command vector.
 * @param workingDirectory - Command cwd.
 */
async function expectCommandSuccess(
	runner: CommandRunner,
	command: string[],
	workingDirectory: string,
): Promise<void> {
	const result = await runner({ command, workingDirectory })

	if (result.exitCode !== 0) {
		throw new Error(
			`Command failed (${command.join(' ')}): exit ${String(result.exitCode)}\n${result.stderr}`,
		)
	}
}

/**
 * Build deterministic branch name for port branches.
 *
 * @param context - Port context.
 * @returns Branch name.
 */
function buildPortBranchName(context: PortContext): string {
	const shortSha = context.sourceChange.mergedCommitSha.slice(0, SHORT_SHA_LENGTH)
	const pullRequestNumber = context.sourceChange.pullRequest?.number ?? 0

	return `port/${context.sourceRepo.name}/${String(pullRequestNumber)}-${shortSha}`
}

/**
 * Build git commit message for the final delivery commit.
 *
 * @param context - Port context.
 * @returns Commit message.
 */
function buildCommitMessage(context: PortContext): string {
	const title = renderPortPullRequestTitle(context)
	const sourceReference = context.sourceChange.pullRequest
		? `Source-PR: ${context.sourceChange.pullRequest.url}`
		: `Source-Commit: ${context.sourceChange.mergedCommitSha}`

	return `${title}\n\n${sourceReference}\n${PORT_BOT_FOOTER}`
}

/**
 * Stage and commit current working tree state if there are staged changes.
 *
 * @param runner - Command runner.
 * @param workingDirectory - Repository root.
 * @param commitMessage - Commit message.
 */
async function stageAndCommit(
	runner: CommandRunner,
	workingDirectory: string,
	commitMessage: string,
): Promise<void> {
	await expectCommandSuccess(runner, ['git', 'add', '-A'], workingDirectory)

	const diffResult = await runner({
		command: ['git', 'diff', '--cached', '--quiet'],
		workingDirectory,
	})

	if (diffResult.exitCode === 0) {
		return
	}

	if (diffResult.exitCode !== 1) {
		throw new Error(`Unable to inspect staged diff: ${diffResult.stderr}`)
	}

	await expectCommandSuccess(runner, ['git', 'commit', '-m', commitMessage], workingDirectory)
}

/**
 * Add a best-effort source PR comment with target delivery status.
 *
 * @param options - Comment options.
 * @returns Created comment URL when successful.
 */
export async function commentOnSourcePr(
	options: CommentOnSourcePrOptions,
): Promise<string | undefined> {
	const logger = options.logger ?? createConsoleLogger('info')

	try {
		const response = await options.octokit.rest.issues.createComment({
			owner: options.sourceRepo.owner,
			repo: options.sourceRepo.name,
			issue_number: options.pullRequestNumber,
			body: renderSourceComment({
				context: options.context,
				outcome: options.outcome,
				targetPullRequestUrl: options.targetPullRequestUrl,
				followUpIssueUrl: options.followUpIssueUrl,
				runId: options.runId,
			}),
		})

		return response.data.html_url
	} catch (error) {
		logger.warn('[port-bot] Unable to comment on source pull request.', error)

		return undefined
	}
}

/**
 * Deliver a run result to GitHub (PR/issue) and remote git branch.
 *
 * @param options - Delivery options.
 * @returns Delivery outcome and produced URLs.
 */
export async function deliverResult(options: DeliverResultOptions): Promise<DeliveryResult> {
	const runner = options.runCommand ?? runCommand
	const targetRepo = options.context.pluginConfig.targetRepo

	if (options.decision.kind === 'PORT_NOT_REQUIRED') {
		return { outcome: 'skipped' }
	}

	if (options.decision.kind === 'NEEDS_HUMAN') {
		const issue = await options.octokit.rest.issues.create({
			owner: targetRepo.owner,
			repo: targetRepo.name,
			title: renderNeedsHumanIssueTitle(options.context),
			body: renderNeedsHumanIssueBody({
				context: options.context,
				decision: options.decision,
			}),
			labels: ['needs-human'],
		})

		return {
			outcome: 'needs_human',
			followUpIssueUrl: issue.data.html_url,
		}
	}

	if (!options.execution) {
		throw new Error('Execution result is required to deliver PORT_REQUIRED decisions.')
	}

	const branchName = buildPortBranchName(options.context)

	await expectCommandSuccess(
		runner,
		['git', 'checkout', '-b', branchName],
		options.targetWorkingDirectory,
	)
	await stageAndCommit(
		runner,
		options.targetWorkingDirectory,
		buildCommitMessage(options.context),
	)
	await expectCommandSuccess(
		runner,
		['git', 'push', '-u', 'origin', branchName],
		options.targetWorkingDirectory,
	)

	const pullRequest = await options.octokit.rest.pulls.create({
		owner: targetRepo.owner,
		repo: targetRepo.name,
		title: renderPortPullRequestTitle(options.context),
		body: renderPortPullRequestBody({
			context: options.context,
			decision: options.decision,
			execution: options.execution,
		}),
		head: branchName,
		base: targetRepo.defaultBranch,
		draft: !options.execution.success,
	})

	const labels = options.execution.success ? ['auto-port'] : ['auto-port', 'port-stalled']

	await options.octokit.rest.issues.addLabels({
		owner: targetRepo.owner,
		repo: targetRepo.name,
		issue_number: pullRequest.data.number,
		labels,
	})

	return {
		outcome: options.execution.success ? 'pr_opened' : 'draft_pr_opened',
		targetPullRequestUrl: pullRequest.data.html_url,
	}
}

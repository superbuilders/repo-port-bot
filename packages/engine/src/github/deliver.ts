import { spawn } from 'node:child_process'

import { createConsoleLogger } from '@repo-port-bot/logger'

import {
	renderNeedsHumanIssueBody,
	renderNeedsHumanIssueTitle,
	renderPortPullRequestBody,
	renderPortPullRequestTitle,
	renderSourceComment,
} from './render-body.ts'

import type { Logger } from '@repo-port-bot/logger'

import type {
	DeliveryResult,
	ExecutionResult,
	GitHubWriter,
	PortContext,
	PortDecision,
	PortRunOutcome,
} from '../types.ts'

type CommandRunner = (input: {
	command: string[]
	workingDirectory: string
}) => Promise<{ exitCode: number; stderr: string; stdout: string }>

interface DeliverResultOptions {
	writer: GitHubWriter
	context: PortContext
	decision: PortDecision
	execution?: ExecutionResult
	targetWorkingDirectory: string
	runCommand?: CommandRunner
	logger?: Logger
}

interface CommentOnSourcePrOptions {
	writer: GitHubWriter
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
	const [command, ...args] = input.command
	const childProcess = spawn(command ?? '', args, {
		cwd: input.workingDirectory,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const stdoutChunks: Buffer[] = []
	const stderrChunks: Buffer[] = []

	childProcess.stdout?.on('data', chunk => {
		stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	})
	childProcess.stderr?.on('data', chunk => {
		stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	})

	const exitCode = await new Promise<number>(resolve => {
		childProcess.once('close', code => {
			resolve(code ?? 1)
		})
		childProcess.once('error', () => {
			resolve(1)
		})
	})

	return {
		exitCode,
		stdout: Buffer.concat(stdoutChunks).toString('utf8'),
		stderr: Buffer.concat(stderrChunks).toString('utf8'),
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
		return await options.writer.createComment({
			owner: options.context.sourceRepo.owner,
			repo: options.context.sourceRepo.name,
			issueNumber: options.pullRequestNumber,
			body: renderSourceComment({
				context: options.context,
				outcome: options.outcome,
				targetPullRequestUrl: options.targetPullRequestUrl,
				followUpIssueUrl: options.followUpIssueUrl,
				runId: options.runId,
			}),
		})
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
		const issue = await options.writer.createIssue({
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
			followUpIssueUrl: issue.url,
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

	const pullRequest = await options.writer.createPullRequest({
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

	await options.writer.addLabels({
		owner: targetRepo.owner,
		repo: targetRepo.name,
		issueNumber: pullRequest.number,
		labels,
	})

	return {
		outcome: options.execution.success ? 'pr_opened' : 'draft_pr_opened',
		targetPullRequestUrl: pullRequest.url,
	}
}

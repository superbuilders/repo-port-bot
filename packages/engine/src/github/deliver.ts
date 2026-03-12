import { createConsoleLogger } from '@repo-port-bot/logger'

import {
	buildCommitMessage,
	buildPortBranchName,
	checkTargetSideDiff,
	collectTouchedPaths,
	expectCommandSuccess,
	isValidationSuccessful,
	resolveFramingMode,
	runCommand,
	stageAndCommit,
} from './ops.ts'
import {
	renderNeedsHumanIssueBody,
	renderNeedsHumanIssueTitle,
	renderPortPullRequestBody,
	renderPortPullRequestTitle,
	renderSourceComment,
} from './render-body.ts'

import type { Logger } from '@repo-port-bot/logger'

import type {
	CommandRunner,
	CreatedPullRequest,
	DeterministicPhaseResult,
	DecisionTrace,
	DeliveryResult,
	ExecutePortResult,
	GitHubWriter,
	PortContext,
	PortDecision,
	PrFramingMode,
	PortRunOutcome,
	ValidationCommandResult,
} from '../types.ts'

interface DeliverResultOptions {
	writer: GitHubWriter
	context: PortContext
	deterministic?: DeterministicPhaseResult
	decision: PortDecision
	decisionTrace?: DecisionTrace
	execution?: ExecutePortResult
	validation?: ValidationCommandResult[]
	framingMode?: PrFramingMode
	targetWorkingDirectory: string
	includeCostTelemetry?: boolean
	runCommand?: CommandRunner
	logger?: Logger
}

interface CommentOnSourcePrOptions {
	writer: GitHubWriter
	pullRequestNumber: number
	context: PortContext
	decision: PortDecision
	decisionTrace?: DecisionTrace
	outcome: PortRunOutcome
	targetPullRequestUrl?: string
	followUpIssueUrl?: string
	execution?: ExecutePortResult
	includeCostTelemetry?: boolean
	runId: string
	logger?: Logger
}

interface PreviousFailedCommentContext {
	id: number
	url: string
	runId?: string
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

	let existingComment: PreviousFailedCommentContext | undefined = undefined

	try {
		existingComment = await findExistingSourceComment({
			writer: options.writer,
			owner: options.context.sourceRepo.owner,
			repo: options.context.sourceRepo.name,
			issueNumber: options.pullRequestNumber,
			targetRepo: `${options.context.pluginConfig.targetRepo.owner}/${options.context.pluginConfig.targetRepo.name}`,
		})
	} catch (lookupError) {
		logger.warn('[port-bot] Unable to look up prior source comments.', lookupError)
	}

	const shouldUpdateExisting =
		existingComment?.id !== undefined && options.writer.updateComment !== undefined
	const body = renderSourceComment({
		context: options.context,
		decision: options.decision,
		decisionTrace: options.decisionTrace,
		outcome: options.outcome,
		targetPullRequestUrl: options.targetPullRequestUrl,
		followUpIssueUrl: options.followUpIssueUrl,
		execution: options.execution,
		includeCostTelemetry: options.includeCostTelemetry ?? true,
		runId: options.runId,
		supersededFailureCommentUrl:
			!shouldUpdateExisting && existingComment?.runId ? existingComment.url : undefined,
		supersededFailureRunId: !shouldUpdateExisting ? existingComment?.runId : undefined,
	})

	try {
		if (shouldUpdateExisting) {
			const existingManagedComment = existingComment
			const updateComment = options.writer.updateComment

			if (!existingManagedComment || !updateComment) {
				throw new Error(
					'Source comment update path was selected without update capability.',
				)
			}

			return await updateComment({
				owner: options.context.sourceRepo.owner,
				repo: options.context.sourceRepo.name,
				commentId: existingManagedComment.id,
				body,
			})
		}

		return await options.writer.createComment({
			owner: options.context.sourceRepo.owner,
			repo: options.context.sourceRepo.name,
			issueNumber: options.pullRequestNumber,
			body,
		})
	} catch (error) {
		logger.warn('[port-bot] Unable to comment on source pull request.', error)

		return undefined
	}
}

/**
 * Find the current bot-managed source comment for this target repo, if any.
 *
 * @param input - Lookup options.
 * @param input.writer - GitHub writer adapter.
 * @param input.owner - Source repository owner.
 * @param input.repo - Source repository name.
 * @param input.issueNumber - Source pull request number.
 * @param input.targetRepo - Target repository identifier.
 * @returns Existing source comment context when found.
 */
async function findExistingSourceComment(input: {
	writer: GitHubWriter
	owner: string
	repo: string
	issueNumber: number
	targetRepo: string
}): Promise<PreviousFailedCommentContext | undefined> {
	if (!input.writer.listComments) {
		return undefined
	}

	const comments = await input.writer.listComments({
		owner: input.owner,
		repo: input.repo,
		issueNumber: input.issueNumber,
	})
	const marker = `<!-- repo-port-bot:source-comment target=${input.targetRepo} -->`
	const matchingComments = comments
		.filter(comment => comment.body.includes(marker))
		.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
	const latestMatchingComment = matchingComments[0]

	if (!latestMatchingComment) {
		return undefined
	}

	const runIdMatch = /Run ID: `([^`]+)`/u.exec(latestMatchingComment.body)

	return {
		id: latestMatchingComment.id,
		url: latestMatchingComment.url,
		runId: runIdMatch?.[1],
	}
}

/**
 * Create a new PR or update an existing one for the same head branch.
 *
 * @param params - PR upsert parameters.
 * @param params.writer - GitHub writer adapter.
 * @param params.owner - Target repository owner.
 * @param params.repo - Target repository name.
 * @param params.title - PR title.
 * @param params.body - PR body markdown.
 * @param params.head - Head branch name.
 * @param params.base - Base branch name.
 * @param params.draft - Whether to create as draft.
 * @returns Created or existing PR metadata.
 */
async function upsertPullRequest(params: {
	writer: GitHubWriter
	owner: string
	repo: string
	title: string
	body: string
	head: string
	base: string
	draft: boolean
}): Promise<CreatedPullRequest> {
	try {
		return await params.writer.createPullRequest({
			owner: params.owner,
			repo: params.repo,
			title: params.title,
			body: params.body,
			head: params.head,
			base: params.base,
			draft: params.draft,
		})
	} catch (createError) {
		if (!isExistingPullRequestError(createError)) {
			throw createError
		}

		if (!params.writer.findPullRequestForBranch) {
			throw createError
		}

		const existing = await params.writer.findPullRequestForBranch({
			owner: params.owner,
			repo: params.repo,
			head: params.head,
			base: params.base,
		})

		if (!existing) {
			throw createError
		}

		if (params.writer.updatePullRequest) {
			await params.writer.updatePullRequest({
				owner: params.owner,
				repo: params.repo,
				pullNumber: existing.number,
				title: params.title,
				body: params.body,
				draft: params.draft,
			})
		}

		return existing
	}
}

/**
 * Create a new needs-human issue or update an existing open one for the same source change.
 *
 * @param params - Issue upsert parameters.
 * @param params.writer - GitHub writer adapter.
 * @param params.owner - Target repository owner.
 * @param params.repo - Target repository name.
 * @param params.title - Issue title.
 * @param params.body - Issue body markdown.
 * @param params.labels - Labels to apply to the issue.
 * @param params.sourcePullRequestUrl - Source PR URL when available.
 * @param params.sourceCommitSha - Source merge commit SHA used as fallback identity.
 * @returns Created or existing issue metadata.
 */
async function upsertNeedsHumanIssue(params: {
	writer: GitHubWriter
	owner: string
	repo: string
	title: string
	body: string
	labels: string[]
	sourcePullRequestUrl?: string
	sourceCommitSha: string
}): Promise<{ number: number; url: string }> {
	const existing = params.writer.findNeedsHumanIssueForSource
		? await params.writer.findNeedsHumanIssueForSource({
				owner: params.owner,
				repo: params.repo,
				sourcePullRequestUrl: params.sourcePullRequestUrl,
				sourceCommitSha: params.sourceCommitSha,
			})
		: undefined

	if (existing) {
		if (params.writer.updateIssue) {
			await params.writer.updateIssue({
				owner: params.owner,
				repo: params.repo,
				issueNumber: existing.number,
				title: params.title,
				body: params.body,
			})
		}

		await params.writer.addLabels({
			owner: params.owner,
			repo: params.repo,
			issueNumber: existing.number,
			labels: params.labels,
		})

		return existing
	}

	return params.writer.createIssue({
		owner: params.owner,
		repo: params.repo,
		title: params.title,
		body: params.body,
		labels: params.labels,
	})
}

/**
 * Check whether a PR creation error indicates a PR already exists for the head branch.
 *
 * @param error - Error from createPullRequest.
 * @returns True when the error is a 422 "pull request already exists" response.
 */
function isExistingPullRequestError(error: unknown): boolean {
	if (!error || typeof error !== 'object') {
		return false
	}

	const HTTP_UNPROCESSABLE = 422
	const status = (error as { status?: unknown }).status

	if (status !== HTTP_UNPROCESSABLE) {
		return false
	}

	const message = (error as { message?: unknown }).message

	return typeof message === 'string' && message.toLowerCase().includes('already exists')
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
	const deterministic = options.deterministic ?? options.context.deterministic
	const deterministicChanged = deterministic?.changed === true
	const isPortRequired = options.decision.kind === 'PORT_REQUIRED'
	const shouldCreateTargetPr = isPortRequired || deterministicChanged

	if (!shouldCreateTargetPr) {
		if (options.decision.kind === 'NO_AGENT_PORT_NEEDED') {
			return { outcome: 'skipped' }
		}

		const issue = await upsertNeedsHumanIssue({
			writer: options.writer,
			owner: targetRepo.owner,
			repo: targetRepo.name,
			title: renderNeedsHumanIssueTitle(options.context),
			body: renderNeedsHumanIssueBody({
				context: options.context,
				decision: options.decision,
			}),
			labels: ['needs-human'],
			sourcePullRequestUrl: options.context.sourceChange.pullRequest?.url,
			sourceCommitSha: options.context.sourceChange.mergedCommitSha,
		})

		return {
			outcome: 'needs_human',
			followUpIssueUrl: issue.url,
		}
	}

	if (isPortRequired && !options.execution) {
		throw new Error('Execution result is required to deliver PORT_REQUIRED decisions.')
	}

	const touchedPaths = isPortRequired
		? []
		: collectTouchedPaths(
				options.deterministic,
				options.context.deterministic,
				options.execution,
			)

	if (!isPortRequired) {
		const hasTargetDiff = await checkTargetSideDiff(
			runner,
			options.targetWorkingDirectory,
			touchedPaths,
		)

		if (!hasTargetDiff) {
			return { outcome: 'skipped' }
		}
	}

	const branchName = buildPortBranchName(options.context)

	await expectCommandSuccess(
		runner,
		['git', 'checkout', '-b', branchName],
		options.targetWorkingDirectory,
	)

	const framingMode = resolveFramingMode(
		options.framingMode,
		isPortRequired,
		options.execution?.outcome.status,
		options.decision.kind,
	)

	const committed = await stageAndCommit(
		runner,
		options.targetWorkingDirectory,
		buildCommitMessage(options.context, options.execution?.trace.model, framingMode),
		touchedPaths,
	)

	if (!committed) {
		return { outcome: 'skipped' }
	}

	await expectCommandSuccess(
		runner,
		['git', 'push', '--force', '-u', 'origin', branchName],
		options.targetWorkingDirectory,
	)

	const prBody = renderPortPullRequestBody({
		context: options.context,
		deterministic,
		decision: options.decision,
		decisionTrace: options.decisionTrace,
		execution: options.execution,
		validation: options.validation,
		framingMode,
		includeCostTelemetry: options.includeCostTelemetry ?? true,
	})
	const isSuccessful = isPortRequired
		? options.execution?.outcome.status === 'SUCCEEDED'
		: isValidationSuccessful(options.validation)
	const pullRequest = await upsertPullRequest({
		writer: options.writer,
		owner: targetRepo.owner,
		repo: targetRepo.name,
		title: renderPortPullRequestTitle(options.context, framingMode),
		body: prBody,
		head: branchName,
		base: targetRepo.defaultBranch,
		draft: !isSuccessful,
	})

	const labels = isSuccessful ? ['auto-port'] : ['auto-port', 'port-stalled']

	await options.writer.addLabels({
		owner: targetRepo.owner,
		repo: targetRepo.name,
		issueNumber: pullRequest.number,
		labels,
	})

	if (isSuccessful && options.writer.removeLabel) {
		try {
			await options.writer.removeLabel({
				owner: targetRepo.owner,
				repo: targetRepo.name,
				issueNumber: pullRequest.number,
				label: 'port-stalled',
			})
		} catch {
			// best-effort cleanup
		}
	}

	return {
		outcome: isSuccessful ? 'pr_opened' : 'draft_pr_opened',
		targetPullRequestUrl: pullRequest.url,
	}
}

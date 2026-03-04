import { joinNonEmptyLines } from '../utils.ts'

import type {
	ExecutionResult,
	PortContext,
	PortDecision,
	PortRunOutcome,
	ValidationCommandResult,
} from '../types.ts'

interface RenderPullRequestBodyInput {
	context: PortContext
	decision: PortDecision
	execution: ExecutionResult
}

interface RenderNeedsHumanIssueBodyInput {
	context: PortContext
	decision: PortDecision
}

interface RenderSourceCommentInput {
	context: PortContext
	outcome: Exclude<PortRunOutcome, 'skipped_not_required'>
	targetPullRequestUrl?: string
	followUpIssueUrl?: string
	runId: string
}

interface RenderRunSummaryInput {
	outcome: PortRunOutcome
	decision: PortDecision
	execution?: ExecutionResult
	targetPullRequestUrl?: string
	followUpIssueUrl?: string
	errorMessage?: string
}

const SHORT_SHA_LENGTH = 7
const MAX_NEEDS_HUMAN_SOURCE_TITLE_LENGTH = 60

/**
 * Truncate text for compact issue titles.
 *
 * @param value - Raw text.
 * @param maxLength - Maximum output length.
 * @returns Truncated text with ellipsis when needed.
 */
function truncateForTitle(value: string, maxLength: number): string {
	if (value.length <= maxLength) {
		return value
	}

	return `${value.slice(0, maxLength - 1)}…`
}

/**
 * Render the standard target pull request title.
 *
 * @param context - Port context with source PR metadata.
 * @returns Title in the canonical format.
 */
export function renderPortPullRequestTitle(context: PortContext): string {
	const sourcePullRequest = context.sourceChange.pullRequest

	if (!sourcePullRequest) {
		return `Port: source change (${context.sourceChange.mergedCommitSha.slice(0, SHORT_SHA_LENGTH)})`
	}

	return `Port: ${sourcePullRequest.title} (#${String(sourcePullRequest.number)})`
}

/**
 * Render the title for a needs-human follow-up issue.
 *
 * @param context - Port context with source PR metadata.
 * @returns Issue title.
 */
export function renderNeedsHumanIssueTitle(context: PortContext): string {
	const sourcePullRequest = context.sourceChange.pullRequest

	if (!sourcePullRequest) {
		return `Needs review: ${context.sourceChange.mergedCommitSha.slice(0, SHORT_SHA_LENGTH)}`
	}

	return `Needs review: ${truncateForTitle(sourcePullRequest.title, MAX_NEEDS_HUMAN_SOURCE_TITLE_LENGTH)}`
}

/**
 * Render a compact markdown line for one validation result.
 *
 * @param result - Validation command result.
 * @returns Markdown bullet line.
 */
function renderValidationLine(result: ValidationCommandResult): string {
	const status = result.ok ? '[PASS]' : '[FAIL]'
	const exitCodeSuffix =
		result.exitCode === undefined ? '' : ` (exit code ${String(result.exitCode)})`

	return `- ${status} \`${result.command}\`${exitCodeSuffix}`
}

/**
 * Render a markdown summary of the latest validation attempt.
 *
 * @param execution - Execution details from the execution stage.
 * @returns Validation summary section.
 */
function renderValidationSummary(execution: ExecutionResult): string {
	const latestAttempt = execution.history.at(-1)

	if (!latestAttempt || latestAttempt.validation.length === 0) {
		return '- No validation output recorded.'
	}

	return latestAttempt.validation.map(renderValidationLine).join('\n')
}

/**
 * Render the markdown body for a target pull request.
 *
 * @param input - Rendering input.
 * @param input.context - Port context.
 * @param input.decision - Decision that led to execution.
 * @param input.execution - Execution result with diagnostics.
 * @returns Pull request body markdown.
 */
export function renderPortPullRequestBody(input: RenderPullRequestBodyInput): string {
	const sourcePullRequest = input.context.sourceChange.pullRequest
	const sourceReference = sourcePullRequest
		? `[#${String(sourcePullRequest.number)}](${sourcePullRequest.url})`
		: `commit \`${input.context.sourceChange.mergedCommitSha}\``
	const touchedFiles =
		input.execution.touchedFiles.length > 0
			? input.execution.touchedFiles.map(path => `- \`${path}\``).join('\n')
			: '- No files recorded.'
	const attemptNotes = input.execution.history
		.map((attempt, index) => {
			if (!attempt.notes) {
				return undefined
			}

			return `- Attempt ${String(index + 1)}: ${attempt.notes}`
		})
		.filter((value): value is string => value !== undefined)
	const notesSection = attemptNotes.length > 0 ? attemptNotes.join('\n') : '- None.'
	const failureLine = input.execution.success
		? '- Final status: validation passed.'
		: `- Final status: validation failed after retries.\n- Failure reason: ${input.execution.failureReason ?? 'Unknown failure reason.'}`

	return [
		'## Source',
		`- ${sourceReference}`,
		'',
		'## Decision',
		`- Kind: \`${input.decision.kind}\``,
		`- Reason: ${input.decision.reason}`,
		'',
		'## Files touched',
		touchedFiles,
		'',
		'## Validation',
		renderValidationSummary(input.execution),
		failureLine,
		'',
		'## Notes',
		notesSection,
		'',
		'Ported-By: repo-port-bot',
	].join('\n')
}

/**
 * Render the markdown body for a needs-human issue.
 *
 * @param input - Rendering input.
 * @param input.context - Port context.
 * @param input.decision - Needs-human decision details.
 * @returns Issue body markdown.
 */
export function renderNeedsHumanIssueBody(input: RenderNeedsHumanIssueBodyInput): string {
	const sourcePullRequest = input.context.sourceChange.pullRequest
	const sourceRepo = `${input.context.sourceRepo.owner}/${input.context.sourceRepo.name}`
	const openingSentence = sourcePullRequest
		? `[${sourcePullRequest.title}](${sourcePullRequest.url}) was merged in \`${sourceRepo}\` but could not be automatically ported.`
		: `Commit \`${input.context.sourceChange.mergedCommitSha}\` was pushed to \`${sourceRepo}\` but could not be automatically ported.`
	const fileCount = String(input.context.sourceChange.files.length)

	return [
		openingSentence,
		'',
		`**Why:** ${input.decision.reason}`,
		'',
		`**Changed files:** ${fileCount}`,
	].join('\n')
}

/**
 * Render a source PR notification comment describing the run outcome.
 *
 * @param input - Rendering input.
 * @param input.context - Port context with source metadata.
 * @param input.outcome - Terminal run outcome.
 * @param input.targetPullRequestUrl - Optional created target PR URL.
 * @param input.followUpIssueUrl - Optional created needs-human issue URL.
 * @param input.runId - Pipeline run ID for correlation.
 * @returns Comment markdown body.
 */
export function renderSourceComment(input: RenderSourceCommentInput): string {
	const sourcePullRequest = input.context.sourceChange.pullRequest
	const sourceReference = sourcePullRequest
		? `[#${String(sourcePullRequest.number)}](${sourcePullRequest.url})`
		: `commit \`${input.context.sourceChange.mergedCommitSha}\``

	switch (input.outcome) {
		case 'pr_opened': {
			return [
				'Auto-port update:',
				input.targetPullRequestUrl
					? `- Port PR opened: ${input.targetPullRequestUrl}`
					: '- Port PR opened in target repository.',
				'- Validation passed; ready for review.',
				`- Source: ${sourceReference}`,
				`- Run ID: \`${input.runId}\``,
			].join('\n')
		}
		case 'draft_pr_opened': {
			return [
				'Auto-port update:',
				input.targetPullRequestUrl
					? `- Draft port PR opened: ${input.targetPullRequestUrl}`
					: '- Draft port PR opened in target repository.',
				'- Validation failed after retries; manual follow-up needed.',
				`- Source: ${sourceReference}`,
				`- Run ID: \`${input.runId}\``,
			].join('\n')
		}
		case 'needs_human': {
			return [
				'Auto-port update:',
				input.followUpIssueUrl
					? `- Human follow-up issue opened: ${input.followUpIssueUrl}`
					: '- Human follow-up issue created in target repository.',
				'- Port was deferred by decision stage for human review.',
				`- Source: ${sourceReference}`,
				`- Run ID: \`${input.runId}\``,
			].join('\n')
		}
		case 'failed': {
			return [
				'Auto-port update:',
				'- Port run failed due to an engine-level error before successful delivery.',
				`- Source: ${sourceReference}`,
				`- Run ID: \`${input.runId}\``,
			].join('\n')
		}
		default: {
			return [
				'Auto-port update:',
				`- Source: ${sourceReference}`,
				`- Run ID: \`${input.runId}\``,
			].join('\n')
		}
	}
}

/**
 * Render a one-line human-readable run summary from stage outputs.
 *
 * @param input - Summary composition input.
 * @returns Human-readable summary text.
 */
export function renderRunSummary(input: RenderRunSummaryInput): string {
	const { decision, execution, followUpIssueUrl, outcome, targetPullRequestUrl } = input

	switch (outcome) {
		case 'skipped_not_required': {
			return `Skipped: ${decision.reason}`
		}
		case 'needs_human': {
			return (
				joinNonEmptyLines(
					[
						`Needs human review: ${decision.reason}`,
						followUpIssueUrl && `Issue: ${followUpIssueUrl}`,
					],
					' ',
				) ?? `Needs human review: ${decision.reason}`
			)
		}
		case 'pr_opened': {
			return (
				joinNonEmptyLines(
					[
						targetPullRequestUrl && `Port PR opened: ${targetPullRequestUrl}`,
						execution && `(${String(execution.attempts)} attempts)`,
					],
					' ',
				) ?? 'Port PR opened.'
			)
		}
		case 'draft_pr_opened': {
			return (
				joinNonEmptyLines(
					[
						targetPullRequestUrl &&
							`Draft PR opened (stalled): ${targetPullRequestUrl}.`,
						execution?.failureReason,
					],
					' ',
				) ?? 'Draft PR opened (stalled).'
			)
		}
		case 'failed': {
			return `Engine failure: ${input.errorMessage ?? decision.reason}`
		}
		default: {
			return 'Port run completed.'
		}
	}
}

import type {
	ExecutionResult,
	PortContext,
	PortDecision,
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

const SHORT_SHA_LENGTH = 7

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
		return `Port needs human review (${context.sourceChange.mergedCommitSha.slice(0, SHORT_SHA_LENGTH)})`
	}

	return `Port needs human review: ${sourcePullRequest.title} (#${String(sourcePullRequest.number)})`
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
	const sourceReference = sourcePullRequest
		? `[#${String(sourcePullRequest.number)}](${sourcePullRequest.url})`
		: `commit \`${input.context.sourceChange.mergedCommitSha}\``
	const signals =
		input.decision.signals && input.decision.signals.length > 0
			? input.decision.signals.map(signal => `- \`${signal}\``).join('\n')
			: '- None.'
	const changedFiles =
		input.context.sourceChange.files.length > 0
			? input.context.sourceChange.files.map(file => `- \`${file.path}\``).join('\n')
			: '- No files detected.'

	return [
		'## Source',
		`- ${sourceReference}`,
		'',
		'## Decision rationale',
		`- ${input.decision.reason}`,
		'',
		'## Signals',
		signals,
		'',
		'## Changed files',
		changedFiles,
	].join('\n')
}

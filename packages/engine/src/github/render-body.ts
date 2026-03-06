import { formatDuration, joinNonEmptyLines } from '../utils.ts'

const PORT_BOT_REPO_URL = 'https://github.com/superbuilders/repo-port-bot'

import type {
	AttemptEvent,
	ExecutionAttempt,
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
	decision: PortDecision
	outcome: PortRunOutcome
	targetPullRequestUrl?: string
	followUpIssueUrl?: string
	runId: string
	supersededFailureCommentUrl?: string
	supersededFailureRunId?: string
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
const MAX_WORK_LOG_LINES_PER_ATTEMPT = 24
const LOW_SIGNAL_TOOL_NAMES = new Set(['Glob', 'Grep'])

/**
 * Filter predicate that removes `undefined` while preserving empty strings
 * (used as markdown paragraph separators).
 *
 * @param value - Candidate line.
 * @returns True when the value is a string (including empty).
 */
function isDefinedLine(value: string | undefined): value is string {
	return value !== undefined
}

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

	return `Port: ${sourcePullRequest.title}`
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
 * Render the collapsible validation & diagnostics block.
 *
 * @param execution - Execution details.
 * @returns HTML details block with validation results.
 */
function renderDiagnosticsBlock(execution: ExecutionResult): string {
	const validationLines = renderValidationSummary(execution)
	const failureLine = !execution.success
		? `- Final status: validation failed after retries.\n- Failure reason: ${execution.failureReason ?? 'Unknown failure reason.'}`
		: undefined
	const detailsTag = execution.success ? '<details>' : '<details open>'

	return [
		`${detailsTag}<summary>Validation & diagnostics</summary>`,
		'',
		validationLines,
		failureLine,
		'',
		'</details>',
	]
		.filter(isDefinedLine)
		.join('\n')
}

/**
 * Render compact execution metrics for PR notes.
 *
 * @param execution - Execution details.
 * @returns One-line metrics string.
 */
function renderExecutionMetrics(execution: ExecutionResult): string {
	const toolCallCount = execution.history.reduce(
		(count, attempt) => count + attempt.toolCallLog.length,
		0,
	)

	const durationSuffix =
		execution.durationMs !== undefined ? ` · ${formatDuration(execution.durationMs)}` : ''

	const fileCount = execution.touchedFiles.length

	return `${String(fileCount)} file${fileCount === 1 ? '' : 's'} changed · ${String(execution.attempts)} attempt${execution.attempts === 1 ? '' : 's'} · ${String(toolCallCount)} tool call${toolCallCount === 1 ? '' : 's'}${durationSuffix}`
}

/**
 * Render attempt notes with stable per-attempt headings.
 *
 * @param execution - Execution details.
 * @returns Markdown sections for each attempt.
 */
function renderAttemptNotes(execution: ExecutionResult): string {
	if (execution.history.length === 0) {
		return '_No notes recorded._'
	}

	const lastAttempt = execution.history.at(-1)
	const notes = lastAttempt?.notes?.trim() || '_No notes recorded._'

	return notes
}

/**
 * Render one attempt's humanized work-log as markdown blocks.
 *
 * Groups consecutive tool events into fenced code blocks and wraps
 * assistant notes in italics, separated by blank lines.
 *
 * @param attempt - Attempt details.
 * @param stripLastAssistantNote - When true, drop the final assistant note (already shown in "What was ported").
 * @returns Markdown string for this attempt's work log.
 */
function renderAttemptWorkLogBody(
	attempt: ExecutionAttempt,
	stripLastAssistantNote: boolean,
): string {
	const toolDurations = new Map<string, number | undefined>()

	for (const event of attempt.events) {
		if (event.kind === 'tool_end') {
			toolDurations.set(event.toolUseId, event.durationMs)
		}
	}

	type Block = { kind: 'assistant'; text: string } | { kind: 'tool'; lines: string[] }

	const blocks: Block[] = []
	let eventCount = 0

	for (const event of attempt.events) {
		if (event.kind === 'tool_end') {
			// skip: duration already captured in toolDurations map
		} else if (event.kind === 'assistant_note') {
			const text = event.text.trim()

			if (text.length > 0) {
				blocks.push({ kind: 'assistant', text })
				eventCount += 1
			}
		} else {
			const toolLine = summarizeToolStartEvent(event, toolDurations.get(event.toolUseId))

			if (toolLine) {
				eventCount += 1

				const lastBlock = blocks.at(-1)

				if (lastBlock?.kind === 'tool') {
					lastBlock.lines.push(toolLine)
				} else {
					blocks.push({ kind: 'tool', lines: [toolLine] })
				}
			}
		}
	}

	if (stripLastAssistantNote && blocks.at(-1)?.kind === 'assistant') {
		blocks.pop()
	}

	if (blocks.length === 0) {
		return '_No work-log events recorded._'
	}

	const rendered = blocks.map(block => {
		if (block.kind === 'assistant') {
			return `_${block.text}_`
		}

		return ['```', ...block.lines, '```'].join('\n')
	})

	if (eventCount > MAX_WORK_LOG_LINES_PER_ATTEMPT) {
		return [...rendered.slice(0, MAX_WORK_LOG_LINES_PER_ATTEMPT), `_...and more events._`].join(
			'\n\n',
		)
	}

	return rendered.join('\n\n')
}

/**
 * Render one tool start event in humanized form.
 *
 * @param event - Tool start event.
 * @param durationMs - Optional paired duration from tool end.
 * @returns Humanized line or undefined for low-signal tools.
 */
function summarizeToolStartEvent(
	event: Extract<AttemptEvent, { kind: 'tool_start' }>,
	durationMs?: number,
): string | undefined {
	if (LOW_SIGNAL_TOOL_NAMES.has(event.toolName)) {
		return undefined
	}

	const filePath = readStringField(event.toolInput, 'file_path')
	const command = readStringField(event.toolInput, 'command')
	const durationSuffix = durationMs === undefined ? '' : ` (${formatDuration(durationMs)})`

	switch (event.toolName) {
		case 'Read': {
			return filePath ? `Read \`${filePath}\`` : 'Read a file.'
		}
		case 'Edit': {
			return filePath ? `Edited \`${filePath}\`` : 'Edited a file.'
		}
		case 'Write': {
			return filePath ? `Created \`${filePath}\`` : 'Created a file.'
		}
		case 'Bash': {
			return command
				? `Ran \`${command}\`${durationSuffix}`
				: `Ran a shell command${durationSuffix}.`
		}
		default: {
			return `Ran ${event.toolName}${durationSuffix}`
		}
	}
}

/**
 * Read a string field from optional tool input payload.
 *
 * @param record - Tool input record.
 * @param key - Field key.
 * @returns String value when present.
 */
function readStringField(
	record: Record<string, unknown> | undefined,
	key: string,
): string | undefined {
	const value = record?.[key]

	return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * Render a collapsed, humanized agent work log section.
 *
 * @param execution - Execution details.
 * @returns HTML details block with per-attempt narrative.
 */
function renderAgentWorkLog(execution: ExecutionResult): string {
	const lastAttemptNumber = execution.history.at(-1)?.attempt

	const attemptSections = execution.history.map(attempt => {
		const isLastAttempt = attempt.attempt === lastAttemptNumber
		const body = renderAttemptWorkLogBody(attempt, isLastAttempt)

		return execution.history.length > 1
			? [`### Attempt ${String(attempt.attempt)}`, '', body].join('\n')
			: body
	})

	return [
		'<details><summary>Agent Work Log</summary>',
		'',
		...attemptSections,
		'',
		'</details>',
	].join('\n\n')
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
	const sourceRepo = `${input.context.sourceRepo.owner}/${input.context.sourceRepo.name}`
	const sourceRepoUrl = `https://github.com/${sourceRepo}`
	const sourceRepoLink = `[\`${sourceRepo}\`](${sourceRepoUrl})`
	const sourceNarrative = sourcePullRequest
		? `Ported from [${sourcePullRequest.title}](${sourcePullRequest.url}) in ${sourceRepoLink}.`
		: `Ported from commit \`${input.context.sourceChange.mergedCommitSha}\` in ${sourceRepoLink}.`

	const atAGlance = renderExecutionMetrics(input.execution)

	const reasonLines = input.decision.reason.split('\n').map(line => `> ${line}`)

	if (input.execution.model) {
		const modelUrl = `https://models.dev/?search=${encodeURIComponent(input.execution.model)}`

		reasonLines.push('>', `> — [${input.execution.model}](${modelUrl}) _(${atAGlance})_`)
	} else {
		reasonLines.push('>', `> ${atAGlance}`)
	}

	const reasonBlockquote = reasonLines.join('\n')

	const noValidationConfigured = input.context.pluginConfig.validationCommands.length === 0

	const diagnosticsBlock = noValidationConfigured
		? undefined
		: renderDiagnosticsBlock(input.execution)
	const agentWorkLog = renderAgentWorkLog(input.execution)

	return [
		'## Cross-repo port',
		'',
		reasonBlockquote,
		'',
		sourceNarrative,
		'',
		'### What was ported',
		'',
		renderAttemptNotes(input.execution),
		'',
		agentWorkLog,
		'',
		diagnosticsBlock,
		'',
		'---',
		`Ported by: [Repo Port Bot](${PORT_BOT_REPO_URL})`,
	]
		.filter(isDefinedLine)
		.join('\n')
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
 * @param input.decision - Decision that led to this outcome.
 * @param input.outcome - Terminal run outcome.
 * @param input.targetPullRequestUrl - Optional created target PR URL.
 * @param input.followUpIssueUrl - Optional created needs-human issue URL.
 * @param input.runId - Pipeline run ID for correlation.
 * @returns Comment markdown body.
 */
export function renderSourceComment(input: RenderSourceCommentInput): string {
	const targetRepo = `${input.context.pluginConfig.targetRepo.owner}/${input.context.pluginConfig.targetRepo.name}`
	const supersededFailureLine = input.supersededFailureCommentUrl
		? `Supersedes prior failed attempt: ${input.supersededFailureCommentUrl}${
				input.supersededFailureRunId ? ` (run \`${input.supersededFailureRunId}\`)` : ''
			}.`
		: undefined

	switch (input.outcome) {
		case 'skipped_not_required': {
			return [
				supersededFailureLine,
				supersededFailureLine ? '' : undefined,
				`Port bot skipped this for \`${targetRepo}\`.`,
				'',
				`**Why:** ${input.decision.reason}`,
			]
				.filter(isDefinedLine)
				.join('\n')
		}
		case 'pr_opened': {
			const prLink = input.targetPullRequestUrl ?? `a PR in \`${targetRepo}\``
			const fileCount = input.context.sourceChange.files.length
			const shape = `${String(fileCount)} file${fileCount === 1 ? '' : 's'}`

			return [
				supersededFailureLine,
				supersededFailureLine ? '' : undefined,
				`Ported to ${prLink} (${shape}, validation passed). Ready for review.`,
				'',
				`**Why:** ${input.decision.reason}`,
			]
				.filter(isDefinedLine)
				.join('\n')
		}
		case 'draft_pr_opened': {
			const prLink = input.targetPullRequestUrl
				? `a draft PR: ${input.targetPullRequestUrl}`
				: `a draft PR in \`${targetRepo}\``
			const fileCount = input.context.sourceChange.files.length
			const shape = `${String(fileCount)} file${fileCount === 1 ? '' : 's'}`

			return [
				supersededFailureLine,
				supersededFailureLine ? '' : undefined,
				`Port attempted (${shape}) but validation failed after retries. Opened ${prLink}.`,
				'',
				`**Why:** ${input.decision.reason}`,
			]
				.filter(isDefinedLine)
				.join('\n')
		}
		case 'needs_human': {
			const issueLink = input.followUpIssueUrl
				? `an issue: ${input.followUpIssueUrl}`
				: `an issue in \`${targetRepo}\``

			return [
				supersededFailureLine,
				supersededFailureLine ? '' : undefined,
				`Could not automatically port to \`${targetRepo}\`. Opened ${issueLink} for manual review.`,
				'',
				`**Why:** ${input.decision.reason}`,
			]
				.filter(isDefinedLine)
				.join('\n')
		}
		case 'failed': {
			return [
				`Port to \`${targetRepo}\` failed due to an engine error.`,
				'',
				`**Why:** ${input.decision.reason}`,
				'',
				`Run ID: \`${input.runId}\``,
			].join('\n')
		}
		default: {
			return [
				`Port bot ran for \`${targetRepo}\`.`,
				'',
				`**Why:** ${input.decision.reason}`,
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

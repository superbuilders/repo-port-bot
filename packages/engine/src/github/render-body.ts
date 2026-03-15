import {
	formatTokenCount,
	formatUsd,
	inputOutputTokens,
	sumAggregatedTelemetry,
	sumStageTelemetry,
	toAggregatedTelemetry,
} from '../lib/telemetry.ts'
import { formatDuration, joinNonEmptyLines } from '../utils.ts'

const PORT_BOT_REPO_URL = 'https://github.com/superbuilders/repo-port-bot'

import type {
	AgentSessionEvent,
	AggregatedTelemetry,
	AttemptEvent,
	DecidePortResult,
	DeterministicOperation,
	DeterministicPhaseResult,
	DecisionTrace,
	ExecutePortAttemptResult,
	ExecutePortResult,
	PortContext,
	PortDecision,
	PrFramingMode,
	PortRunOutcome,
	ValidationCommandResult,
} from '../types.ts'

interface RenderPullRequestBodyInput {
	context: PortContext
	decision: PortDecision
	execution?: ExecutePortResult
	validation?: ValidationCommandResult[]
	deterministic?: DeterministicPhaseResult
	framingMode: PrFramingMode
	decisionTrace?: DecisionTrace
	includeCostTelemetry?: boolean
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
	decisionTrace?: DecisionTrace
	execution?: ExecutePortResult
	includeCostTelemetry?: boolean
	runId: string
	supersededFailureCommentUrl?: string
	supersededFailureRunId?: string
}

interface RenderRunSummaryInput {
	outcome: PortRunOutcome
	decision: DecidePortResult
	execution?: ExecutePortResult
	targetPullRequestUrl?: string
	followUpIssueUrl?: string
	errorMessage?: string
}

const SHORT_SHA_LENGTH = 7
const MAX_NEEDS_HUMAN_SOURCE_TITLE_LENGTH = 60
const LOW_SIGNAL_TOOL_NAMES = new Set(['Glob', 'Grep', 'StructuredOutput'])

/**
 * Build the hidden marker used to identify one stable source PR comment per target repo.
 *
 * @param context - Port context.
 * @returns HTML comment marker.
 */
function buildSourceCommentMarker(context: PortContext): string {
	const targetRepo = `${context.pluginConfig.targetRepo.owner}/${context.pluginConfig.targetRepo.name}`

	return `<!-- repo-port-bot:source-comment target=${targetRepo} -->`
}

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
 * Collapse consecutive empty strings so optional absent blocks
 * don't produce extra blank lines when joined.
 *
 * @param lines - Filtered string array (no undefined).
 * @returns Array with at most one consecutive empty string.
 */
function collapseBlankLines(lines: string[]): string[] {
	return lines.filter((line, index) => line !== '' || lines[index - 1] !== '')
}

const GITHUB_BODY_CHAR_LIMIT = 65_536

/**
 * Trim a PR or issue body to fit within GitHub's character limit.
 *
 * Progressive strategy:
 * 1. Trim validation stdout/stderr code blocks to the last few lines
 * 2. Replace Work Log content with a compact summary
 * 3. Strip remaining code blocks from the diagnostics section
 *
 * Structural sections (rationale, summary, headings) are never touched.
 *
 * @param body - Rendered markdown body.
 * @returns Body guaranteed to fit within GitHub's limit.
 */
export function truncateBody(body: string): string {
	if (body.length <= GITHUB_BODY_CHAR_LIMIT) {
		return body
	}

	let result = trimValidationCodeBlocks(body)

	if (result.length <= GITHUB_BODY_CHAR_LIMIT) {
		return result
	}

	result = trimWorkLog(result)

	if (result.length <= GITHUB_BODY_CHAR_LIMIT) {
		return result
	}

	result = trimDiagnosticsCodeBlocks(result)

	if (result.length <= GITHUB_BODY_CHAR_LIMIT) {
		return result
	}

	const ELLIPSIS_SUFFIX = '\n...'

	return `${result.slice(0, GITHUB_BODY_CHAR_LIMIT - ELLIPSIS_SUFFIX.length)}${ELLIPSIS_SUFFIX}`
}

const VALIDATION_OUTPUT_TAIL_LINES = 10

/**
 * @param body - PR body.
 * @returns Body with validation code blocks trimmed to last N lines.
 */
function trimValidationCodeBlocks(body: string): string {
	return body.replaceAll(
		/(- \[(?:PASS|FAIL)\] `.+`[^\n]*\n)\n```\n([\s\S]*?)\n```/gu,
		(_match, header: string, content: string) => {
			const lines = content.split('\n')

			if (lines.length <= VALIDATION_OUTPUT_TAIL_LINES) {
				return `${header}\n\`\`\`\n${content}\n\`\`\``
			}

			const kept = lines.slice(-VALIDATION_OUTPUT_TAIL_LINES).join('\n')
			const trimmedCount = lines.length - VALIDATION_OUTPUT_TAIL_LINES

			return `${header}\n\`\`\`\n(${String(trimmedCount)} lines trimmed)\n${kept}\n\`\`\``
		},
	)
}

/**
 * @param body - PR body.
 * @returns Body with Work Log details content replaced by a compact note.
 */
function trimWorkLog(body: string): string {
	return body.replace(
		/(<details><summary>Work Log<\/summary>)\n[\s\S]*?\n(<\/details>)/u,
		'$1\n\n_Work log trimmed to fit GitHub body limit._\n\n$2',
	)
}

/**
 * @param body - PR body.
 * @returns Body with code blocks inside the diagnostics section stripped.
 */
function trimDiagnosticsCodeBlocks(body: string): string {
	const diagnosticsStart = body.indexOf('Validation & diagnostics')

	if (diagnosticsStart === -1) {
		return body
	}

	const diagnosticsEnd = body.indexOf('</details>', diagnosticsStart)

	if (diagnosticsEnd === -1) {
		return body
	}

	const before = body.slice(0, diagnosticsStart)
	const section = body.slice(diagnosticsStart, diagnosticsEnd)
	const after = body.slice(diagnosticsEnd)

	const trimmed = section.replaceAll(/\n```\n[\s\S]*?```/gu, '\n_(output trimmed)_')

	return before + trimmed + after
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
 * @param framingMode - Optional framing mode to append a tag suffix.
 * @returns Title in the canonical format.
 */
export function renderPortPullRequestTitle(
	context: PortContext,
	framingMode?: PrFramingMode,
): string {
	const sourcePullRequest = context.sourceChange.pullRequest
	const base = sourcePullRequest
		? `Port: ${sourcePullRequest.title}`
		: `Port: source change (${context.sourceChange.mergedCommitSha.slice(0, SHORT_SHA_LENGTH)})`
	const tag = framingModeTag(framingMode)

	return tag ? `${base} ${tag}` : base
}

/**
 * @param mode - PR framing mode.
 * @returns Short tag suffix for the PR title, or undefined for no tag.
 */
function framingModeTag(mode?: PrFramingMode): string | undefined {
	switch (mode) {
		case 'deterministic_only': {
			return '[sync only]'
		}
		case 'residual_handoff': {
			return '[needs review]'
		}
		case 'agent_stalled': {
			return '[stalled]'
		}
		default: {
			return undefined
		}
	}
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
	const headerLine = `- ${status} \`${result.command}\`${exitCodeSuffix}`
	const output = [result.stdout, result.stderr]
		.map(s => s.trim())
		.filter(Boolean)
		.join('\n')

	if (output.length === 0) {
		return headerLine
	}

	return `${headerLine}\n\n\`\`\`\n${output}\n\`\`\``
}

/**
 * Render a markdown summary of the latest validation attempt.
 *
 * @param execution - Execution details from the execution stage.
 * @returns Validation summary section.
 */
function renderValidationSummary(execution: ExecutePortResult): string {
	const latestAttempt = execution.trace.attempts.at(-1)

	if (!latestAttempt || latestAttempt.validation.length === 0) {
		return '- No validation output recorded.'
	}

	return latestAttempt.validation.map(renderValidationLine).join('\n')
}

/**
 * Render markdown summary lines for explicit validation results.
 *
 * @param validation - Validation command results.
 * @returns Validation summary section.
 */
function renderValidationSummaryFromResults(validation?: ValidationCommandResult[]): string {
	if (!validation || validation.length === 0) {
		return '- No validation output recorded.'
	}

	return validation.map(renderValidationLine).join('\n')
}

/**
 * Render the collapsible validation & diagnostics block.
 *
 * @param execution - Execution details.
 * @returns HTML details block with validation results.
 */
function renderDiagnosticsBlock(execution: ExecutePortResult): string {
	const validationLines = renderValidationSummary(execution)
	const failureLine =
		execution.outcome.status !== 'SUCCEEDED'
			? `- Final status: validation failed after retries.\n- Failure reason: ${execution.outcome.reason ?? 'Unknown failure reason.'}`
			: undefined
	const detailsTag = execution.outcome.status === 'SUCCEEDED' ? '<details>' : '<details open>'

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
 * Render diagnostics block from pre-computed validation results.
 *
 * @param validation - Validation command results.
 * @returns Collapsible diagnostics block.
 */
function renderDiagnosticsBlockFromValidation(validation?: ValidationCommandResult[]): string {
	const validationLines = renderValidationSummaryFromResults(validation)
	const hasFailure = (validation ?? []).some(result => !result.ok)
	const detailsTag = hasFailure ? '<details open>' : '<details>'
	const failureLine = hasFailure
		? '- Final status: validation failed.\n- Failure reason: One or more validation commands failed.'
		: undefined

	return [
		detailsTag,
		'<summary>Validation & diagnostics</summary>',
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
 * Render deterministic operations grouped by kind and mode.
 *
 * @param operations - Deterministic operations list.
 * @returns Grouped markdown.
 */
function renderDeterministicOperations(operations: DeterministicOperation[]): string {
	if (operations.length === 0) {
		return '_No deterministic operations were recorded._'
	}

	const blocks: string[] = []

	const syncOperations = operations.filter(
		(operation): operation is DeterministicOperation & { kind: 'sync' } =>
			operation.kind === 'sync',
	)

	if (syncOperations.length > 0) {
		const mirrored = syncOperations.filter(operation => operation.mode === 'mirror')
		const copied = syncOperations.filter(operation => operation.mode === 'copy')

		if (mirrored.length > 0) {
			blocks.push(
				'Mirrored:',
				'',
				...mirrored.map(
					operation => `- \`${operation.source}\` -> \`${operation.target}\``,
				),
			)
		}

		if (copied.length > 0) {
			if (blocks.length > 0) {
				blocks.push('')
			}

			blocks.push(
				'Copied:',
				'',
				...copied.map(operation => `- \`${operation.source}\` -> \`${operation.target}\``),
			)
		}
	}

	return blocks.length > 0 ? blocks.join('\n') : '_No deterministic operations were recorded._'
}

/**
 * Render deterministic operations as a collapsed details block.
 *
 * @param deterministic - Deterministic phase result.
 * @returns Collapsed details block, or undefined when no operations ran.
 */
function renderDeterministicBaseline(
	deterministic: DeterministicPhaseResult | undefined,
): string | undefined {
	if (!deterministic?.changed || deterministic.operations.length === 0) {
		return undefined
	}

	const count = deterministic.operations.length
	const label = `Deterministic baseline (${String(count)} operation${count === 1 ? '' : 's'})`

	return [
		`<details><summary>${label}</summary>`,
		'',
		renderDeterministicOperations(deterministic.operations),
		'',
		'</details>',
	].join('\n')
}

/**
 * Render deterministic phase work log.
 *
 * @param deterministic - Deterministic phase result.
 * @returns Work log details block.
 */
function renderDeterministicWorkLog(deterministic?: DeterministicPhaseResult): string {
	const touchedFiles = deterministic?.touchedFiles ?? []
	const touchedFileLines =
		touchedFiles.length === 0
			? ['- No target files were modified by deterministic operations.']
			: touchedFiles.map(filePath => `- Updated \`${filePath}\``)

	return [
		'<details><summary>Work Log</summary>',
		'',
		'- Deterministic operations were applied by the engine.',
		...touchedFileLines,
		'',
		'</details>',
	].join('\n')
}

/**
 * Render the reviewer-facing execution summary parts for the PR body.
 *
 * @param execution - Execution details.
 * @returns Summary overview plus optional per-file details.
 */
function renderAttemptSummaryParts(execution: ExecutePortResult): {
	details?: string
	summary: string
} {
	const structuredSummary = execution.summary

	if (structuredSummary) {
		const summaryText = structuredSummary.text.trim()
		const fileLines = structuredSummary.files.map(
			file => `- \`${file.path}\`: ${file.description}`,
		)

		return {
			summary: summaryText.length > 0 ? summaryText : '_No notes recorded._',
			details: fileLines.length > 0 ? fileLines.join('\n') : undefined,
		}
	}

	if (execution.trace.attempts.length === 0) {
		return { summary: '_No notes recorded._' }
	}

	const lastAttempt = execution.trace.attempts.at(-1)
	const notes = lastAttempt?.trace.notes?.trim() || '_No notes recorded._'

	return { summary: notes }
}

/**
 * Render a list of agent session events as humanized markdown blocks.
 *
 * Groups consecutive tool events into fenced code blocks and wraps
 * assistant notes in italics, separated by blank lines.
 *
 * @param events - Ordered agent session events.
 * @param options - Rendering options.
 * @param options.stripLastAssistantNote - Drop the final assistant note when it duplicates surrounding context.
 * @returns Markdown string for the event sequence.
 */
function renderEventBlocks(
	events: AgentSessionEvent[],
	options: { stripLastAssistantNote?: boolean } = {},
): string {
	const toolDurations = new Map<string, number | undefined>()

	for (const event of events) {
		if (event.kind === 'tool_end') {
			toolDurations.set(event.toolUseId, event.durationMs)
		}
	}

	type Block = { kind: 'assistant'; text: string } | { kind: 'tool'; lines: string[] }

	const blocks: Block[] = []

	for (const event of events) {
		if (event.kind === 'tool_end') {
			// skip: duration already captured in toolDurations map
		} else if (event.kind === 'assistant_note') {
			const text = event.text.trim()

			if (text.length > 0) {
				blocks.push({ kind: 'assistant', text })
			}
		} else {
			const toolLine = summarizeToolStartEvent(event, toolDurations.get(event.toolUseId))

			if (toolLine) {
				const lastBlock = blocks.at(-1)

				if (lastBlock?.kind === 'tool') {
					lastBlock.lines.push(toolLine)
				} else {
					blocks.push({ kind: 'tool', lines: [toolLine] })
				}
			}
		}
	}

	if (options.stripLastAssistantNote && blocks.at(-1)?.kind === 'assistant') {
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

	return rendered.join('\n\n')
}

/**
 * Render one execution attempt's humanized work-log.
 *
 * @param attempt - Attempt details.
 * @param stripLastAssistantNote - When true, drop the final assistant note.
 * @returns Markdown string for this attempt's work log.
 */
function renderAttemptWorkLogBody(
	attempt: ExecutePortAttemptResult,
	stripLastAssistantNote: boolean,
): string {
	return renderEventBlocks(attempt.trace.events, { stripLastAssistantNote })
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
 * Build humanized per-attempt work log sections from execution trace.
 *
 * @param execution - Execution details.
 * @returns Array of rendered attempt sections.
 */
function buildAttemptSections(execution: ExecutePortResult): string[] {
	const lastAttemptNumber = execution.trace.attempts.at(-1)?.attempt

	return execution.trace.attempts.map(attempt => {
		const isLastAttempt = attempt.attempt === lastAttemptNumber
		const body = renderAttemptWorkLogBody(attempt, isLastAttempt)

		return execution.trace.attempts.length > 1
			? [`### Attempt ${String(attempt.attempt)}`, '', body].join('\n')
			: body
	})
}

/**
 * Render a collapsed, humanized work log section.
 *
 * @param execution - Execution details.
 * @returns HTML details block with per-attempt narrative.
 */
function renderAgentWorkLog(execution: ExecutePortResult): string {
	const attemptSections = buildAttemptSections(execution)

	return ['<details><summary>Work Log</summary>', '', ...attemptSections, '', '</details>'].join(
		'\n\n',
	)
}

/**
 * Render compact model + execution metrics attribution for the port result.
 *
 * @param execution - Execution details.
 * @returns Attribution line.
 */
function renderExecutionAttribution(execution: ExecutePortResult): string {
	if (execution.trace.model) {
		const modelUrl = `https://models.dev/?search=${encodeURIComponent(execution.trace.model)}`

		return `${renderExecutionSentencePrefix(execution)} by [${execution.trace.model}](${modelUrl}) ${renderExecutionSentenceSuffix(execution)}`
	}

	return `${renderExecutionSentencePrefix(execution)} ${renderExecutionSentenceSuffix(execution)}`
}

/**
 * Render a natural-language execution metrics prefix.
 *
 * @param execution - Execution details.
 * @returns Sentence prefix.
 */
function renderExecutionSentencePrefix(execution: ExecutePortResult): string {
	const fileCount = execution.outcome.touchedFiles.length
	const durationPhrase =
		execution.trace.durationMs !== undefined
			? ` over ${formatDuration(execution.trace.durationMs)}`
			: ''

	return `This port updated ${String(fileCount)} file${fileCount === 1 ? '' : 's'}${durationPhrase} and was completed`
}

/**
 * Render a natural-language execution metrics suffix.
 *
 * @param execution - Execution details.
 * @returns Sentence fragment.
 */
function renderExecutionSentenceSuffix(execution: ExecutePortResult): string {
	const attemptCount = execution.outcome.attempts
	const toolCallCount = execution.trace.attempts.reduce(
		(count, attempt) => count + attempt.trace.toolCallLog.length,
		0,
	)
	const attemptPhrase =
		attemptCount === 1 ? 'a single attempt' : `${String(attemptCount)} attempts`

	return `in ${attemptPhrase}, using ${String(toolCallCount)} tool call${toolCallCount === 1 ? '' : 's'}.`
}

/**
 * Render the collapsible cost/token telemetry block shared across PR surfaces.
 *
 * @param input - Decision/execution trace input.
 * @param input.decisionTrace - Decision stage trace.
 * @param input.execution - Optional execution result.
 * @returns Details block markdown or undefined when telemetry is unavailable.
 */
function renderCostTelemetryDetails(input: {
	decisionTrace?: DecisionTrace
	execution?: ExecutePortResult
}): string | undefined {
	const telemetry = aggregateTelemetry(input.decisionTrace, input.execution)

	if (!telemetry.decision) {
		return undefined
	}

	const lines = [
		'<details><summary>Cost & Tokens</summary>',
		'',
		`- Decision: ${formatTelemetryLine(telemetry.decision)}`,
	]

	if (telemetry.execution) {
		const attemptCount = input.execution?.outcome.attempts ?? 0
		const attemptSuffix = ` across ${String(attemptCount)} attempt${attemptCount === 1 ? '' : 's'}`

		lines.push(`- Execution: ${formatTelemetryLine(telemetry.execution)}${attemptSuffix}`)
		lines.push(`- Total: ${formatTelemetryLine(telemetry.total ?? telemetry.execution)}`)
	}

	lines.push('', '</details>')

	return lines.join('\n')
}

/**
 * Aggregate decision + execution telemetry for rendering.
 *
 * @param decisionTrace - Decision stage trace.
 * @param execution - Optional execution result.
 * @returns Aggregated telemetry buckets.
 */
function aggregateTelemetry(
	decisionTrace: DecisionTrace | undefined,
	execution?: ExecutePortResult,
): {
	decision?: AggregatedTelemetry
	execution?: AggregatedTelemetry
	total?: AggregatedTelemetry
} {
	const decisionTelemetry = toAggregatedTelemetry(decisionTrace?.costUsd, decisionTrace?.usage)
	const executionTelemetry = execution
		? sumStageTelemetry(execution.trace.attempts.map(attempt => attempt.trace))
		: undefined
	const totalTelemetry = sumAggregatedTelemetry(decisionTelemetry, executionTelemetry)

	return {
		decision: decisionTelemetry,
		execution: executionTelemetry,
		total: totalTelemetry,
	}
}

/**
 * Render one line of telemetry as cost + input/output token total.
 *
 * @param telemetry - Aggregated telemetry.
 * @returns Human-readable telemetry text.
 */
function formatTelemetryLine(telemetry: AggregatedTelemetry): string {
	return `${formatUsd(telemetry.costUsd)}, ${formatTokenCount(inputOutputTokens(telemetry.usage))} input/output tokens`
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
	const deterministic = input.deterministic ?? input.context.deterministic
	const telemetryBlock =
		input.includeCostTelemetry === false
			? undefined
			: renderCostTelemetryDetails({
					decisionTrace: input.decisionTrace,
					execution: input.execution,
				})

	if (input.framingMode === 'deterministic_only') {
		return [
			'## Port rationale',
			'',
			'_This port was completed through deterministic operations only._',
			'',
			`> ${input.decision.reason}`,
			'',
			telemetryBlock,
			'',
			'## What changed',
			'',
			renderDeterministicOperations(deterministic?.operations ?? []),
			'',
			renderDeterministicWorkLog(deterministic),
			'',
			renderDiagnosticsBlockFromValidation(input.validation),
			'',
			'---',
			`Ported by: [Repo Port Bot](${PORT_BOT_REPO_URL})`,
		]
			.filter(isDefinedLine)
			.join('\n')
	}

	if (input.framingMode === 'residual_handoff') {
		return [
			'## Port rationale',
			'',
			'Deterministic operations produced safe side-effects, but the remaining port requires human judgment after the agent was unable to complete it confidently.',
			'',
			`> ${input.decision.reason}`,
			'',
			telemetryBlock,
			'',
			'## What is already done',
			'',
			renderDeterministicOperations(deterministic?.operations ?? []),
			'',
			'## What still needs human review',
			'',
			'- Review residual behavior not covered by deterministic operations.',
			`- Source context: ${input.context.sourceChange.pullRequest?.url ?? `\`${input.context.sourceChange.mergedCommitSha}\``}`,
			'',
			renderDeterministicWorkLog(deterministic),
			'',
			renderDiagnosticsBlockFromValidation(input.validation),
			'',
			'---',
			`Ported by: [Repo Port Bot](${PORT_BOT_REPO_URL})`,
		]
			.filter(isDefinedLine)
			.join('\n')
	}

	if (!input.execution) {
		throw new Error('Execution result is required for agent PR framing modes.')
	}

	const sourcePullRequest = input.context.sourceChange.pullRequest
	const sourceRepo = `${input.context.sourceRepo.owner}/${input.context.sourceRepo.name}`
	const sourceRepoUrl = `https://github.com/${sourceRepo}`
	const sourceRepoLink = `[\`${sourceRepo}\`](${sourceRepoUrl})`
	const authorMention = sourcePullRequest?.author
		? ` (originally authored by @${sourcePullRequest.author})`
		: ''
	const sourceNarrativePrefix = sourcePullRequest
		? `Ported from [${sourcePullRequest.title}](${sourcePullRequest.url})${authorMention} in ${sourceRepoLink}.`
		: `Ported from commit \`${input.context.sourceChange.mergedCommitSha}\` in ${sourceRepoLink}.`
	const summaryParts = renderAttemptSummaryParts(input.execution)
	const reasonBlockquote = input.decision.reason
		.split('\n')
		.map(line => `> ${line}`)
		.join('\n')
	const executionAttribution = renderExecutionAttribution(input.execution)
	const sourceNarrative = `${sourceNarrativePrefix} ${executionAttribution}`

	const noValidationConfigured = input.context.pluginConfig.validationCommands.length === 0

	const diagnosticsBlock = noValidationConfigured
		? undefined
		: renderDiagnosticsBlock(input.execution)
	const agentWorkLog = renderAgentWorkLog(input.execution)
	const baselineBlock = renderDeterministicBaseline(deterministic) ?? ''

	const lines = [
		'## Port rationale',
		'',
		reasonBlockquote,
		'',
		sourceNarrative,
		'',
		telemetryBlock,
		'',
		'## What was ported',
		'',
		summaryParts.summary,
		summaryParts.details,
		'',
		baselineBlock,
		'',
		agentWorkLog,
		'',
		diagnosticsBlock,
		'',
		'---',
		`Ported by: [Repo Port Bot](${PORT_BOT_REPO_URL})`,
	]

	return collapseBlankLines(lines.filter(isDefinedLine)).join('\n')
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
	const authorMention = sourcePullRequest?.author
		? ` (originally authored by @${sourcePullRequest.author})`
		: ''
	const openingSentence = sourcePullRequest
		? `[${sourcePullRequest.title}](${sourcePullRequest.url})${authorMention} was merged in \`${sourceRepo}\` but could not be automatically ported.`
		: `Commit \`${input.context.sourceChange.mergedCommitSha}\` was pushed to \`${sourceRepo}\` but could not be automatically ported.`
	const fileCount = String(input.context.sourceChange.files.length)

	return [
		openingSentence,
		'',
		`**Why:** ${input.decision.reason}`,
		'',
		`**Changed files:** ${fileCount}`,
		'',
		'---',
		sourcePullRequest ? `Source-PR: ${sourcePullRequest.url}` : undefined,
		`Source-Commit: ${input.context.sourceChange.mergedCommitSha}`,
	]
		.filter(isDefinedLine)
		.join('\n')
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
	const supersededNote = input.supersededFailureCommentUrl
		? `> [!NOTE]\n> Supersedes [prior attempt](${input.supersededFailureCommentUrl})${
				input.supersededFailureRunId ? ` (run \`${input.supersededFailureRunId}\`)` : ''
			}.`
		: undefined

	/**
	 * @param summary - Collapsible summary label.
	 * @returns Blockquote-nested details markdown.
	 */
	function buildReasonDetails(summary: string): string {
		return [
			`<details><summary>${summary}</summary>`,
			'',
			input.decision.reason,
			'',
			'</details>',
		].join('\n')
	}

	const telemetryBlock =
		input.includeCostTelemetry === false
			? undefined
			: renderCostTelemetryDetails({
					decisionTrace: input.decisionTrace,
					execution: input.execution,
				})

	switch (input.outcome) {
		case 'skipped_not_required': {
			return [
				buildSourceCommentMarker(input.context),
				'',
				supersededNote,
				supersededNote ? '' : undefined,
				`Port bot skipped this for \`${targetRepo}\`.`,
				'',
				buildReasonDetails('Why was this skipped?'),
				'',
				telemetryBlock,
			]
				.filter(isDefinedLine)
				.join('\n')
		}
		case 'pr_opened': {
			const prLink = input.targetPullRequestUrl ?? `a PR in \`${targetRepo}\``
			const fileCount = input.context.sourceChange.files.length
			const shape = `${String(fileCount)} file${fileCount === 1 ? '' : 's'}`

			if (input.decision.kind === 'NEEDS_HUMAN') {
				return [
					buildSourceCommentMarker(input.context),
					'',
					supersededNote,
					supersededNote ? '' : undefined,
					`Deterministic changes were delivered to ${prLink} (${shape}), but residual work still needs human review.`,
					'',
					buildReasonDetails('What still needs review?'),
					'',
					telemetryBlock,
				]
					.filter(isDefinedLine)
					.join('\n')
			}

			return [
				buildSourceCommentMarker(input.context),
				'',
				supersededNote,
				supersededNote ? '' : undefined,
				`Ported to ${prLink} (${shape}, validation passed).`,
				'',
				`<details><summary>Why was this ported?</summary>`,
				'',
				input.decision.reason,
				'',
				'</details>',
				'',
				telemetryBlock,
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

			if (input.decision.kind === 'NEEDS_HUMAN') {
				return [
					buildSourceCommentMarker(input.context),
					'',
					supersededNote,
					supersededNote ? '' : undefined,
					`Deterministic changes were prepared (${shape}), but validation failed. Opened ${prLink}, and residual work still needs human review.`,
					'',
					buildReasonDetails('What still needs review?'),
					'',
					telemetryBlock,
				]
					.filter(isDefinedLine)
					.join('\n')
			}

			return [
				buildSourceCommentMarker(input.context),
				'',
				supersededNote,
				supersededNote ? '' : undefined,
				`Port attempted (${shape}) but validation failed after retries. Opened ${prLink}.`,
				'',
				buildReasonDetails('Why was this ported?'),
				'',
				telemetryBlock,
			]
				.filter(isDefinedLine)
				.join('\n')
		}
		case 'needs_human': {
			if (input.targetPullRequestUrl) {
				return [
					buildSourceCommentMarker(input.context),
					'',
					supersededNote,
					supersededNote ? '' : undefined,
					`Deterministic changes were delivered to ${input.targetPullRequestUrl}, but residual work still needs human review.`,
					'',
					buildReasonDetails('What still needs review?'),
					'',
					telemetryBlock,
				]
					.filter(isDefinedLine)
					.join('\n')
			}

			const issueLink = input.followUpIssueUrl
				? `an issue: ${input.followUpIssueUrl}`
				: `an issue in \`${targetRepo}\``

			return [
				buildSourceCommentMarker(input.context),
				'',
				supersededNote,
				supersededNote ? '' : undefined,
				`Could not automatically port to \`${targetRepo}\`. Opened ${issueLink} for manual review.`,
				'',
				buildReasonDetails('Why does this need review?'),
				'',
				telemetryBlock,
			]
				.filter(isDefinedLine)
				.join('\n')
		}
		case 'failed': {
			return [
				buildSourceCommentMarker(input.context),
				'',
				`Port to \`${targetRepo}\` failed due to an engine error. Run ID: \`${input.runId}\``,
				'',
				buildReasonDetails('What went wrong?'),
			].join('\n')
		}
		default: {
			return [
				buildSourceCommentMarker(input.context),
				'',
				`Port bot ran for \`${targetRepo}\`.`,
				'',
				buildReasonDetails('Details'),
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
			return `Skipped: ${decision.outcome.reason}`
		}
		case 'needs_human': {
			return (
				joinNonEmptyLines(
					[
						`Needs human review: ${decision.outcome.reason}`,
						followUpIssueUrl && `Issue: ${followUpIssueUrl}`,
					],
					' ',
				) ?? `Needs human review: ${decision.outcome.reason}`
			)
		}
		case 'pr_opened': {
			return (
				joinNonEmptyLines(
					[
						targetPullRequestUrl && `Port PR opened: ${targetPullRequestUrl}`,
						execution && `(${String(execution.outcome.attempts)} attempts)`,
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
						execution?.outcome.reason,
					],
					' ',
				) ?? 'Draft PR opened (stalled).'
			)
		}
		case 'failed': {
			return `Engine failure: ${input.errorMessage ?? decision.outcome.reason}`
		}
		default: {
			return 'Port run completed.'
		}
	}
}

/**
 * Render the decision event log body for the action job summary.
 *
 * Only produces output when the decision came from the LLM classifier.
 * Heuristic/fallback decisions return `undefined`.
 *
 * @param trace - Decision trace from the run result.
 * @returns Humanized event markdown or undefined.
 */
export function renderDecisionLogSummary(trace: DecisionTrace): string | undefined {
	if (trace.source !== 'classifier' || trace.events.length === 0) {
		return undefined
	}

	return renderEventBlocks(trace.events)
}

/**
 * Render the execution event log body for the action job summary.
 *
 * @param execution - Execution result from the run.
 * @returns Humanized event markdown or undefined when no execution happened.
 */
export function renderExecutionLogSummary(execution: ExecutePortResult): string | undefined {
	if (execution.trace.attempts.length === 0) {
		return undefined
	}

	return buildAttemptSections(execution).join('\n\n')
}

import { query } from '@anthropic-ai/claude-agent-sdk'

import {
	buildDecideSystemPrompt,
	buildDecideUserPrompt,
	buildSystemPrompt,
	buildUserPrompt,
} from './build-prompt.ts'

import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type {
	AgentInput,
	AgentOutput,
	AgentMessage,
	AgentProvider,
	AttemptEvent,
	DecidePortInput,
	DecidePortOutput,
	ToolCallEntry,
} from '@repo-port-bot/engine'

import type { ClaudeProviderOptions, QueryFn } from './types.ts'

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_MAX_TURNS = 50
const EDIT_TOOL = 'Edit'
const WRITE_TOOL = 'Write'
const FILE_PATH_KEY = 'file_path'
const DECIDE_MAX_TURNS = 8
const DECIDE_MAX_BUDGET_USD = 0.5

const DECIDE_PORT_OUTPUT_FORMAT = {
	type: 'json_schema' as const,
	schema: {
		type: 'object',
		properties: {
			required: { type: 'boolean' },
			reason: { type: 'string' },
		},
		required: ['required', 'reason'],
	},
}

/**
 * Agent provider implementation backed by the Claude Agent SDK.
 */
export class ClaudeAgentProvider implements AgentProvider {
	private readonly options: ClaudeProviderOptions
	private readonly queryFn: QueryFn

	/**
	 * Create a new Claude-backed provider.
	 *
	 * @param options - Provider options.
	 */
	public constructor(options: ClaudeProviderOptions = {}) {
		this.options = options
		this.queryFn = options.queryFn ?? (query as QueryFn)
	}

	/**
	 * Decide whether the source change requires a port.
	 *
	 * @param input - Decision input from the engine decision stage.
	 * @returns Structured classifier response.
	 */
	public async decidePort(input: DecidePortInput): Promise<DecidePortOutput> {
		const onMessage = input.onMessage
		const systemPrompt = buildDecideSystemPrompt({
			pluginConfig: input.pluginConfig,
			sourceWorkingDirectory: input.sourceWorkingDirectory,
			diffFilePath: input.diffFilePath,
		})
		const userPrompt = buildDecideUserPrompt(input)
		let resultMessage: SDKResultMessage | undefined = undefined

		const queryOptions: Options = {
			cwd: input.targetWorkingDirectory,
			systemPrompt,
			model: this.options.model ?? DEFAULT_MODEL,
			maxTurns: Math.min(this.options.maxTurns ?? DEFAULT_MAX_TURNS, DECIDE_MAX_TURNS),
			maxBudgetUsd: Math.min(
				this.options.maxBudgetUsd ?? DECIDE_MAX_BUDGET_USD,
				DECIDE_MAX_BUDGET_USD,
			),
			allowedTools: ['Read', 'Glob', 'Grep'],
			tools: ['Read', 'Glob', 'Grep'],
			outputFormat: DECIDE_PORT_OUTPUT_FORMAT,
			permissionMode: 'bypassPermissions',
			allowDangerouslySkipPermissions: true,
			env: this.options.apiKey
				? { ...process.env, ANTHROPIC_API_KEY: this.options.apiKey }
				: undefined,
		}

		for await (const message of this.queryFn({ prompt: userPrompt, options: queryOptions })) {
			if (message.type === 'assistant') {
				emitAssistantMessages(message, onMessage)
			} else if (message.type === 'result') {
				resultMessage = message
			}
		}

		if (!resultMessage) {
			throw new Error('Claude provider finished without a result message.')
		}

		return readStructuredDecideOutput(resultMessage)
	}

	/**
	 * Execute a single edit attempt in the target repository.
	 *
	 * @param input - Agent input from the execution orchestrator.
	 * @returns Agent output with touched files and tool-call observability.
	 */
	public async executePort(input: AgentInput): Promise<AgentOutput> {
		const touchedFiles = new Set<string>()
		const toolCallLog: ToolCallEntry[] = []
		const events: AttemptEvent[] = []
		const assistantNotes: string[] = []
		const startTimesByToolUseId = new Map<string, number>()
		const onMessage = input.onMessage
		const systemPrompt = buildSystemPrompt({
			pluginConfig: input.pluginConfig,
			sourceWorkingDirectory: input.sourceWorkingDirectory,
			diffFilePath: input.diffFilePath,
		})
		const userPrompt = buildUserPrompt(input)
		let resultMessage: SDKResultMessage | undefined = undefined

		const queryOptions: Options = {
			cwd: input.targetWorkingDirectory,
			systemPrompt,
			model: this.options.model ?? DEFAULT_MODEL,
			maxTurns: this.options.maxTurns ?? DEFAULT_MAX_TURNS,
			maxBudgetUsd: this.options.maxBudgetUsd,
			allowedTools: ['Read', EDIT_TOOL, WRITE_TOOL, 'Glob', 'Grep', 'Bash'],
			tools: ['Read', EDIT_TOOL, WRITE_TOOL, 'Glob', 'Grep', 'Bash'],
			permissionMode: 'bypassPermissions',
			allowDangerouslySkipPermissions: true,
			env: this.options.apiKey
				? { ...process.env, ANTHROPIC_API_KEY: this.options.apiKey }
				: undefined,
			hooks: {
				PreToolUse: [
					{
						hooks: [
							async hookInput => {
								if (hookInput.hook_event_name !== 'PreToolUse') {
									return {}
								}

								startTimesByToolUseId.set(hookInput.tool_use_id, Date.now())

								const toolInput = normalizeToolInputForEvent(
									hookInput.tool_input,
									input.targetWorkingDirectory,
								)

								events.push({
									kind: 'tool_start',
									toolName: hookInput.tool_name,
									toolUseId: hookInput.tool_use_id,
									toolInput,
								})
								onMessage?.({
									kind: 'tool_start',
									toolName: hookInput.tool_name,
									toolInput,
								})

								return {}
							},
						],
					},
				],
				PostToolUse: [
					{
						hooks: [
							async hookInput => {
								if (hookInput.hook_event_name !== 'PostToolUse') {
									return {}
								}

								const durationMs = getDurationMs(
									startTimesByToolUseId.get(hookInput.tool_use_id),
								)

								toolCallLog.push({
									toolName: hookInput.tool_name,
									input: hookInput.tool_input,
									output: hookInput.tool_response,
									durationMs,
								})
								events.push({
									kind: 'tool_end',
									toolName: hookInput.tool_name,
									toolUseId: hookInput.tool_use_id,
									durationMs,
								})
								onMessage?.({
									kind: 'tool_end',
									toolName: hookInput.tool_name,
									durationMs,
								})

								if (
									hookInput.tool_name === EDIT_TOOL ||
									hookInput.tool_name === WRITE_TOOL
								) {
									const touchedPath = readTouchedFilePath(
										hookInput.tool_input,
										input.targetWorkingDirectory,
									)

									if (touchedPath) {
										touchedFiles.add(touchedPath)
									}
								}

								return {}
							},
						],
					},
				],
			},
		}

		for await (const message of this.queryFn({ prompt: userPrompt, options: queryOptions })) {
			if (message.type === 'assistant') {
				emitAssistantMessages(message, onMessage)

				const textBlocks = extractAssistantText(message)

				if (textBlocks.length > 0) {
					for (const textBlock of textBlocks) {
						if (textBlock.trim().length > 0) {
							events.push({
								kind: 'assistant_note',
								text: textBlock.trim(),
							})
						}
					}

					assistantNotes.length = 0
					assistantNotes.push(...textBlocks)
				}
			} else if (message.type === 'result') {
				resultMessage = message
			}
		}

		if (!resultMessage) {
			throw new Error('Claude provider finished without a result message.')
		}

		const resultNotes =
			resultMessage.subtype === 'success' ? undefined : resultMessage.errors.join('\n')
		const notes = joinNonEmptyLines([
			assistantNotes.length === 0 ? undefined : assistantNotes.join('\n'),
			resultNotes,
		])

		return {
			touchedFiles: [...touchedFiles],
			complete: resultMessage.subtype === 'success',
			notes,
			toolCallLog,
			events,
			model: this.options.model ?? DEFAULT_MODEL,
		}
	}
}

/**
 * Extract plain-text assistant blocks from one SDK assistant message.
 *
 * @param message - SDK message.
 * @returns Text blocks from the assistant.
 */
function extractAssistantText(message: Extract<SDKMessage, { type: 'assistant' }>): string[] {
	const lines: string[] = []

	for (const block of message.message.content) {
		if (block.type === 'text') {
			lines.push(block.text)
		}
	}

	return lines
}

/**
 * Emit streamable assistant message blocks for observability.
 *
 * @param message - SDK assistant message.
 * @param onMessage - Optional callback for message emission.
 */
function emitAssistantMessages(
	message: Extract<SDKMessage, { type: 'assistant' }>,
	onMessage: ((message: AgentMessage) => void) | undefined,
): void {
	if (!onMessage) {
		return
	}

	for (const block of message.message.content) {
		if (block.type === 'text') {
			onMessage({
				kind: 'text',
				text: block.text,
			})
		} else if (block.type === 'thinking') {
			onMessage({
				kind: 'thinking',
				text: block.thinking,
			})
		}
	}
}

/**
 * Read touched file path from a tool input payload.
 *
 * @param toolInput - Tool input payload.
 * @param targetWorkingDirectory - Target repository root directory.
 * @returns Relative file path or undefined.
 */
function readTouchedFilePath(
	toolInput: unknown,
	targetWorkingDirectory: string,
): string | undefined {
	if (!toolInput || typeof toolInput !== 'object') {
		return undefined
	}

	const rawPath = (toolInput as Record<string, unknown>)[FILE_PATH_KEY]

	if (typeof rawPath !== 'string' || rawPath.length === 0) {
		return undefined
	}

	return normalizeToTargetRelativePath(rawPath, targetWorkingDirectory)
}

/**
 * Normalize a file path to be repository-relative when possible.
 *
 * @param filePath - Raw file path from tool input.
 * @param targetWorkingDirectory - Target repository root.
 * @returns Repository-relative path when inside target dir, else original.
 */
function normalizeToTargetRelativePath(filePath: string, targetWorkingDirectory: string): string {
	if (!filePath.startsWith(targetWorkingDirectory)) {
		return filePath
	}

	const relative = filePath.slice(targetWorkingDirectory.length).replace(/^\/+/, '')

	return relative.length > 0 ? relative : filePath
}

/**
 * Compute tool call duration from a recorded start timestamp.
 *
 * @param startedAtMs - Start timestamp.
 * @returns Duration in milliseconds when available.
 */
function getDurationMs(startedAtMs: number | undefined): number | undefined {
	if (startedAtMs === undefined) {
		return undefined
	}

	return Date.now() - startedAtMs
}

/**
 * Join lines while skipping blank or undefined values.
 *
 * @param lines - Candidate lines.
 * @param delimiter - Delimiter used for joining.
 * @returns Joined text or undefined.
 */
function joinNonEmptyLines(lines: (string | undefined)[], delimiter = '\n'): string | undefined {
	const nonEmpty = lines.filter(line => line && line.trim().length > 0)

	if (nonEmpty.length === 0) {
		return undefined
	}

	return nonEmpty.join(delimiter)
}

/**
 * Convert a loose tool input payload to a plain record when possible.
 *
 * @param value - Arbitrary tool payload.
 * @returns Record view for structured logging.
 */
function toRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return undefined
	}

	return value as Record<string, unknown>
}

/**
 * Normalize tool inputs for event rendering (not execution).
 *
 * @param toolInput - Raw tool input payload.
 * @param targetWorkingDirectory - Target repository root.
 * @returns Normalized record suitable for attempt events.
 */
function normalizeToolInputForEvent(
	toolInput: unknown,
	targetWorkingDirectory: string,
): Record<string, unknown> | undefined {
	const record = toRecord(toolInput)

	if (!record) {
		return undefined
	}

	const normalized: Record<string, unknown> = { ...record }
	const rawPath = normalized[FILE_PATH_KEY]

	if (typeof rawPath === 'string' && rawPath.length > 0) {
		normalized[FILE_PATH_KEY] = normalizeToTargetRelativePath(rawPath, targetWorkingDirectory)
	}

	return normalized
}

/**
 * Extract validated structured output from a decidePort result message.
 *
 * @param message - SDK result message with potential structured_output.
 * @returns Validated decide port output.
 */
function readStructuredDecideOutput(message: SDKResultMessage): DecidePortOutput {
	if (message.subtype !== 'success') {
		throw new Error(`Claude decidePort failed with subtype: ${message.subtype}`)
	}

	const output = (message as unknown as { structured_output?: unknown }).structured_output

	if (!output || typeof output !== 'object') {
		throw new Error('Claude decidePort result missing structured_output.')
	}

	const required = (output as Record<string, unknown>).required
	const reason = (output as Record<string, unknown>).reason

	if (typeof required !== 'boolean' || typeof reason !== 'string') {
		throw new Error('Claude decidePort structured_output has invalid shape.')
	}

	return { required, reason }
}

import { query } from '@anthropic-ai/claude-agent-sdk'

import { buildSystemPrompt, buildUserPrompt } from './build-prompt.ts'

import type { SDKMessage, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { AgentInput, AgentOutput, AgentProvider, ToolCallEntry } from '@repo-port-bot/engine'

import type { ClaudeProviderOptions, QueryFn } from './types.ts'

const DEFAULT_MODEL = 'claude-sonnet-4-6'
const DEFAULT_MAX_TURNS = 50
const EDIT_TOOL = 'Edit'
const WRITE_TOOL = 'Write'
const FILE_PATH_KEY = 'file_path'

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
	 * Execute a single edit attempt in the target repository.
	 *
	 * @param input - Agent input from the execution orchestrator.
	 * @returns Agent output with touched files and tool-call observability.
	 */
	public async executePort(input: AgentInput): Promise<AgentOutput> {
		const touchedFiles = new Set<string>()
		const toolCallLog: ToolCallEntry[] = []
		const assistantNotes: string[] = []
		const startTimesByToolUseId = new Map<string, number>()
		const systemPrompt = buildSystemPrompt(input.pluginConfig)
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
				assistantNotes.push(...extractAssistantText(message))
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

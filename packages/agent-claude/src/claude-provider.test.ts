import { describe, expect, test } from 'bun:test'

import { ClaudeAgentProvider } from './claude-provider.ts'

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ExecutePortAttemptInput, PluginConfig } from '@repo-port-bot/engine'

const DECISION_COST_USD = 0.001
const EXECUTION_COST_USD = 0.01

/**
 * Build plugin config fixture.
 *
 * @returns Plugin config fixture.
 */
function makePluginConfig(): PluginConfig {
	return {
		targetRepo: {
			owner: 'acme',
			name: 'target',
			defaultBranch: 'main',
		},
		ignorePatterns: [],
		validationCommands: ['bun run check'],
		pathMappings: {
			'src/': 'src/',
		},
	}
}

/**
 * Build an agent input fixture.
 *
 * @returns Agent input fixture.
 */
function makeInput(): ExecutePortAttemptInput {
	return {
		files: [
			{
				path: 'src/example.ts',
				status: 'modified',
				additions: 3,
				deletions: 1,
				patch: '@@ -1,1 +1,2 @@\n-export const a = 1\n+export const a = 2',
			},
		],
		targetWorkingDirectory: '/tmp/target',
		pluginConfig: makePluginConfig(),
		previousAttempts: [],
	}
}

/**
 * Build a mock SDK assistant message with provided content blocks.
 *
 * @param content - Assistant content blocks.
 * @returns SDK message fixture.
 */
function makeAssistantMessage(content: unknown[]): SDKMessage {
	return {
		type: 'assistant',
		message: {
			content,
		},
		parent_tool_use_id: null,
		uuid: 'uuid-assistant',
		session_id: 'session-1',
	} as unknown as SDKMessage
}

describe('ClaudeAgentProvider', () => {
	test('decidePort uses structured output format and read-only tools', async () => {
		const queryCalls: { options: unknown; prompt: unknown }[] = []
		const provider = new ClaudeAgentProvider({
			queryFn: ({ options, prompt }) =>
				(async function* queryFn(): AsyncGenerator<SDKMessage, void> {
					queryCalls.push({ options, prompt })
					yield makeAssistantMessage([{ type: 'text', text: 'Analyzing the change...' }])
					yield {
						type: 'result',
						subtype: 'success',
						duration_ms: 10,
						duration_api_ms: 8,
						is_error: false,
						num_turns: 1,
						result: '',
						stop_reason: null,
						total_cost_usd: DECISION_COST_USD,
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
							service_tier: 'standard',
						},
						permission_denials: [],
						structured_output: {
							decision: 'not_required',
							reason: 'No matching target module to port.',
						},
						uuid: 'uuid-result',
						session_id: 'session-1',
					} as unknown as SDKMessage
				})(),
		})

		const output = await provider.decidePort({
			files: makeInput().files,
			targetWorkingDirectory: '/tmp/target',
			pluginConfig: makePluginConfig(),
		})

		expect(output.outcome.kind).toBe('PORT_NOT_REQUIRED')
		expect(output.outcome.reason).toBe('No matching target module to port.')
		expect(output.trace.toolCallLog).toEqual([])
		expect(output.trace.costUsd).toBe(DECISION_COST_USD)
		expect(output.trace.usage).toEqual({
			inputTokens: 1,
			outputTokens: 1,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
			serviceTier: 'standard',
		})
		expect(output.trace.events).toEqual([
			{
				kind: 'assistant_note',
				text: 'Analyzing the change...',
			},
		])
		expect(queryCalls).toHaveLength(1)
		expect(queryCalls[0]!.options).toMatchObject({
			allowedTools: ['Read', 'Glob', 'Grep'],
			tools: ['Read', 'Glob', 'Grep'],
			outputFormat: {
				type: 'json_schema',
				schema: {
					type: 'object',
					properties: {
						decision: {
							type: 'string',
							enum: ['required', 'not_required', 'needs_human'],
						},
						reason: { type: 'string' },
					},
					required: ['decision', 'reason'],
				},
			},
		})
	})

	test('decidePort captures tool calls, events, and streamed messages', async () => {
		const streamedMessages: unknown[] = []
		const provider = new ClaudeAgentProvider({
			queryFn: ({ options }) =>
				(async function* queryFn(): AsyncGenerator<SDKMessage, void> {
					const preHook = (options?.hooks?.PreToolUse ?? [])[0]?.hooks?.[0]
					const postHook = (options?.hooks?.PostToolUse ?? [])[0]?.hooks?.[0]

					await preHook?.(
						{
							hook_event_name: 'PreToolUse',
							tool_name: 'Read',
							tool_input: { file_path: '/tmp/target/src/example.ts' },
							tool_use_id: 'tool-read',
							session_id: 'session-1',
							transcript_path: '/tmp/transcript',
							cwd: '/tmp/target',
						},
						undefined,
						{ signal: new AbortController().signal },
					)

					await postHook?.(
						{
							hook_event_name: 'PostToolUse',
							tool_name: 'Read',
							tool_input: { file_path: '/tmp/target/src/example.ts' },
							tool_response: { content: 'source text' },
							tool_use_id: 'tool-read',
							session_id: 'session-1',
							transcript_path: '/tmp/transcript',
							cwd: '/tmp/target',
						},
						undefined,
						{ signal: new AbortController().signal },
					)

					yield makeAssistantMessage([
						{
							type: 'thinking',
							thinking: 'Checking for equivalent target files.',
						},
						{
							type: 'text',
							text: 'Classifier decision rationale.',
						},
					])
					yield {
						type: 'result',
						subtype: 'success',
						duration_ms: 10,
						duration_api_ms: 8,
						is_error: false,
						num_turns: 1,
						result: '',
						stop_reason: null,
						total_cost_usd: DECISION_COST_USD,
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
							service_tier: 'standard',
						},
						permission_denials: [],
						structured_output: {
							decision: 'required',
							reason: 'Port required for target parity.',
						},
						uuid: 'uuid-result',
						session_id: 'session-1',
					} as unknown as SDKMessage
				})(),
		})

		const output = await provider.decidePort({
			files: makeInput().files,
			targetWorkingDirectory: '/tmp/target',
			pluginConfig: makePluginConfig(),
			onMessage: message => streamedMessages.push(message),
		})

		expect(output.outcome.kind).toBe('PORT_REQUIRED')
		expect(output.outcome.reason).toBe('Port required for target parity.')
		expect(output.trace.toolCallLog).toHaveLength(1)
		expect(output.trace.events).toEqual([
			{
				kind: 'tool_start',
				toolName: 'Read',
				toolUseId: 'tool-read',
				toolInput: { file_path: 'src/example.ts' },
			},
			{
				kind: 'tool_end',
				toolName: 'Read',
				toolUseId: 'tool-read',
				durationMs: expect.any(Number),
			},
			{
				kind: 'assistant_note',
				text: 'Classifier decision rationale.',
			},
		])
		expect(streamedMessages).toContainEqual({
			kind: 'thinking',
			text: 'Checking for equivalent target files.',
		})
		expect(streamedMessages).toContainEqual({
			kind: 'tool_start',
			toolName: 'Read',
			toolInput: { file_path: 'src/example.ts' },
		})
	})

	test('decidePort maps needs_human decision to NEEDS_HUMAN outcome', async () => {
		const provider = new ClaudeAgentProvider({
			queryFn: () =>
				(async function* queryFn(): AsyncGenerator<SDKMessage, void> {
					yield {
						type: 'result',
						subtype: 'success',
						duration_ms: 10,
						duration_api_ms: 8,
						is_error: false,
						num_turns: 1,
						result: '',
						stop_reason: null,
						total_cost_usd: DECISION_COST_USD,
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
							service_tier: 'standard',
						},
						permission_denials: [],
						structured_output: {
							decision: 'needs_human',
							reason: 'The target mapping is ambiguous and should be reviewed manually.',
						},
						uuid: 'uuid-result',
						session_id: 'session-1',
					} as unknown as SDKMessage
				})(),
		})

		const output = await provider.decidePort({
			files: makeInput().files,
			targetWorkingDirectory: '/tmp/target',
			pluginConfig: makePluginConfig(),
		})

		expect(output.outcome.kind).toBe('NEEDS_HUMAN')
		expect(output.outcome.reason).toBe(
			'The target mapping is ambiguous and should be reviewed manually.',
		)
		expect(output.trace.source).toBe('classifier')
	})

	test('decidePort throws when SDK cannot produce valid structured output', async () => {
		const provider = new ClaudeAgentProvider({
			queryFn: () =>
				(async function* queryFn(): AsyncGenerator<SDKMessage, void> {
					yield {
						type: 'result',
						subtype: 'error_max_structured_output_retries',
						duration_ms: 10,
						duration_api_ms: 8,
						is_error: true,
						num_turns: 1,
						stop_reason: null,
						total_cost_usd: DECISION_COST_USD,
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
							service_tier: 'standard',
						},
						permission_denials: [],
						errors: ['Could not produce valid output.'],
						uuid: 'uuid-result',
						session_id: 'session-1',
					} as unknown as SDKMessage
				})(),
		})

		await expect(
			provider.decidePort({
				files: makeInput().files,
				targetWorkingDirectory: '/tmp/target',
				pluginConfig: makePluginConfig(),
			}),
		).rejects.toThrow('decidePort failed with subtype')
	})

	test('returns complete output with touched files and tool call log on success', async () => {
		const queryCalls: { options: unknown; prompt: unknown }[] = []
		const streamedMessages: unknown[] = []
		const provider = new ClaudeAgentProvider({
			queryFn: ({ options, prompt }) =>
				(async function* queryFn(): AsyncGenerator<SDKMessage, void> {
					queryCalls.push({ options, prompt })

					const hookMatchers = (options?.hooks?.PostToolUse ?? [])[0]?.hooks
					const preHookMatchers = (options?.hooks?.PreToolUse ?? [])[0]?.hooks
					const preHook = preHookMatchers?.[0]
					const postHook = hookMatchers?.[0]

					await preHook?.(
						{
							hook_event_name: 'PreToolUse',
							tool_name: 'Read',
							tool_input: { file_path: '/tmp/target/src/example.ts' },
							tool_use_id: 'tool-read',
							session_id: 'session-1',
							transcript_path: '/tmp/transcript',
							cwd: '/tmp/target',
						},
						undefined,
						{ signal: new AbortController().signal },
					)

					await postHook?.(
						{
							hook_event_name: 'PostToolUse',
							tool_name: 'Read',
							tool_input: { file_path: '/tmp/target/src/example.ts' },
							tool_response: { content: 'source text' },
							tool_use_id: 'tool-read',
							session_id: 'session-1',
							transcript_path: '/tmp/transcript',
							cwd: '/tmp/target',
						},
						undefined,
						{ signal: new AbortController().signal },
					)

					await preHook?.(
						{
							hook_event_name: 'PreToolUse',
							tool_name: 'Edit',
							tool_input: { file_path: '/tmp/target/src/ported.ts' },
							tool_use_id: 'tool-edit',
							session_id: 'session-1',
							transcript_path: '/tmp/transcript',
							cwd: '/tmp/target',
						},
						undefined,
						{ signal: new AbortController().signal },
					)

					await postHook?.(
						{
							hook_event_name: 'PostToolUse',
							tool_name: 'Edit',
							tool_input: { file_path: '/tmp/target/src/ported.ts' },
							tool_response: { ok: true },
							tool_use_id: 'tool-edit',
							session_id: 'session-1',
							transcript_path: '/tmp/transcript',
							cwd: '/tmp/target',
						},
						undefined,
						{ signal: new AbortController().signal },
					)

					yield makeAssistantMessage([
						{
							type: 'thinking',
							thinking: 'Need to inspect the destination file before editing.',
						},
						{
							type: 'text',
							text: 'Applied source changes and updated imports.',
						},
					])
					yield {
						type: 'result',
						subtype: 'success',
						duration_ms: 100,
						duration_api_ms: 50,
						is_error: false,
						num_turns: 1,
						result: 'done',
						stop_reason: null,
						total_cost_usd: EXECUTION_COST_USD,
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
							service_tier: 'standard',
						},
						permission_denials: [],
						structured_output: {
							summary: 'Ported parity updates across source files.',
							files: [
								{
									path: 'src/ported.ts',
									description: 'Applied source logic and updated imports.',
								},
							],
						},
						uuid: 'uuid-result',
						session_id: 'session-1',
					} as unknown as SDKMessage
				})(),
		})

		const output = await provider.executePort({
			...makeInput(),
			onMessage: message => streamedMessages.push(message),
		})

		expect(queryCalls).toHaveLength(1)
		expect(output.trace.costUsd).toBe(EXECUTION_COST_USD)
		expect(output.trace.usage).toEqual({
			inputTokens: 1,
			outputTokens: 1,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
			serviceTier: 'standard',
		})
		expect(output.complete).toBe(true)
		expect(output.touchedFiles).toEqual(['src/ported.ts'])
		expect(output.summary).toEqual({
			text: 'Ported parity updates across source files.',
			files: [
				{
					path: 'src/ported.ts',
					description: 'Applied source logic and updated imports.',
				},
			],
		})
		expect(output.trace.toolCallLog).toHaveLength(2)
		expect(output.trace.toolCallLog[0]?.toolName).toBe('Read')
		expect(output.trace.toolCallLog[1]?.toolName).toBe('Edit')
		expect(output.trace.events).toEqual([
			{
				kind: 'tool_start',
				toolName: 'Read',
				toolUseId: 'tool-read',
				toolInput: { file_path: 'src/example.ts' },
			},
			{
				kind: 'tool_end',
				toolName: 'Read',
				toolUseId: 'tool-read',
				durationMs: expect.any(Number),
			},
			{
				kind: 'tool_start',
				toolName: 'Edit',
				toolUseId: 'tool-edit',
				toolInput: { file_path: 'src/ported.ts' },
			},
			{
				kind: 'tool_end',
				toolName: 'Edit',
				toolUseId: 'tool-edit',
				durationMs: expect.any(Number),
			},
			{
				kind: 'assistant_note',
				text: 'Applied source changes and updated imports.',
			},
		])
		expect(output.trace.notes).toContain('Applied source changes')
		expect(streamedMessages).toContainEqual({
			kind: 'thinking',
			text: 'Need to inspect the destination file before editing.',
		})
		expect(streamedMessages).toContainEqual({
			kind: 'text',
			text: 'Applied source changes and updated imports.',
		})
		expect(streamedMessages).toContainEqual({
			kind: 'tool_start',
			toolName: 'Read',
			toolInput: { file_path: 'src/example.ts' },
		})
		expect(streamedMessages).toContainEqual({
			kind: 'tool_end',
			toolName: 'Edit',
			durationMs: expect.any(Number),
		})
		expect(queryCalls[0]!.options).toMatchObject({
			outputFormat: {
				type: 'json_schema',
				schema: {
					type: 'object',
					properties: {
						summary: { type: 'string' },
						files: {
							type: 'array',
							items: {
								type: 'object',
								properties: {
									path: { type: 'string' },
									description: { type: 'string' },
								},
								required: ['path', 'description'],
							},
						},
					},
					required: ['summary', 'files'],
				},
			},
		})
	})

	test('returns incomplete output with error notes on max-turns result', async () => {
		const provider = new ClaudeAgentProvider({
			queryFn: () =>
				(async function* queryFn(): AsyncGenerator<SDKMessage, void> {
					yield makeAssistantMessage([
						{
							type: 'text',
							text: 'Attempted update but hit constraints.',
						},
					])
					yield {
						type: 'result',
						subtype: 'error_max_turns',
						duration_ms: 120,
						duration_api_ms: 60,
						is_error: true,
						num_turns: 50,
						stop_reason: 'max_turns',
						total_cost_usd: 0.02,
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
							service_tier: 'standard',
						},
						permission_denials: [],
						errors: ['Reached max turns.'],
						uuid: 'uuid-result',
						session_id: 'session-1',
					} as unknown as SDKMessage
				})(),
		})

		const output = await provider.executePort(makeInput())

		expect(output.complete).toBe(false)
		expect(output.incompleteReason).toBe('reached max turns')
		expect(output.summary).toBeUndefined()
		expect(output.trace.notes).toContain('Attempted update but hit constraints.')
		expect(output.trace.notes).toContain('Reached max turns.')
		expect(output.trace.events).toEqual([
			{
				kind: 'assistant_note',
				text: 'Attempted update but hit constraints.',
			},
		])
	})
})

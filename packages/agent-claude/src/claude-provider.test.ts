import { describe, expect, test } from 'bun:test'

import { ClaudeAgentProvider } from './claude-provider.ts'

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AgentInput, PluginConfig } from '@repo-port-bot/engine'

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
function makeInput(): AgentInput {
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
						total_cost_usd: 0.01,
						usage: {
							input_tokens: 1,
							output_tokens: 1,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
							service_tier: 'standard',
						},
						modelUsage: {},
						permission_denials: [],
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
		expect(output.complete).toBe(true)
		expect(output.touchedFiles).toEqual(['src/ported.ts'])
		expect(output.toolCallLog).toHaveLength(2)
		expect(output.toolCallLog[0]?.toolName).toBe('Read')
		expect(output.toolCallLog[1]?.toolName).toBe('Edit')
		expect(output.notes).toContain('Applied source changes')
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
			toolInput: { file_path: '/tmp/target/src/example.ts' },
		})
		expect(streamedMessages).toContainEqual({
			kind: 'tool_end',
			toolName: 'Edit',
			durationMs: expect.any(Number),
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
						modelUsage: {},
						permission_denials: [],
						errors: ['Reached max turns.'],
						uuid: 'uuid-result',
						session_id: 'session-1',
					} as unknown as SDKMessage
				})(),
		})

		const output = await provider.executePort(makeInput())

		expect(output.complete).toBe(false)
		expect(output.notes).toContain('Attempted update but hit constraints.')
		expect(output.notes).toContain('Reached max turns.')
	})
})

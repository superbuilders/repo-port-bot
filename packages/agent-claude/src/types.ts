import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export interface QueryInput {
	prompt: string | AsyncIterable<SDKUserMessage>
	options?: Options
}

export type QueryFn = (input: QueryInput) => AsyncGenerator<SDKMessage, void>

export interface ClaudeProviderOptions {
	model?: string
	maxTurns?: number
	maxBudgetUsd?: number
	apiKey?: string
	queryFn?: QueryFn
}

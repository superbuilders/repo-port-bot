import { describe, expect, test } from 'bun:test'

import { parseActionInputs } from './parse-inputs.ts'

const CUSTOM_MAX_ATTEMPTS = 4
const CUSTOM_EXECUTION_MAX_TURNS = 75
const CUSTOM_DECISION_MAX_TURNS = 25
const CUSTOM_MAX_BUDGET_USD = 2.5
const DEFAULT_EXECUTION_MAX_TURNS = 250
const DEFAULT_DECISION_MAX_TURNS = 50

/**
 * Build input getter mock from a key/value dictionary.
 *
 * @param values - Input values keyed by input name.
 * @returns Mocked getInput implementation.
 */
function createGetInput(values: Record<string, string>) {
	return (name: string): string => values[name] ?? ''
}

/**
 * Build a minimal GitHub context fixture.
 *
 * @returns Context fixture.
 */
function createContext() {
	return {
		repo: {
			owner: 'acme',
			repo: 'source-repo',
		},
		sha: 'abc123',
		payload: {
			repository: {
				default_branch: 'main',
			},
		},
	} as const
}

describe('parseActionInputs', () => {
	test('uses github-token fallback for both source and target', () => {
		const parsed = parseActionInputs({
			getInput: createGetInput({
				'github-token': 'shared-token',
				'source-github-token': '',
				'target-github-token': '',
				'llm-api-key': 'llm-key',
				'target-repo': 'acme/target-repo',
				'target-default-branch': 'main',
				'validation-commands': 'bun run check\nbun run test',
				'path-mappings': '{"src/":"src/"}',
				'naming-conventions': 'snake_case',
				prompt: 'custom prompt',
				model: 'claude-sonnet-4-6',
				'max-attempts': '3',
				'max-turns-execution': '75',
				'max-turns-decision': '25',
				'max-budget-usd': '2.5',
				'skip-port-bot-json': 'false',
				'include-cost-telemetry': 'true',
				'log-level': 'info',
			}),
			context: createContext() as never,
		})

		expect(parsed.effectiveSourceToken).toBe('shared-token')
		expect(parsed.effectiveTargetToken).toBe('shared-token')
		expect(parsed.validationCommands).toEqual(['bun run check', 'bun run test'])
		expect(parsed.pathMappings).toEqual({ 'src/': 'src/' })
		expect(parsed.maxTurnsExecution).toBe(CUSTOM_EXECUTION_MAX_TURNS)
		expect(parsed.maxTurnsDecision).toBe(CUSTOM_DECISION_MAX_TURNS)
		expect(parsed.maxBudgetUsd).toBe(CUSTOM_MAX_BUDGET_USD)
		expect(parsed.skipPortBotJson).toBe(false)
		expect(parsed.includeCostTelemetry).toBe(true)
		expect(parsed.logLevel).toBe('info')
	})

	test('uses split source and target tokens with explicit turn inputs', () => {
		const parsed = parseActionInputs({
			getInput: createGetInput({
				'github-token': '',
				'source-github-token': 'source-token',
				'target-github-token': 'target-token',
				'llm-api-key': 'llm-key',
				'target-repo': 'acme/target-repo',
				'target-default-branch': 'main',
				'validation-commands': '',
				'path-mappings': '{}',
				'naming-conventions': '',
				prompt: '',
				model: 'claude-sonnet-4-6',
				'max-attempts': '4',
				'max-turns-execution': '75',
				'max-turns-decision': '25',
				'max-budget-usd': '',
				'skip-port-bot-json': 'true',
				'include-cost-telemetry': 'false',
				'log-level': 'debug',
			}),
			context: createContext() as never,
		})

		expect(parsed.effectiveSourceToken).toBe('source-token')
		expect(parsed.effectiveTargetToken).toBe('target-token')
		expect(parsed.maxAttempts).toBe(CUSTOM_MAX_ATTEMPTS)
		expect(parsed.maxTurnsExecution).toBe(CUSTOM_EXECUTION_MAX_TURNS)
		expect(parsed.maxTurnsDecision).toBe(CUSTOM_DECISION_MAX_TURNS)
		expect(parsed.maxBudgetUsd).toBeUndefined()
		expect(parsed.skipPortBotJson).toBe(true)
		expect(parsed.includeCostTelemetry).toBe(false)
		expect(parsed.logLevel).toBe('debug')
	})

	test('uses separate default turn values when no turn inputs are provided', () => {
		const parsed = parseActionInputs({
			getInput: createGetInput({
				'github-token': 'shared-token',
				'source-github-token': '',
				'target-github-token': '',
				'llm-api-key': 'llm-key',
				'target-repo': 'acme/target-repo',
				'target-default-branch': 'main',
				'validation-commands': '',
				'path-mappings': '{}',
				'naming-conventions': '',
				prompt: '',
				model: 'claude-sonnet-4-6',
				'max-attempts': '3',
				'max-budget-usd': '',
				'skip-port-bot-json': 'false',
				'include-cost-telemetry': 'true',
				'log-level': 'info',
			}),
			context: createContext() as never,
		})

		expect(parsed.maxTurnsExecution).toBe(DEFAULT_EXECUTION_MAX_TURNS)
		expect(parsed.maxTurnsDecision).toBe(DEFAULT_DECISION_MAX_TURNS)
	})

	test('throws when no effective target token can be resolved', () => {
		expect(() =>
			parseActionInputs({
				getInput: createGetInput({
					'github-token': '',
					'source-github-token': 'source-only',
					'target-github-token': '',
					'llm-api-key': 'llm-key',
					'target-repo': 'acme/target-repo',
					'target-default-branch': 'main',
					'validation-commands': '',
					'path-mappings': '{}',
					'naming-conventions': '',
					prompt: '',
					model: 'claude-sonnet-4-6',
					'max-attempts': '3',
					'max-budget-usd': '',
					'skip-port-bot-json': 'false',
					'include-cost-telemetry': 'true',
					'log-level': 'info',
				}),
				context: createContext() as never,
			}),
		).toThrow('Missing target GitHub token')
	})

	test('throws when skip-port-bot-json is not a boolean string', () => {
		expect(() =>
			parseActionInputs({
				getInput: createGetInput({
					'github-token': 'shared-token',
					'source-github-token': '',
					'target-github-token': '',
					'llm-api-key': 'llm-key',
					'target-repo': 'acme/target-repo',
					'target-default-branch': 'main',
					'validation-commands': '',
					'path-mappings': '{}',
					'naming-conventions': '',
					prompt: '',
					model: 'claude-sonnet-4-6',
					'max-attempts': '3',
					'max-budget-usd': '',
					'skip-port-bot-json': 'yes',
					'include-cost-telemetry': 'true',
					'log-level': 'info',
				}),
				context: createContext() as never,
			}),
		).toThrow('Input "skip-port-bot-json" must be "true" or "false".')
	})

	test('throws when log-level is invalid', () => {
		expect(() =>
			parseActionInputs({
				getInput: createGetInput({
					'github-token': 'shared-token',
					'source-github-token': '',
					'target-github-token': '',
					'llm-api-key': 'llm-key',
					'target-repo': 'acme/target-repo',
					'target-default-branch': 'main',
					'validation-commands': '',
					'path-mappings': '{}',
					'naming-conventions': '',
					prompt: '',
					model: 'claude-sonnet-4-6',
					'max-attempts': '3',
					'max-budget-usd': '',
					'skip-port-bot-json': 'false',
					'include-cost-telemetry': 'true',
					'log-level': 'verbose',
				}),
				context: createContext() as never,
			}),
		).toThrow('Input "log-level" must be one of: error, warn, info, debug.')
	})

	test('defaults include-cost-telemetry to true when omitted', () => {
		const parsed = parseActionInputs({
			getInput: createGetInput({
				'github-token': 'shared-token',
				'source-github-token': '',
				'target-github-token': '',
				'llm-api-key': 'llm-key',
				'target-repo': 'acme/target-repo',
				'target-default-branch': 'main',
				'validation-commands': '',
				'path-mappings': '{}',
				'naming-conventions': '',
				prompt: '',
				model: 'claude-sonnet-4-6',
				'max-attempts': '3',
				'max-budget-usd': '',
				'skip-port-bot-json': 'false',
				'log-level': 'info',
			}),
			context: createContext() as never,
		})

		expect(parsed.includeCostTelemetry).toBe(true)
	})
})

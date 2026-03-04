import { describe, expect, test } from 'bun:test'

import { createConsoleLogger } from '@repo-port-bot/logger'

import { runPort } from './run-port.ts'

import type { Octokit } from '@octokit/rest'
import type { Logger } from '@repo-port-bot/logger'

import type {
	AgentProvider,
	ExecutionResult,
	PluginConfig,
	PortContext,
	PortDecision,
	RepoRef,
	SourceChange,
} from '../types.ts'

const SOURCE_REPO: RepoRef = {
	owner: 'acme',
	name: 'source-repo',
	defaultBranch: 'main',
}

const TARGET_REPO: RepoRef = {
	owner: 'acme',
	name: 'target-repo',
	defaultBranch: 'main',
}

/**
 * Build a no-op Octokit mock for run-port tests.
 *
 * @returns Octokit mock value.
 */
function createOctokitMock(): Octokit {
	return {
		rest: {
			repos: {
				async getContent() {
					throw { status: 404 }
				},
			},
		},
	} as unknown as Octokit
}

/**
 * Build a default source change fixture.
 *
 * @returns Source change payload.
 */
function makeSourceChange(): SourceChange {
	return {
		mergedCommitSha: 'abc1234567890',
		pullRequest: {
			number: 42,
			title: 'Ship feature',
			body: 'PR body',
			url: 'https://github.com/acme/source-repo/pull/42',
			labels: [],
		},
		files: [{ path: 'src/feature.ts', status: 'modified', additions: 10, deletions: 2 }],
	}
}

/**
 * Build a resolved plugin config fixture.
 *
 * @returns Plugin config payload.
 */
function makePluginConfig(): PluginConfig {
	return {
		targetRepo: TARGET_REPO,
		ignorePatterns: [],
		validationCommands: ['bun run check'],
		pathMappings: {},
	}
}

/**
 * Build decision fixture with customizable kind.
 *
 * @param kind - Decision kind.
 * @param reason - Decision explanation text.
 * @returns Decision value.
 */
function makeDecision(kind: PortDecision['kind'], reason: string): PortDecision {
	return {
		kind,
		reason,
		signals: ['test-signal'],
	}
}

/**
 * Build execution fixture for success/failure paths.
 *
 * @param success - Execution success state.
 * @returns Execution result fixture.
 */
function makeExecution(success: boolean): ExecutionResult {
	return {
		success,
		attempts: success ? 1 : 3,
		history: [
			{
				attempt: success ? 1 : 3,
				touchedFiles: ['src/ported.ts'],
				validation: [],
				notes: success ? 'Done.' : 'Validation failed after retries.',
				toolCallLog: [],
			},
		],
		touchedFiles: ['src/ported.ts'],
		failureReason: success ? undefined : 'Validation failed after 3 attempts: `bun run check`.',
	}
}

/**
 * Build a no-op agent provider for orchestrator tests.
 *
 * @returns Agent provider instance.
 */
function createAgentProvider(): AgentProvider {
	return {
		async executePort() {
			throw new Error('Agent provider should not be called directly in run-port tests.')
		},
	}
}

describe('runPort', () => {
	test('runs full PORT_REQUIRED flow and returns pr_opened', async () => {
		const callOrder: string[] = []
		const commentOutcomes: string[] = []
		const sourceChange = makeSourceChange()
		const pluginConfig = makePluginConfig()
		const sourceWorkingDirectory = '/tmp/source-repo'
		const diffFilePath = '/tmp/source-repo/port-diff.patch'
		let executeInput:
			| {
					sourceWorkingDirectory?: string
					diffFilePath?: string
			  }
			| undefined = undefined

		const result = await runPort({
			octokit: createOctokitMock(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: sourceChange.mergedCommitSha,
			targetWorkingDirectory: '/tmp/target-repo',
			sourceWorkingDirectory,
			diffFilePath,
			logger: createConsoleLogger('error'),
			stageOverrides: {
				readSourceContext: async () => {
					callOrder.push('read')

					return sourceChange
				},
				resolvePluginConfig: () => {
					callOrder.push('resolve')

					return pluginConfig
				},
				decide: (context: PortContext) => {
					callOrder.push('decide')
					expect(context.sourceChange.mergedCommitSha).toBe(sourceChange.mergedCommitSha)

					return makeDecision('PORT_REQUIRED', 'Port required.')
				},
				executePort: async input => {
					callOrder.push('execute')
					executeInput = {
						sourceWorkingDirectory: input.sourceWorkingDirectory,
						diffFilePath: input.diffFilePath,
					}

					return makeExecution(true)
				},
				deliverResult: async () => {
					callOrder.push('deliver')

					return {
						outcome: 'pr_opened',
						targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/901',
					}
				},
				commentOnSourcePr: async input => {
					callOrder.push('comment')
					commentOutcomes.push(input.outcome)

					return 'https://github.com/acme/source-repo/pull/42#issuecomment-1'
				},
			},
		})

		expect(callOrder).toEqual(['read', 'resolve', 'decide', 'execute', 'deliver', 'comment'])
		expect(commentOutcomes).toEqual(['pr_opened'])
		expect(result.outcome).toBe('pr_opened')
		expect(result.targetPullRequestUrl).toBe('https://github.com/acme/target-repo/pull/901')
		expect(result.durationMs).toBeGreaterThan(0)
		expect(result.stageTimings?.contextMs).toBeGreaterThan(0)
		expect(result.stageTimings?.configMs).toBeGreaterThan(0)
		expect(result.stageTimings?.decisionMs).toBeGreaterThan(0)
		expect(result.stageTimings?.executeMs).toBeGreaterThan(0)
		expect(result.stageTimings?.deliverMs).toBeGreaterThan(0)
		expect(result.stageTimings?.notifyMs).toBeGreaterThan(0)
		expect(result.summary).toContain('Port PR opened')
		expect(executeInput).toBeDefined()
		expect(executeInput!.sourceWorkingDirectory).toBe(sourceWorkingDirectory)
		expect(executeInput!.diffFilePath).toBe(diffFilePath)
	})

	test('returns skipped_not_required and does not execute or deliver', async () => {
		let executeCalled = false
		let deliverCalled = false
		let commentCalled = false

		const result = await runPort({
			octokit: createOctokitMock(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => makePluginConfig(),
				decide: () => makeDecision('PORT_NOT_REQUIRED', 'Skipping because no-port is set.'),
				executePort: async () => {
					executeCalled = true

					return makeExecution(true)
				},
				deliverResult: async () => {
					deliverCalled = true

					return { outcome: 'skipped' }
				},
				commentOnSourcePr: async () => {
					commentCalled = true

					return 'https://github.com/acme/source-repo/pull/42#issuecomment-1'
				},
			},
		})

		expect(result.outcome).toBe('skipped_not_required')
		expect(result.summary).toContain('Skipped:')
		expect(executeCalled).toBe(false)
		expect(deliverCalled).toBe(false)
		expect(commentCalled).toBe(false)
	})

	test('routes NEEDS_HUMAN to issue delivery and returns needs_human', async () => {
		let executeCalled = false
		const commentOutcomes: string[] = []

		const result = await runPort({
			octokit: createOctokitMock(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => makePluginConfig(),
				decide: () => makeDecision('NEEDS_HUMAN', 'Classifier is uncertain.'),
				executePort: async () => {
					executeCalled = true

					return makeExecution(true)
				},
				deliverResult: async () => ({
					outcome: 'needs_human',
					followUpIssueUrl: 'https://github.com/acme/target-repo/issues/55',
				}),
				commentOnSourcePr: async input => {
					commentOutcomes.push(input.outcome)

					return 'https://github.com/acme/source-repo/pull/42#issuecomment-2'
				},
			},
		})

		expect(result.outcome).toBe('needs_human')
		expect(result.followUpIssueUrl).toBe('https://github.com/acme/target-repo/issues/55')
		expect(result.summary).toContain('Needs human review')
		expect(executeCalled).toBe(false)
		expect(commentOutcomes).toEqual(['needs_human'])
	})

	test('returns draft_pr_opened when execution fails and delivery opens draft', async () => {
		const commentOutcomes: string[] = []

		const result = await runPort({
			octokit: createOctokitMock(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => makePluginConfig(),
				decide: () => makeDecision('PORT_REQUIRED', 'Port required.'),
				executePort: async () => makeExecution(false),
				deliverResult: async () => ({
					outcome: 'draft_pr_opened',
					targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/333',
				}),
				commentOnSourcePr: async input => {
					commentOutcomes.push(input.outcome)

					return 'https://github.com/acme/source-repo/pull/42#issuecomment-3'
				},
			},
		})

		expect(result.outcome).toBe('draft_pr_opened')
		expect(result.targetPullRequestUrl).toBe('https://github.com/acme/target-repo/pull/333')
		expect(result.summary).toContain('Draft PR opened (stalled)')
		expect(result.summary).toContain('Validation failed after 3 attempts')
		expect(commentOutcomes).toEqual(['draft_pr_opened'])
	})

	test('returns failed when a stage throws and still includes duration', async () => {
		const result = await runPort({
			octokit: createOctokitMock(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			stageOverrides: {
				readSourceContext: async () => {
					throw new Error('read context exploded')
				},
			},
		})

		expect(result.outcome).toBe('failed')
		expect(result.decision.kind).toBe('NEEDS_HUMAN')
		expect(result.summary).toContain('Engine failure: read context exploded')
		expect(result.durationMs).toBeGreaterThan(0)
	})

	test('returns failed and continues when source comment posting throws', async () => {
		const result = await runPort({
			octokit: createOctokitMock(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => makePluginConfig(),
				decide: () => {
					throw new Error('decider exploded')
				},
				commentOnSourcePr: async () => {
					throw new Error('comment post failed')
				},
			},
		})

		expect(result.outcome).toBe('failed')
		expect(result.decision.kind).toBe('NEEDS_HUMAN')
		expect(result.summary).toContain('Engine failure: decider exploded')
	})

	test('auto-fetches port-bot.json when not provided', async () => {
		let fetchCalled = false
		let resolvedPortBotJson: unknown = undefined

		await runPort({
			octokit: createOctokitMock(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				fetchPortBotJson: async () => {
					fetchCalled = true

					return {
						target: 'acme/target-repo',
					}
				},
				resolvePluginConfig: options => {
					resolvedPortBotJson = options.portBotJson

					return makePluginConfig()
				},
				decide: () => makeDecision('PORT_NOT_REQUIRED', 'Skipping because no-port is set.'),
			},
		})

		expect(fetchCalled).toBe(true)
		expect(resolvedPortBotJson).toEqual({ target: 'acme/target-repo' })
	})

	test('skips auto-fetch when skipPortBotJson is true', async () => {
		let fetchCalled = false
		let resolvedPortBotJson: unknown = undefined

		await runPort({
			octokit: createOctokitMock(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			skipPortBotJson: true,
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				fetchPortBotJson: async () => {
					fetchCalled = true

					return {}
				},
				resolvePluginConfig: options => {
					resolvedPortBotJson = options.portBotJson

					return makePluginConfig()
				},
				decide: () => makeDecision('PORT_NOT_REQUIRED', 'Skipping because no-port is set.'),
			},
		})

		expect(fetchCalled).toBe(false)
		expect(resolvedPortBotJson).toBeUndefined()
	})

	test('emits structured stage logs via injected logger', async () => {
		const infoMessages: string[] = []
		const logger: Logger = {
			error: () => {},
			warn: () => {},
			info: message => infoMessages.push(message),
			debug: () => {},
			group: () => {},
			groupEnd: () => {},
		}

		await runPort({
			octokit: createOctokitMock(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			logger,
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => makePluginConfig(),
				decide: () => makeDecision('PORT_NOT_REQUIRED', 'Skipping because no-port is set.'),
			},
		})

		expect(infoMessages.some(message => message.includes('stage=context'))).toBe(true)
		expect(infoMessages.some(message => message.includes('stage=config'))).toBe(true)
		expect(infoMessages.some(message => message.includes('stage=decision'))).toBe(true)
		expect(infoMessages.some(message => message.includes('outcome=skipped_not_required'))).toBe(
			true,
		)
	})
})

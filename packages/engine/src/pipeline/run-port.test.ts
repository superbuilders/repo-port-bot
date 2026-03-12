import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createConsoleLogger } from '@repo-port-bot/logger'

import { runPort } from './run-port.ts'

import type { Logger } from '@repo-port-bot/logger'

import type {
	AgentProvider,
	DecidePortResult,
	ExecutePortResult,
	GitHubReader,
	GitHubWriter,
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
 * Build a no-op GitHubReader fake for run-port tests.
 *
 * @returns Reader fake.
 */
function createReaderFake(): GitHubReader {
	return {
		async listPullRequestsForCommit() {
			return []
		},
		async listChangedFiles() {
			return []
		},
		async getFileContent() {
			return undefined
		},
	}
}

/**
 * Build a no-op GitHubWriter fake for run-port tests.
 *
 * @returns Writer fake.
 */
function createWriterFake(): GitHubWriter {
	return {
		async createPullRequest() {
			return { number: 0, url: '' }
		},
		async createIssue() {
			return { number: 0, url: '' }
		},
		async addLabels() {},
		async createComment() {
			return undefined
		},
	}
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
 * @param overrides - Partial config overrides.
 * @returns Plugin config payload.
 */
function makePluginConfig(overrides?: Partial<PluginConfig>): PluginConfig {
	return {
		targetRepo: TARGET_REPO,
		ignorePatterns: [],
		validationCommands: ['bun run check'],
		deterministicOperations: [],
		pathMappings: {},
		...overrides,
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
	}
}

/**
 * Build decision-stage result fixture with provenance and optional tool traces.
 *
 * @param kind - Decision kind.
 * @param reason - Decision explanation text.
 * @param source - Decision source.
 * @returns Decision result value.
 */
function makeDecisionResult(
	kind: PortDecision['kind'],
	reason: string,
	source: DecidePortResult['trace']['source'] = 'heuristic',
): DecidePortResult {
	return {
		outcome: makeDecision(kind, reason),
		trace: {
			source,
			heuristicName: source === 'heuristic' ? 'checkNoPortLabel' : undefined,
			toolCallLog: [],
			events: [],
		},
	}
}

/**
 * Build execution fixture for success/failure paths.
 *
 * @param success - Execution success state.
 * @returns Execution result fixture.
 */
function makeExecution(success: boolean): ExecutePortResult {
	return {
		outcome: {
			status: success ? 'SUCCEEDED' : 'VALIDATION_FAILED',
			attempts: success ? 1 : 3,
			touchedFiles: ['src/ported.ts'],
			reason: success ? undefined : 'Validation failed after 3 attempts: `bun run check`.',
		},
		trace: {
			notes: success ? 'Done.' : 'Validation failed after retries.',
			toolCallLog: [],
			events: [],
			attempts: [
				{
					attempt: success ? 1 : 3,
					status: success ? 'VALIDATED' : 'VALIDATION_FAILED',
					touchedFiles: ['src/ported.ts'],
					validation: [],
					trace: {
						notes: success ? 'Done.' : 'Validation failed after retries.',
						toolCallLog: [],
						events: [],
					},
				},
			],
		},
	}
}

/**
 * Build a no-op agent provider for orchestrator tests.
 *
 * @returns Agent provider instance.
 */
function createAgentProvider(): AgentProvider {
	return {
		async decidePort() {
			throw new Error('Agent provider should not be called directly in run-port tests.')
		},
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
			reader: createReaderFake(),
			writer: createWriterFake(),
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
				decide: async (context: PortContext) => {
					callOrder.push('decide')
					expect(context.sourceChange.mergedCommitSha).toBe(sourceChange.mergedCommitSha)

					return makeDecisionResult('PORT_REQUIRED', 'Port required.', 'classifier')
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
		expect(result.decision.trace.source).toBe('classifier')
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

	test('returns skipped_not_required, posts comment, and does not execute or deliver', async () => {
		let executeCalled = false
		let deliverCalled = false
		const commentOutcomes: string[] = []

		const result = await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => makePluginConfig(),
				decide: async () =>
					makeDecisionResult(
						'PORT_NOT_REQUIRED',
						'Skipping because no-port is set.',
						'heuristic',
					),
				executePort: async () => {
					executeCalled = true

					return makeExecution(true)
				},
				deliverResult: async () => {
					deliverCalled = true

					return { outcome: 'skipped' }
				},
				commentOnSourcePr: async input => {
					commentOutcomes.push(input.outcome)

					return 'https://github.com/acme/source-repo/pull/42#issuecomment-1'
				},
			},
		})

		expect(result.outcome).toBe('skipped_not_required')
		expect(result.decision.trace.source).toBe('heuristic')
		expect(result.summary).toContain('Skipped:')
		expect(executeCalled).toBe(false)
		expect(deliverCalled).toBe(false)
		expect(commentOutcomes).toEqual(['skipped_not_required'])
	})

	test('skips before deterministic operations when source pull request is missing', async () => {
		let deterministicCalled = false
		let decideCalled = false
		let deliverCalled = false
		const commentOutcomes: string[] = []
		const sourceChange = makeSourceChange()

		sourceChange.pullRequest = undefined

		const result = await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			sourceWorkingDirectory: '/tmp/source-repo',
			stageOverrides: {
				readSourceContext: async () => sourceChange,
				resolvePluginConfig: () =>
					makePluginConfig({
						deterministicOperations: [
							{
								kind: 'sync',
								mode: 'mirror',
								source: 'tests/fixtures/**',
								target: 'tests/fixtures/',
							},
						],
					}),
				executeDeterministic: async () => {
					deterministicCalled = true

					return {
						changed: true,
						operations: [],
						touchedFiles: [],
					}
				},
				decide: async () => {
					decideCalled = true

					return makeDecisionResult('PORT_REQUIRED', 'Should not run.')
				},
				deliverResult: async () => {
					deliverCalled = true

					return { outcome: 'skipped' }
				},
				commentOnSourcePr: async input => {
					commentOutcomes.push(input.outcome)

					return undefined
				},
			},
		})

		expect(result.outcome).toBe('skipped_not_required')
		expect(deterministicCalled).toBe(false)
		expect(decideCalled).toBe(false)
		expect(deliverCalled).toBe(false)
		expect(commentOutcomes).toEqual([])
	})

	test('skips before deterministic operations for auto-port loop prevention', async () => {
		let deterministicCalled = false
		let decideCalled = false
		const commentOutcomes: string[] = []
		const sourceChange = makeSourceChange()

		sourceChange.pullRequest = {
			...sourceChange.pullRequest!,
			labels: ['auto-port'],
		}

		const result = await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			sourceWorkingDirectory: '/tmp/source-repo',
			stageOverrides: {
				readSourceContext: async () => sourceChange,
				resolvePluginConfig: () =>
					makePluginConfig({
						deterministicOperations: [
							{
								kind: 'sync',
								mode: 'copy',
								source: 'tests/manifest.json',
								target: 'tests/manifest.json',
							},
						],
					}),
				executeDeterministic: async () => {
					deterministicCalled = true

					return {
						changed: true,
						operations: [],
						touchedFiles: [],
					}
				},
				decide: async () => {
					decideCalled = true

					return makeDecisionResult('PORT_REQUIRED', 'Should not run.')
				},
				commentOnSourcePr: async input => {
					commentOutcomes.push(input.outcome)

					return 'https://github.com/acme/source-repo/pull/42#issuecomment-auto-port'
				},
			},
		})

		expect(result.outcome).toBe('skipped_not_required')
		expect(deterministicCalled).toBe(false)
		expect(decideCalled).toBe(false)
		expect(commentOutcomes).toEqual(['skipped_not_required'])
	})

	test('skips before deterministic operations for no-port label', async () => {
		let deterministicCalled = false
		let decideCalled = false
		const commentOutcomes: string[] = []
		const sourceChange = makeSourceChange()

		sourceChange.pullRequest = {
			...sourceChange.pullRequest!,
			labels: ['no-port'],
		}

		const result = await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			sourceWorkingDirectory: '/tmp/source-repo',
			stageOverrides: {
				readSourceContext: async () => sourceChange,
				resolvePluginConfig: () =>
					makePluginConfig({
						deterministicOperations: [
							{
								kind: 'sync',
								mode: 'copy',
								source: 'tests/manifest.json',
								target: 'tests/manifest.json',
							},
						],
					}),
				executeDeterministic: async () => {
					deterministicCalled = true

					return {
						changed: true,
						operations: [],
						touchedFiles: [],
					}
				},
				decide: async () => {
					decideCalled = true

					return makeDecisionResult('PORT_REQUIRED', 'Should not run.')
				},
				commentOnSourcePr: async input => {
					commentOutcomes.push(input.outcome)

					return 'https://github.com/acme/source-repo/pull/42#issuecomment-no-port'
				},
			},
		})

		expect(result.outcome).toBe('skipped_not_required')
		expect(deterministicCalled).toBe(false)
		expect(decideCalled).toBe(false)
		expect(commentOutcomes).toEqual(['skipped_not_required'])
	})

	test('routes PORT_NOT_REQUIRED with deterministic changes to PR delivery', async () => {
		let executeCalled = false
		let deliverCalled = false
		let deterministicCalled = false
		const commentOutcomes: string[] = []
		const deliverDecisions: string[] = []
		const pluginConfig = makePluginConfig({
			deterministicOperations: [
				{
					kind: 'sync',
					mode: 'mirror',
					source: 'tests/fixtures/**',
					target: 'tests/fixtures/',
				},
			],
		})

		const result = await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			sourceWorkingDirectory: '/tmp/source-repo',
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => pluginConfig,
				executeDeterministic: async input => {
					deterministicCalled = true
					expect(input.deterministicOperations).toEqual(
						pluginConfig.deterministicOperations,
					)

					return {
						changed: true,
						operations: pluginConfig.deterministicOperations,
						touchedFiles: ['tests/fixtures/example.json'],
					}
				},
				decide: async () =>
					makeDecisionResult('PORT_NOT_REQUIRED', 'No residual work remains.'),
				executePort: async () => {
					executeCalled = true

					return makeExecution(true)
				},
				deliverResult: async input => {
					deliverCalled = true
					deliverDecisions.push(input.decision.kind)
					expect(input.framingMode).toBe('deterministic_only')

					return {
						outcome: 'pr_opened',
						targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/222',
					}
				},
				commentOnSourcePr: async input => {
					commentOutcomes.push(input.outcome)

					return 'https://github.com/acme/source-repo/pull/42#issuecomment-det-1'
				},
			},
		})

		expect(result.outcome).toBe('pr_opened')
		expect(result.targetPullRequestUrl).toBe('https://github.com/acme/target-repo/pull/222')
		expect(deterministicCalled).toBe(true)
		expect(executeCalled).toBe(false)
		expect(deliverCalled).toBe(true)
		expect(deliverDecisions).toEqual(['PORT_NOT_REQUIRED'])
		expect(commentOutcomes).toEqual(['pr_opened'])
	})

	test('filters ignored files before decision and strips ignored diff sections', async () => {
		const tempDirectory = await mkdtemp(join(tmpdir(), 'repo-port-bot-'))
		const diffFilePath = join(tempDirectory, 'port-diff.patch')
		const diffContent = [
			'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
			'index 0000000..1111111 100644',
			'--- a/.github/workflows/ci.yml',
			'+++ b/.github/workflows/ci.yml',
			'@@ -1 +1 @@',
			'-name: old',
			'+name: new',
			'diff --git a/src/feature.ts b/src/feature.ts',
			'index 0000000..1111111 100644',
			'--- a/src/feature.ts',
			'+++ b/src/feature.ts',
			'@@ -1 +1 @@',
			'-old',
			'+new',
			'',
		].join('\n')

		await writeFile(diffFilePath, diffContent, 'utf8')

		const sourceChange: SourceChange = {
			...makeSourceChange(),
			files: [
				{
					path: '.github/workflows/ci.yml',
					status: 'modified',
					additions: 1,
					deletions: 1,
				},
				{
					path: 'src/feature.ts',
					status: 'modified',
					additions: 1,
					deletions: 1,
				},
			],
		}
		const pluginConfig = makePluginConfig({
			ignorePatterns: ['.github/**'],
		})
		let decidedFiles: string[] = []
		let decidedFiltering: unknown = undefined

		await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			diffFilePath,
			stageOverrides: {
				readSourceContext: async () => sourceChange,
				resolvePluginConfig: () => pluginConfig,
				decide: async context => {
					decidedFiles = context.sourceChange.files.map(file => file.path)
					decidedFiltering = context.filtering

					return makeDecisionResult(
						'PORT_NOT_REQUIRED',
						'Skipping because no changed files require porting.',
						'heuristic',
					)
				},
			},
		})

		const filteredDiff = await readFile(diffFilePath, 'utf8')

		expect(decidedFiles).toEqual(['src/feature.ts'])
		expect(decidedFiltering).toEqual({
			originalFileCount: 2,
			removedFileCount: 1,
		})
		expect(filteredDiff).not.toContain('.github/workflows/ci.yml')
		expect(filteredDiff).toContain('diff --git a/src/feature.ts b/src/feature.ts')
	})

	test('routes NEEDS_HUMAN to issue delivery and returns needs_human', async () => {
		let executeCalled = false
		const commentOutcomes: string[] = []

		const result = await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => makePluginConfig(),
				decide: async () => makeDecisionResult('NEEDS_HUMAN', 'Classifier is uncertain.'),
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

	test('routes NEEDS_HUMAN with deterministic changes to PR delivery', async () => {
		let executeCalled = false
		let deterministicCalled = false
		const commentOutcomes: string[] = []
		const deliverDecisions: string[] = []
		const pluginConfig = makePluginConfig({
			deterministicOperations: [
				{
					kind: 'sync',
					mode: 'copy',
					source: 'tests/manifest.json',
					target: 'tests/manifest.json',
				},
			],
		})

		const result = await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			sourceWorkingDirectory: '/tmp/source-repo',
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => pluginConfig,
				executeDeterministic: async input => {
					deterministicCalled = true
					expect(input.deterministicOperations).toEqual(
						pluginConfig.deterministicOperations,
					)

					return {
						changed: true,
						operations: pluginConfig.deterministicOperations,
						touchedFiles: ['tests/manifest.json'],
					}
				},
				decide: async () =>
					makeDecisionResult('NEEDS_HUMAN', 'Residual logic is ambiguous.'),
				executePort: async () => {
					executeCalled = true

					return makeExecution(true)
				},
				deliverResult: async input => {
					deliverDecisions.push(input.decision.kind)
					expect(input.framingMode).toBe('residual_handoff')

					return {
						outcome: 'pr_opened',
						targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/223',
					}
				},
				commentOnSourcePr: async input => {
					commentOutcomes.push(input.outcome)

					return 'https://github.com/acme/source-repo/pull/42#issuecomment-det-2'
				},
			},
		})

		expect(result.outcome).toBe('pr_opened')
		expect(result.targetPullRequestUrl).toBe('https://github.com/acme/target-repo/pull/223')
		expect(deterministicCalled).toBe(true)
		expect(executeCalled).toBe(false)
		expect(deliverDecisions).toEqual(['NEEDS_HUMAN'])
		expect(commentOutcomes).toEqual(['pr_opened'])
	})

	test('falls through to needs-human issue when NEEDS_HUMAN deterministic delivery is skipped', async () => {
		let executeCalled = false
		let deterministicCalled = false
		let deliverCallCount = 0
		const commentOutcomes: string[] = []
		const pluginConfig = makePluginConfig({
			deterministicOperations: [
				{
					kind: 'sync',
					mode: 'mirror',
					source: 'fixtures/**',
					target: 'fixtures/',
				},
			],
		})

		const result = await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			sourceWorkingDirectory: '/tmp/source-repo',
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => pluginConfig,
				executeDeterministic: async () => {
					deterministicCalled = true

					return {
						changed: true,
						operations: pluginConfig.deterministicOperations,
						touchedFiles: [],
					}
				},
				decide: async () =>
					makeDecisionResult('NEEDS_HUMAN', 'Residual logic is ambiguous.'),
				executePort: async () => {
					executeCalled = true

					return makeExecution(true)
				},
				deliverResult: async input => {
					deliverCallCount++

					if (deliverCallCount === 1) {
						expect(input.framingMode).toBe('residual_handoff')

						return { outcome: 'skipped' }
					}

					return {
						outcome: 'needs_human',
						followUpIssueUrl: 'https://github.com/acme/target-repo/issues/99',
					}
				},
				commentOnSourcePr: async input => {
					commentOutcomes.push(input.outcome)

					return 'https://github.com/acme/source-repo/pull/42#issuecomment-nh'
				},
			},
		})

		expect(result.outcome).toBe('needs_human')
		expect(result.followUpIssueUrl).toBe('https://github.com/acme/target-repo/issues/99')
		expect(deterministicCalled).toBe(true)
		expect(executeCalled).toBe(false)
		expect(deliverCallCount).toBe(2)
		expect(commentOutcomes).toEqual(['needs_human'])
	})

	test('returns draft_pr_opened when execution fails and delivery opens draft', async () => {
		const commentOutcomes: string[] = []

		const result = await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => makePluginConfig(),
				decide: async () => makeDecisionResult('PORT_REQUIRED', 'Port required.'),
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
			reader: createReaderFake(),
			writer: createWriterFake(),
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
		expect(result.decision.outcome.kind).toBe('NEEDS_HUMAN')
		expect(result.decision.trace.source).toBe('fallback')
		expect(result.summary).toContain('Engine failure: read context exploded')
		expect(result.durationMs).toBeGreaterThan(0)
	})

	test('returns failed and continues when source comment posting throws', async () => {
		const result = await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => makePluginConfig(),
				decide: async () => {
					throw new Error('decider exploded')
				},
				commentOnSourcePr: async () => {
					throw new Error('comment post failed')
				},
			},
		})

		expect(result.outcome).toBe('failed')
		expect(result.decision.outcome.kind).toBe('NEEDS_HUMAN')
		expect(result.summary).toContain('Engine failure: decider exploded')
	})

	test('auto-fetches port-bot.json when not provided', async () => {
		let fetchCalled = false
		let resolvedPortBotJson: unknown = undefined

		await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
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
				decide: async () =>
					makeDecisionResult(
						'PORT_NOT_REQUIRED',
						'Skipping because no-port is set.',
						'heuristic',
					),
			},
		})

		expect(fetchCalled).toBe(true)
		expect(resolvedPortBotJson).toEqual({ target: 'acme/target-repo' })
	})

	test('skips auto-fetch when skipPortBotJson is true', async () => {
		let fetchCalled = false
		let resolvedPortBotJson: unknown = undefined

		await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
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
				decide: async () =>
					makeDecisionResult(
						'PORT_NOT_REQUIRED',
						'Skipping because no-port is set.',
						'heuristic',
					),
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
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			logger,
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => makePluginConfig(),
				decide: async () =>
					makeDecisionResult(
						'PORT_NOT_REQUIRED',
						'Skipping because no-port is set.',
						'heuristic',
					),
			},
		})

		expect(infoMessages.some(message => message.includes('stage=context'))).toBe(true)
		expect(infoMessages.some(message => message.includes('stage=config'))).toBe(true)
		expect(infoMessages.some(message => message.includes('stage=deterministic'))).toBe(true)
		expect(infoMessages.some(message => message.includes('stage=decision'))).toBe(true)
		expect(infoMessages.some(message => message.includes('outcome=skipped_not_required'))).toBe(
			true,
		)
	})

	test('routes decision streamed messages to info/debug logs', async () => {
		const infoMessages: string[] = []
		const debugMessages: string[] = []
		const logger: Logger = {
			error: () => {},
			warn: () => {},
			info: message => infoMessages.push(message),
			debug: message => debugMessages.push(message),
			group: () => {},
			groupEnd: () => {},
		}

		await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			sourceWorkingDirectory: '/tmp/source-repo',
			logger,
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => makePluginConfig(),
				decide: async (_context, options) => {
					options?.onMessage?.({
						kind: 'thinking',
						text: 'Checking changed files.',
					})
					options?.onMessage?.({
						kind: 'tool_start',
						toolName: 'Read',
						toolInput: { file_path: '/tmp/target-repo/src/example.ts' },
					})
					options?.onMessage?.({
						kind: 'tool_end',
						toolName: 'Read',
						durationMs: 7,
					})
					options?.onMessage?.({
						kind: 'text',
						text: 'Classifier summary.',
					})

					return makeDecisionResult(
						'PORT_NOT_REQUIRED',
						'Skipping because no-port is set.',
						'classifier',
					)
				},
			},
		})

		expect(
			infoMessages.some(message =>
				message.includes('stage=decision tool=Read file=src/example.ts'),
			),
		).toBe(true)
		expect(
			debugMessages.some(message =>
				message.includes('stage=decision thinking=Checking changed files.'),
			),
		).toBe(true)
		expect(
			debugMessages.some(message =>
				message.includes('stage=decision tool=Read toolDurationMs=7'),
			),
		).toBe(true)
		expect(
			debugMessages.some(message =>
				message.includes('stage=decision text=Classifier summary.'),
			),
		).toBe(true)
	})

	test('aggregates telemetry totals and forwards include-cost-telemetry', async () => {
		let deliverIncludeCostTelemetry: boolean | undefined = undefined
		let notifyIncludeCostTelemetry: boolean | undefined = undefined

		const result = await runPort({
			reader: createReaderFake(),
			writer: createWriterFake(),
			agentProvider: createAgentProvider(),
			sourceRepo: SOURCE_REPO,
			commitSha: 'abc123',
			targetWorkingDirectory: '/tmp/target-repo',
			includeCostTelemetry: false,
			stageOverrides: {
				readSourceContext: async () => makeSourceChange(),
				resolvePluginConfig: () => makePluginConfig(),
				decide: async () => ({
					outcome: makeDecision('PORT_REQUIRED', 'Port required.'),
					trace: {
						source: 'classifier',
						toolCallLog: [],
						events: [],
						costUsd: 0.12,
						usage: {
							inputTokens: 1000,
							outputTokens: 200,
							cacheCreationInputTokens: 100,
							cacheReadInputTokens: 1200,
						},
					},
				}),
				executePort: async () => ({
					outcome: {
						status: 'SUCCEEDED',
						attempts: 2,
						touchedFiles: ['src/ported.ts'],
					},
					trace: {
						toolCallLog: [],
						events: [],
						attempts: [
							{
								attempt: 1,
								status: 'VALIDATION_FAILED',
								touchedFiles: ['src/ported.ts'],
								validation: [],
								trace: {
									toolCallLog: [],
									events: [],
									costUsd: 1,
									usage: {
										inputTokens: 2000,
										outputTokens: 500,
										cacheCreationInputTokens: 200,
										cacheReadInputTokens: 1000,
									},
								},
							},
							{
								attempt: 2,
								status: 'VALIDATED',
								touchedFiles: ['src/ported.ts'],
								validation: [],
								trace: {
									toolCallLog: [],
									events: [],
									costUsd: 0.5,
									usage: {
										inputTokens: 1000,
										outputTokens: 200,
										cacheCreationInputTokens: 100,
										cacheReadInputTokens: 300,
									},
								},
							},
						],
					},
				}),
				deliverResult: async input => {
					deliverIncludeCostTelemetry = input.includeCostTelemetry

					return {
						outcome: 'pr_opened',
						targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/777',
					}
				},
				commentOnSourcePr: async input => {
					notifyIncludeCostTelemetry = input.includeCostTelemetry

					return 'https://github.com/acme/source-repo/pull/42#issuecomment-telemetry'
				},
			},
		})

		expect(result.telemetry).toEqual({
			decision: {
				costUsd: 0.12,
				usage: {
					inputTokens: 1000,
					outputTokens: 200,
					cacheCreationInputTokens: 100,
					cacheReadInputTokens: 1200,
				},
			},
			execution: {
				costUsd: 1.5,
				usage: {
					inputTokens: 3000,
					outputTokens: 700,
					cacheCreationInputTokens: 300,
					cacheReadInputTokens: 1300,
				},
			},
			total: {
				costUsd: 1.62,
				usage: {
					inputTokens: 4000,
					outputTokens: 900,
					cacheCreationInputTokens: 400,
					cacheReadInputTokens: 2500,
				},
			},
		})
		expect(deliverIncludeCostTelemetry === false).toBe(true)
		expect(notifyIncludeCostTelemetry === false).toBe(true)
	})
})

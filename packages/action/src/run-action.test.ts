import { describe, expect, test } from 'bun:test'

import { runAction } from './run-action.ts'

import type {
	AgentProvider,
	GitHubReader,
	GitHubWriter,
	PortRunResult,
	RepoRef,
} from '@repo-port-bot/engine'
import type { Logger } from '@repo-port-bot/logger'

const SOURCE_REPO: RepoRef = {
	owner: 'acme',
	name: 'source-repo',
	defaultBranch: 'main',
}

/**
 * Build a no-op GitHubReader fake.
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
 * Build a no-op GitHubWriter fake.
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

describe('runAction', () => {
	test('wires split source/target tokens through runPort', async () => {
		const sourceReader = createReaderFake()
		const targetWriter = createWriterFake()
		const runPortCalls: unknown[] = []
		const portResult: PortRunResult = {
			runId: 'run-1',
			outcome: 'pr_opened',
			decision: {
				kind: 'PORT_REQUIRED',
				reason: 'Required',
			},
			targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/1',
			summary: 'Port PR opened.',
			durationMs: 100,
		}

		const result = await runAction({
			parseInputs: () => ({
				sourceRepo: SOURCE_REPO,
				commitSha: 'abc123',
				targetRepo: {
					owner: 'acme',
					name: 'target-repo',
				},
				targetDefaultBranch: 'main',
				llmApiKey: 'llm-key',
				model: 'claude-sonnet-4-6',
				maxAttempts: 3,
				maxTurns: 50,
				maxBudgetUsd: undefined,
				validationCommands: ['bun run check'],
				pathMappings: { 'src/': 'src/' },
				namingConventions: undefined,
				prompt: undefined,
				skipPortBotJson: true,
				logLevel: 'debug',
				effectiveSourceToken: 'source-token',
				effectiveTargetToken: 'target-token',
			}),
			cloneSourceRepo: async () => ({
				sourceWorkingDirectory: '/tmp/source-repo',
				diffFilePath: '/tmp/source-repo/port-diff.patch',
			}),
			cloneTargetRepo: async () => '/tmp/target-repo',
			createReader: token => (token === 'source-token' ? sourceReader : createReaderFake()),
			createWriter: token => (token === 'target-token' ? targetWriter : createWriterFake()),
			createAgentProvider: () =>
				({
					async decidePort() {
						return {
							required: true,
							reason: 'Required',
						}
					},
					async executePort() {
						return {
							touchedFiles: [],
							complete: true,
							toolCallLog: [],
							events: [],
						}
					},
				}) as AgentProvider,
			createLogger: () =>
				({
					error: () => {},
					warn: () => {},
					info: () => {},
					debug: () => {},
					group: () => {},
					groupEnd: () => {},
				}) as Logger,
			readSourceContext: async input => ({
				mergedCommitSha: input.commitSha,
				pullRequest: undefined,
				files: [],
			}),
			deliverResult: async () => ({
				outcome: 'pr_opened',
				targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/1',
			}),
			runPort: async input => {
				runPortCalls.push(input)

				const stageOverrides = input.stageOverrides!

				const readResult = await stageOverrides.readSourceContext!({
					reader: createReaderFake(),
					owner: 'acme',
					repo: 'source-repo',
					commitSha: 'abc123',
				})
				const deliverResult = await stageOverrides.deliverResult!({
					writer: createWriterFake(),
					context: {
						runId: 'run-1',
						startedAt: new Date().toISOString(),
						sourceRepo: SOURCE_REPO,
						sourceChange: readResult,
						pluginConfig: {
							targetRepo: {
								owner: 'acme',
								name: 'target-repo',
								defaultBranch: 'main',
							},
							ignorePatterns: [],
							validationCommands: [],
							pathMappings: {},
						},
					},
					decision: {
						kind: 'PORT_REQUIRED',
						reason: 'Required',
					},
					targetWorkingDirectory: '/tmp/target-repo',
				})

				expect(readResult.mergedCommitSha).toBe('abc123')
				expect(deliverResult.outcome).toBe('pr_opened')

				return portResult
			},
		})

		expect(runPortCalls).toHaveLength(1)

		const call = runPortCalls[0] as {
			reader: GitHubReader
			writer: GitHubWriter
			sourceRepo: RepoRef
			commitSha: string
			targetWorkingDirectory: string
			sourceWorkingDirectory?: string
			diffFilePath?: string
			maxAttempts: number
			skipPortBotJson: boolean
			builtInConfig: {
				targetRepo: RepoRef
				validationCommands: string[]
				pathMappings: Record<string, string>
			}
		}

		expect(call.reader).toBe(sourceReader)
		expect(call.writer).toBe(targetWriter)
		expect(call.sourceRepo).toEqual(SOURCE_REPO)
		expect(call.commitSha).toBe('abc123')
		expect(call.targetWorkingDirectory).toBe('/tmp/target-repo')
		expect(call.sourceWorkingDirectory).toBe('/tmp/source-repo')
		expect(call.diffFilePath).toBe('/tmp/source-repo/port-diff.patch')
		expect(call.maxAttempts).toBe(3)
		expect(call.skipPortBotJson).toBe(true)
		expect(call.builtInConfig.targetRepo).toEqual({
			owner: 'acme',
			name: 'target-repo',
			defaultBranch: 'main',
		})
		expect(result).toEqual(portResult)
	})
})

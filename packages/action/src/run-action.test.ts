import { describe, expect, test } from 'bun:test'

import { runAction } from './run-action.ts'

import type { Octokit } from '@octokit/rest'
import type { AgentProvider, PortRunResult, RepoRef } from '@repo-port-bot/engine'

const SOURCE_REPO: RepoRef = {
	owner: 'acme',
	name: 'source-repo',
	defaultBranch: 'main',
}

describe('runAction', () => {
	test('wires split source/target tokens through runPort stage overrides', async () => {
		const sourceOctokit = { kind: 'source' } as unknown as Octokit
		const targetOctokit = { kind: 'target' } as unknown as Octokit
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
				effectiveSourceToken: 'source-token',
				effectiveTargetToken: 'target-token',
			}),
			cloneSourceRepo: async () => ({
				sourceWorkingDirectory: '/tmp/source-repo',
				diffFilePath: '/tmp/source-repo/port-diff.patch',
			}),
			cloneTargetRepo: async () => '/tmp/target-repo',
			createOctokit: token => (token === 'source-token' ? sourceOctokit : targetOctokit),
			createAgentProvider: () =>
				({
					async executePort() {
						return {
							touchedFiles: [],
							complete: true,
							toolCallLog: [],
						}
					},
				}) as AgentProvider,
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
					octokit: {} as Octokit,
					owner: 'acme',
					repo: 'source-repo',
					commitSha: 'abc123',
				})
				const deliverResult = await stageOverrides.deliverResult!({
					octokit: {} as Octokit,
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
			octokit: Octokit
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

		expect(call.octokit).toBe(sourceOctokit)
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

import { describe, expect, test } from 'bun:test'

import { commentOnSourcePr, deliverResult } from './deliver.ts'

import type { Octokit } from '@octokit/rest'

import type {
	ExecutionResult,
	PortContext,
	PortDecision,
	RepoRef,
	ValidationCommandResult,
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

const SOURCE_PULL_REQUEST_NUMBER = 42

/**
 * Build a synthetic port context for delivery tests.
 *
 * @returns Port context fixture.
 */
function makeContext(): PortContext {
	return {
		runId: 'run-1',
		startedAt: '2026-03-03T00:00:00.000Z',
		sourceRepo: SOURCE_REPO,
		sourceChange: {
			mergedCommitSha: 'abc1234567',
			pullRequest: {
				number: SOURCE_PULL_REQUEST_NUMBER,
				title: 'Sync feature',
				body: '',
				url: 'https://github.com/acme/source-repo/pull/42',
				labels: [],
			},
			files: [{ path: 'src/file.ts', status: 'modified', additions: 3, deletions: 1 }],
		},
		pluginConfig: {
			targetRepo: TARGET_REPO,
			ignorePatterns: [],
			validationCommands: ['bun run check'],
			pathMappings: {},
		},
	}
}

/**
 * Build decision fixture.
 *
 * @param kind - Decision kind.
 * @returns Decision fixture.
 */
function makeDecision(kind: PortDecision['kind']): PortDecision {
	return {
		kind,
		reason: 'Decision reason',
		signals: ['signal-a'],
	}
}

/**
 * Build validation fixture list.
 *
 * @param ok - Validation pass/fail state.
 * @returns Validation fixture list.
 */
function makeValidation(ok: boolean): ValidationCommandResult[] {
	return [
		{
			command: 'bun run check',
			ok,
			exitCode: ok ? 0 : 1,
			stdout: ok ? 'ok' : '',
			stderr: ok ? '' : 'failed',
			durationMs: 100,
		},
	]
}

/**
 * Build execution fixture for success/failure paths.
 *
 * @param success - Whether execution succeeded.
 * @returns Execution fixture.
 */
function makeExecution(success: boolean): ExecutionResult {
	return {
		success,
		attempts: success ? 1 : 2,
		history: [
			{
				attempt: success ? 1 : 2,
				touchedFiles: ['src/file.ts'],
				validation: makeValidation(success),
				notes: success ? 'done' : 'failed',
				toolCallLog: [],
			},
		],
		touchedFiles: ['src/file.ts'],
		failureReason: success ? undefined : 'Validation failed after retries.',
	}
}

/**
 * Build an Octokit mock and capture outbound API calls.
 *
 * @returns Mock octokit plus captured call arrays.
 */
function createOctokitMock(): {
	octokit: Octokit
	pullsCreateCalls: Record<string, unknown>[]
	issuesCreateCalls: Record<string, unknown>[]
	addLabelsCalls: Record<string, unknown>[]
	createCommentCalls: Record<string, unknown>[]
} {
	const pullsCreateCalls: Record<string, unknown>[] = []
	const issuesCreateCalls: Record<string, unknown>[] = []
	const addLabelsCalls: Record<string, unknown>[] = []
	const createCommentCalls: Record<string, unknown>[] = []

	const octokit = {
		rest: {
			pulls: {
				create: async (params: Record<string, unknown>) => {
					pullsCreateCalls.push(params)

					return {
						data: {
							number: 901,
							html_url: 'https://github.com/acme/target-repo/pull/901',
						},
					}
				},
			},
			issues: {
				create: async (params: Record<string, unknown>) => {
					issuesCreateCalls.push(params)

					return {
						data: {
							number: 777,
							html_url: 'https://github.com/acme/target-repo/issues/777',
						},
					}
				},
				addLabels: async (params: Record<string, unknown>) => {
					addLabelsCalls.push(params)

					return { data: {} }
				},
				createComment: async (params: Record<string, unknown>) => {
					createCommentCalls.push(params)

					return {
						data: {
							html_url: 'https://github.com/acme/source-repo/pull/42#issuecomment-1',
						},
					}
				},
			},
		},
	} as unknown as Octokit

	return { octokit, pullsCreateCalls, issuesCreateCalls, addLabelsCalls, createCommentCalls }
}

describe('deliverResult', () => {
	test('returns skipped for PORT_NOT_REQUIRED without side effects', async () => {
		const { octokit, pullsCreateCalls, issuesCreateCalls, addLabelsCalls } = createOctokitMock()
		const commandCalls: string[][] = []

		const result = await deliverResult({
			octokit,
			context: makeContext(),
			decision: makeDecision('PORT_NOT_REQUIRED'),
			targetWorkingDirectory: '/tmp/unused',
			runCommand: async ({ command }) => {
				commandCalls.push(command)

				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})

		expect(result).toEqual({ outcome: 'skipped' })
		expect(commandCalls).toEqual([])
		expect(pullsCreateCalls).toEqual([])
		expect(issuesCreateCalls).toEqual([])
		expect(addLabelsCalls).toEqual([])
	})

	test('creates needs-human issue and does not run git for NEEDS_HUMAN', async () => {
		const { octokit, pullsCreateCalls, issuesCreateCalls, addLabelsCalls } = createOctokitMock()
		let commandInvoked = false

		const result = await deliverResult({
			octokit,
			context: makeContext(),
			decision: makeDecision('NEEDS_HUMAN'),
			targetWorkingDirectory: '/tmp/unused',
			runCommand: async () => {
				commandInvoked = true

				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})

		expect(result.outcome).toBe('needs_human')
		expect(result.followUpIssueUrl).toContain('/issues/777')
		expect(commandInvoked).toBe(false)
		expect(issuesCreateCalls[0]?.labels).toEqual(['needs-human'])
		expect(pullsCreateCalls).toEqual([])
		expect(addLabelsCalls).toEqual([])
	})

	test('creates ready PR with auto-port label for successful execution', async () => {
		const { octokit, pullsCreateCalls, addLabelsCalls } = createOctokitMock()
		const commandCalls: string[][] = []

		const result = await deliverResult({
			octokit,
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			execution: makeExecution(true),
			targetWorkingDirectory: '/tmp/target-repo',
			runCommand: async ({ command }) => {
				commandCalls.push(command)

				if (command.join(' ') === 'git diff --cached --quiet') {
					return { exitCode: 1, stdout: '', stderr: '' }
				}

				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})

		expect(result.outcome).toBe('pr_opened')
		expect(result.targetPullRequestUrl).toContain('/pull/901')
		expect(pullsCreateCalls[0]?.draft).toBe(false)
		expect(addLabelsCalls[0]?.labels).toEqual(['auto-port'])
		expect(commandCalls.map(call => call.join(' '))).toEqual([
			'git checkout -b port/source-repo/42-abc1234',
			'git add -A',
			'git diff --cached --quiet',
			'git commit -m Port: Sync feature (#42)\n\nSource-PR: https://github.com/acme/source-repo/pull/42\nPorted-By: repo-port-bot',
			'git push -u origin port/source-repo/42-abc1234',
		])
	})

	test('creates draft PR with stalled label when execution fails', async () => {
		const { octokit, pullsCreateCalls, addLabelsCalls } = createOctokitMock()

		const result = await deliverResult({
			octokit,
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			execution: makeExecution(false),
			targetWorkingDirectory: '/tmp/target-repo',
			runCommand: async ({ command }) => {
				if (command.join(' ') === 'git diff --cached --quiet') {
					return { exitCode: 1, stdout: '', stderr: '' }
				}

				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})

		expect(result.outcome).toBe('draft_pr_opened')
		expect(pullsCreateCalls[0]?.draft).toBe(true)
		expect(addLabelsCalls[0]?.labels).toEqual(['auto-port', 'port-stalled'])
	})

	test('throws when PORT_REQUIRED is delivered without execution result', async () => {
		const { octokit } = createOctokitMock()

		await expect(
			deliverResult({
				octokit,
				context: makeContext(),
				decision: makeDecision('PORT_REQUIRED'),
				targetWorkingDirectory: '/tmp/target-repo',
				runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
			}),
		).rejects.toThrow('Execution result is required')
	})
})

describe('commentOnSourcePr', () => {
	test('creates comment on source pull request and returns comment URL', async () => {
		const { octokit, createCommentCalls } = createOctokitMock()
		const context = makeContext()

		const commentUrl = await commentOnSourcePr({
			octokit,
			sourceRepo: SOURCE_REPO,
			pullRequestNumber: 42,
			context,
			outcome: 'pr_opened',
			targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/901',
			runId: 'run-1',
		})

		expect(commentUrl).toBe('https://github.com/acme/source-repo/pull/42#issuecomment-1')
		expect(createCommentCalls).toHaveLength(1)
		expect(createCommentCalls[0]?.owner).toBe('acme')
		expect(createCommentCalls[0]?.repo).toBe('source-repo')
		expect(createCommentCalls[0]?.issue_number).toBe(SOURCE_PULL_REQUEST_NUMBER)
		expect(String(createCommentCalls[0]?.body)).toContain(
			'Port PR opened: https://github.com/acme/target-repo/pull/901',
		)
	})

	test('returns undefined when comment creation throws', async () => {
		const context = makeContext()
		const octokit = {
			rest: {
				issues: {
					createComment: async () => {
						throw new Error('rate limited')
					},
				},
			},
		} as unknown as Octokit

		const commentUrl = await commentOnSourcePr({
			octokit,
			sourceRepo: SOURCE_REPO,
			pullRequestNumber: 42,
			context,
			outcome: 'failed',
			runId: 'run-2',
		})

		expect(commentUrl).toBeUndefined()
	})
})

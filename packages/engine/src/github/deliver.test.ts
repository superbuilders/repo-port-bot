import { describe, expect, test } from 'bun:test'

import { commentOnSourcePr, deliverResult } from './deliver.ts'

import type {
	CreatedIssue,
	CreatedPullRequest,
	DeterministicPhaseResult,
	ExecutePortResult,
	GitHubWriter,
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
const EXISTING_PORT_PR_NUMBER = 555
const EXISTING_NEEDS_HUMAN_ISSUE_NUMBER = 778
const EXISTING_SOURCE_COMMENT_ID = 101

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
			deterministicOperations: [],
			pathMappings: {},
		},
		deterministic: {
			changed: false,
			operations: [],
			touchedFiles: [],
		},
	}
}

/**
 * Build deterministic phase fixture.
 *
 * @param changed - Whether deterministic operations changed files.
 * @returns Deterministic phase fixture.
 */
function makeDeterministic(changed: boolean): DeterministicPhaseResult {
	return {
		changed,
		operations: [
			{
				kind: 'sync',
				mode: 'mirror',
				source: 'tests/fixtures/**',
				target: 'tests/fixtures/',
			},
		],
		touchedFiles: changed ? ['tests/fixtures/example.json'] : [],
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
function makeExecution(success: boolean): ExecutePortResult {
	return {
		outcome: {
			status: success ? 'SUCCEEDED' : 'VALIDATION_FAILED',
			attempts: success ? 1 : 2,
			touchedFiles: ['src/file.ts'],
			reason: success ? undefined : 'Validation failed after retries.',
		},
		trace: {
			notes: success ? 'done' : 'failed',
			toolCallLog: [],
			events: [],
			attempts: [
				{
					attempt: success ? 1 : 2,
					status: success ? 'VALIDATED' : 'VALIDATION_FAILED',
					touchedFiles: ['src/file.ts'],
					validation: makeValidation(success),
					trace: {
						notes: success ? 'done' : 'failed',
						toolCallLog: [],
						events: [],
					},
				},
			],
		},
	}
}

/**
 * Build a GitHubWriter fake and capture outbound calls.
 *
 * @returns Fake writer plus captured call arrays.
 */
function createWriterFake(): {
	writer: GitHubWriter
	createPrCalls: unknown[]
	createIssueCalls: unknown[]
	findNeedsHumanIssueCalls: unknown[]
	updateIssueCalls: unknown[]
	addLabelsCalls: unknown[]
	createCommentCalls: unknown[]
	updateCommentCalls: unknown[]
	listCommentsCalls: unknown[]
} {
	const createPrCalls: unknown[] = []
	const createIssueCalls: unknown[] = []
	const findNeedsHumanIssueCalls: unknown[] = []
	const updateIssueCalls: unknown[] = []
	const addLabelsCalls: unknown[] = []
	const createCommentCalls: unknown[] = []
	const updateCommentCalls: unknown[] = []
	const listCommentsCalls: unknown[] = []

	const writer: GitHubWriter = {
		async createPullRequest(params): Promise<CreatedPullRequest> {
			createPrCalls.push(params)

			return { number: 901, url: 'https://github.com/acme/target-repo/pull/901' }
		},
		async createIssue(params): Promise<CreatedIssue> {
			createIssueCalls.push(params)

			return { number: 777, url: 'https://github.com/acme/target-repo/issues/777' }
		},
		async findNeedsHumanIssueForSource(params) {
			findNeedsHumanIssueCalls.push(params)

			return undefined
		},
		async updateIssue(params) {
			updateIssueCalls.push(params)
		},
		async addLabels(params): Promise<void> {
			addLabelsCalls.push(params)
		},
		async createComment(params): Promise<string | undefined> {
			createCommentCalls.push(params)

			return 'https://github.com/acme/source-repo/pull/42#issuecomment-1'
		},
		async updateComment(params): Promise<string | undefined> {
			updateCommentCalls.push(params)

			return 'https://github.com/acme/source-repo/pull/42#issuecomment-1'
		},
		async listComments(params) {
			listCommentsCalls.push(params)

			return []
		},
	}

	return {
		writer,
		createPrCalls,
		createIssueCalls,
		findNeedsHumanIssueCalls,
		updateIssueCalls,
		addLabelsCalls,
		createCommentCalls,
		updateCommentCalls,
		listCommentsCalls,
	}
}

describe('deliverResult', () => {
	test('returns skipped for NO_AGENT_PORT_NEEDED without side effects', async () => {
		const { writer, createPrCalls, createIssueCalls, addLabelsCalls } = createWriterFake()
		const commandCalls: string[][] = []

		const result = await deliverResult({
			writer,
			context: makeContext(),
			decision: makeDecision('NO_AGENT_PORT_NEEDED'),
			targetWorkingDirectory: '/tmp/unused',
			runCommand: async ({ command }) => {
				commandCalls.push(command)

				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})

		expect(result).toEqual({ outcome: 'skipped' })
		expect(commandCalls).toEqual([])
		expect(createPrCalls).toEqual([])
		expect(createIssueCalls).toEqual([])
		expect(addLabelsCalls).toEqual([])
	})

	test('creates needs-human issue and does not run git for NEEDS_HUMAN', async () => {
		const {
			writer,
			createPrCalls,
			createIssueCalls,
			findNeedsHumanIssueCalls,
			addLabelsCalls,
		} = createWriterFake()
		let commandInvoked = false

		const result = await deliverResult({
			writer,
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
		expect(findNeedsHumanIssueCalls).toHaveLength(1)
		expect((createIssueCalls[0] as { labels: string[] }).labels).toEqual(['needs-human'])
		expect(createPrCalls).toEqual([])
		expect(addLabelsCalls).toEqual([])
	})

	test('updates existing needs-human issue instead of creating duplicate', async () => {
		const {
			writer,
			createIssueCalls,
			findNeedsHumanIssueCalls,
			updateIssueCalls,
			addLabelsCalls,
		} = createWriterFake()

		writer.findNeedsHumanIssueForSource = async params => {
			findNeedsHumanIssueCalls.push(params)

			return {
				number: EXISTING_NEEDS_HUMAN_ISSUE_NUMBER,
				url: `https://github.com/acme/target-repo/issues/${String(EXISTING_NEEDS_HUMAN_ISSUE_NUMBER)}`,
			}
		}

		const result = await deliverResult({
			writer,
			context: makeContext(),
			decision: makeDecision('NEEDS_HUMAN'),
			targetWorkingDirectory: '/tmp/unused',
			runCommand: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
		})

		expect(result.outcome).toBe('needs_human')
		expect(result.followUpIssueUrl).toBe(
			`https://github.com/acme/target-repo/issues/${String(EXISTING_NEEDS_HUMAN_ISSUE_NUMBER)}`,
		)
		expect(findNeedsHumanIssueCalls).toHaveLength(1)
		expect(createIssueCalls).toEqual([])
		expect(updateIssueCalls).toHaveLength(1)
		expect((updateIssueCalls[0] as { issueNumber: number }).issueNumber).toBe(
			EXISTING_NEEDS_HUMAN_ISSUE_NUMBER,
		)
		expect((addLabelsCalls[0] as { issueNumber: number }).issueNumber).toBe(
			EXISTING_NEEDS_HUMAN_ISSUE_NUMBER,
		)
		expect((addLabelsCalls[0] as { labels: string[] }).labels).toEqual(['needs-human'])
	})

	test('creates ready PR with auto-port label for successful execution', async () => {
		const { writer, createPrCalls, addLabelsCalls } = createWriterFake()
		const commandCalls: string[][] = []

		const result = await deliverResult({
			writer,
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
		expect((createPrCalls[0] as { draft: boolean }).draft).toBe(false)
		expect((addLabelsCalls[0] as { labels: string[] }).labels).toEqual(['auto-port'])
		expect(commandCalls.map(call => call.join(' '))).toEqual([
			'git checkout -b port/source-repo/42-abc1234',
			'git add -A',
			'git diff --cached --quiet',
			'git commit -m Port: Sync feature\n\nSource-PR: https://github.com/acme/source-repo/pull/42\nSource-Commit: abc1234567\nPorted-By: repo-port-bot',
			'git push --force -u origin port/source-repo/42-abc1234',
		])
	})

	test('creates draft PR with stalled label when execution fails', async () => {
		const { writer, createPrCalls, addLabelsCalls } = createWriterFake()

		const result = await deliverResult({
			writer,
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
		expect((createPrCalls[0] as { draft: boolean }).draft).toBe(true)
		expect((addLabelsCalls[0] as { labels: string[] }).labels).toEqual([
			'auto-port',
			'port-stalled',
		])
	})

	test('opens deterministic-only ready PR for NO_AGENT_PORT_NEEDED when deterministic changed and validation passes', async () => {
		const { writer, createPrCalls, addLabelsCalls, createIssueCalls } = createWriterFake()
		const context = makeContext()

		context.deterministic = makeDeterministic(true)

		const result = await deliverResult({
			writer,
			context,
			deterministic: context.deterministic,
			decision: makeDecision('NO_AGENT_PORT_NEEDED'),
			validation: makeValidation(true),
			targetWorkingDirectory: '/tmp/target-repo',
			runCommand: async ({ command }) => {
				if (command.join(' ') === 'git status --short -- tests/fixtures/example.json') {
					return { exitCode: 0, stdout: '?? tests/fixtures/example.json\n', stderr: '' }
				}

				if (command.join(' ') === 'git diff --cached --quiet') {
					return { exitCode: 1, stdout: '', stderr: '' }
				}

				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})

		expect(result.outcome).toBe('pr_opened')
		expect(result.targetPullRequestUrl).toContain('/pull/901')
		expect(createIssueCalls).toEqual([])
		expect((createPrCalls[0] as { draft: boolean }).draft).toBe(false)
		expect((addLabelsCalls[0] as { labels: string[] }).labels).toEqual(['auto-port'])
	})

	test('opens deterministic-only draft PR for NO_AGENT_PORT_NEEDED when deterministic changed and validation fails', async () => {
		const { writer, createPrCalls, addLabelsCalls, createIssueCalls } = createWriterFake()
		const context = makeContext()

		context.deterministic = makeDeterministic(true)

		const result = await deliverResult({
			writer,
			context,
			deterministic: context.deterministic,
			decision: makeDecision('NO_AGENT_PORT_NEEDED'),
			validation: makeValidation(false),
			targetWorkingDirectory: '/tmp/target-repo',
			runCommand: async ({ command }) => {
				if (command.join(' ') === 'git status --short -- tests/fixtures/example.json') {
					return { exitCode: 0, stdout: '?? tests/fixtures/example.json\n', stderr: '' }
				}

				if (command.join(' ') === 'git diff --cached --quiet') {
					return { exitCode: 1, stdout: '', stderr: '' }
				}

				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})

		expect(result.outcome).toBe('draft_pr_opened')
		expect(createIssueCalls).toEqual([])
		expect((createPrCalls[0] as { draft: boolean }).draft).toBe(true)
		expect((addLabelsCalls[0] as { labels: string[] }).labels).toEqual([
			'auto-port',
			'port-stalled',
		])
	})

	test('opens residual-handoff ready PR for NEEDS_HUMAN when deterministic changed and validation passes', async () => {
		const { writer, createPrCalls, createIssueCalls } = createWriterFake()
		const context = makeContext()

		context.deterministic = makeDeterministic(true)

		const result = await deliverResult({
			writer,
			context,
			deterministic: context.deterministic,
			decision: makeDecision('NEEDS_HUMAN'),
			validation: makeValidation(true),
			targetWorkingDirectory: '/tmp/target-repo',
			runCommand: async ({ command }) => {
				if (command.join(' ') === 'git status --short -- tests/fixtures/example.json') {
					return { exitCode: 0, stdout: '?? tests/fixtures/example.json\n', stderr: '' }
				}

				if (command.join(' ') === 'git diff --cached --quiet') {
					return { exitCode: 1, stdout: '', stderr: '' }
				}

				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})

		expect(result.outcome).toBe('pr_opened')
		expect(result.targetPullRequestUrl).toContain('/pull/901')
		expect(createIssueCalls).toEqual([])
		expect((createPrCalls[0] as { draft: boolean }).draft).toBe(false)
	})

	test('opens residual-handoff draft PR for NEEDS_HUMAN when deterministic changed and validation fails', async () => {
		const { writer, createPrCalls, createIssueCalls } = createWriterFake()
		const context = makeContext()

		context.deterministic = makeDeterministic(true)

		const result = await deliverResult({
			writer,
			context,
			deterministic: context.deterministic,
			decision: makeDecision('NEEDS_HUMAN'),
			validation: makeValidation(false),
			targetWorkingDirectory: '/tmp/target-repo',
			runCommand: async ({ command }) => {
				if (command.join(' ') === 'git status --short -- tests/fixtures/example.json') {
					return { exitCode: 0, stdout: '?? tests/fixtures/example.json\n', stderr: '' }
				}

				if (command.join(' ') === 'git diff --cached --quiet') {
					return { exitCode: 1, stdout: '', stderr: '' }
				}

				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})

		expect(result.outcome).toBe('draft_pr_opened')
		expect(createIssueCalls).toEqual([])
		expect((createPrCalls[0] as { draft: boolean }).draft).toBe(true)
	})

	test('skips delivery when target-side diff guard finds no changes', async () => {
		const { writer, createPrCalls, createIssueCalls } = createWriterFake()
		const context = makeContext()

		context.deterministic = makeDeterministic(true)

		const result = await deliverResult({
			writer,
			context,
			deterministic: context.deterministic,
			decision: makeDecision('NO_AGENT_PORT_NEEDED'),
			validation: makeValidation(true),
			targetWorkingDirectory: '/tmp/target-repo',
			runCommand: async ({ command }) => {
				if (command.join(' ') === 'git status --short -- tests/fixtures/example.json') {
					return { exitCode: 0, stdout: '', stderr: '' }
				}

				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})

		expect(result).toEqual({ outcome: 'skipped' })
		expect(createPrCalls).toEqual([])
		expect(createIssueCalls).toEqual([])
	})

	test('updates existing PR when port branch already has an open PR', async () => {
		const { writer } = createWriterFake()
		const updatePrCalls: unknown[] = []
		let createPrAttempted = false

		writer.createPullRequest = async () => {
			createPrAttempted = true

			const error = new Error('A pull request already exists for this head branch.')

			;(error as unknown as { status: number }).status = 422
			throw error
		}

		writer.findPullRequestForBranch = async () => ({
			number: EXISTING_PORT_PR_NUMBER,
			url: `https://github.com/acme/target-repo/pull/${String(EXISTING_PORT_PR_NUMBER)}`,
		})
		writer.updatePullRequest = async params => {
			updatePrCalls.push(params)
		}

		const result = await deliverResult({
			writer,
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),

			execution: makeExecution(true),
			targetWorkingDirectory: '/tmp/target-repo',
			runCommand: async ({ command }) => {
				if (command.join(' ') === 'git diff --cached --quiet') {
					return { exitCode: 1, stdout: '', stderr: '' }
				}

				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})

		expect(createPrAttempted).toBe(true)
		expect(result.outcome).toBe('pr_opened')
		expect(result.targetPullRequestUrl).toBe(
			`https://github.com/acme/target-repo/pull/${String(EXISTING_PORT_PR_NUMBER)}`,
		)
		expect(updatePrCalls).toHaveLength(1)
		expect((updatePrCalls[0] as { pullNumber: number }).pullNumber).toBe(
			EXISTING_PORT_PR_NUMBER,
		)
	})

	test('treats untracked files as target-side diff for deterministic-only delivery', async () => {
		const { writer, createPrCalls } = createWriterFake()
		const context = makeContext()

		context.deterministic = makeDeterministic(true)

		const result = await deliverResult({
			writer,
			context,
			deterministic: context.deterministic,
			decision: makeDecision('NO_AGENT_PORT_NEEDED'),
			validation: makeValidation(true),
			targetWorkingDirectory: '/tmp/target-repo',
			runCommand: async ({ command }) => {
				if (command.join(' ') === 'git status --short -- tests/fixtures/example.json') {
					return {
						exitCode: 0,
						stdout: '?? tests/fixtures/first-sync.json\n',
						stderr: '',
					}
				}

				if (command.join(' ') === 'git diff --cached --quiet') {
					return { exitCode: 1, stdout: '', stderr: '' }
				}

				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})

		expect(result.outcome).toBe('pr_opened')
		expect(createPrCalls).toHaveLength(1)
	})

	test('ignores unrelated untracked files outside touched paths', async () => {
		const { writer, createPrCalls } = createWriterFake()
		const context = makeContext()

		context.deterministic = makeDeterministic(true)

		const result = await deliverResult({
			writer,
			context,
			deterministic: context.deterministic,
			decision: makeDecision('NO_AGENT_PORT_NEEDED'),
			validation: makeValidation(true),
			targetWorkingDirectory: '/tmp/target-repo',
			runCommand: async ({ command }) => {
				if (command.join(' ') === 'git status --short -- tests/fixtures/example.json') {
					return { exitCode: 0, stdout: '', stderr: '' }
				}

				return { exitCode: 0, stdout: '', stderr: '' }
			},
		})

		expect(result).toEqual({ outcome: 'skipped' })
		expect(createPrCalls).toEqual([])
	})

	test('throws when PORT_REQUIRED is delivered without execution result', async () => {
		const { writer } = createWriterFake()

		await expect(
			deliverResult({
				writer,
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
		const { writer, createCommentCalls } = createWriterFake()
		const context = makeContext()

		const commentUrl = await commentOnSourcePr({
			writer,
			pullRequestNumber: 42,
			context,
			decision: makeDecision('PORT_REQUIRED'),
			outcome: 'pr_opened',
			targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/901',
			runId: 'run-1',
		})

		expect(commentUrl).toBe('https://github.com/acme/source-repo/pull/42#issuecomment-1')
		expect(createCommentCalls).toHaveLength(1)
		expect((createCommentCalls[0] as { owner: string }).owner).toBe('acme')
		expect((createCommentCalls[0] as { repo: string }).repo).toBe('source-repo')
		expect((createCommentCalls[0] as { issueNumber: number }).issueNumber).toBe(
			SOURCE_PULL_REQUEST_NUMBER,
		)
		expect(String((createCommentCalls[0] as { body: string }).body)).toContain(
			'Ported to https://github.com/acme/target-repo/pull/901',
		)
		expect(String((createCommentCalls[0] as { body: string }).body)).toContain(
			'<!-- repo-port-bot:source-comment target=acme/target-repo -->',
		)
	})

	test('returns undefined when comment creation throws', async () => {
		const context = makeContext()
		const writer: GitHubWriter = {
			async createPullRequest() {
				return { number: 0, url: '' }
			},
			async createIssue() {
				return { number: 0, url: '' }
			},
			async addLabels() {},
			async createComment() {
				throw new Error('rate limited')
			},
			async listComments() {
				return []
			},
		}

		const commentUrl = await commentOnSourcePr({
			writer,
			pullRequestNumber: 42,
			context,
			decision: makeDecision('NEEDS_HUMAN'),
			outcome: 'failed',
			runId: 'run-2',
		})

		expect(commentUrl).toBeUndefined()
	})

	test('updates existing managed source comment instead of appending duplicate', async () => {
		const { createCommentCalls, updateCommentCalls, writer } = createWriterFake()
		const context = makeContext()

		writer.listComments = async () => [
			{
				id: EXISTING_SOURCE_COMMENT_ID,
				url: 'https://github.com/acme/source-repo/pull/42#issuecomment-101',
				body: [
					'<!-- repo-port-bot:source-comment target=acme/target-repo -->',
					'',
					'> [!WARNING]',
					'> Could not automatically port to `acme/target-repo`.',
				].join('\n'),
				createdAt: '2026-03-08T00:00:00Z',
			},
		]

		await commentOnSourcePr({
			writer,
			pullRequestNumber: 42,
			context,
			decision: makeDecision('PORT_REQUIRED'),
			outcome: 'pr_opened',
			targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/901',
			runId: 'run-3',
		})

		expect(createCommentCalls).toEqual([])
		expect(updateCommentCalls).toHaveLength(1)
		expect((updateCommentCalls[0] as { commentId: number }).commentId).toBe(
			EXISTING_SOURCE_COMMENT_ID,
		)
		expect(String((updateCommentCalls[0] as { body: string }).body)).not.toContain(
			'Supersedes [prior attempt]',
		)
		expect(String((updateCommentCalls[0] as { body: string }).body)).toContain(
			'<!-- repo-port-bot:source-comment target=acme/target-repo -->',
		)
	})
})

import { describe, expect, test } from 'bun:test'

import { decide } from './decide.ts'

import type {
	ChangedFile,
	PluginConfig,
	PortContext,
	PullRequestRef,
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

const BASE_PLUGIN_CONFIG: PluginConfig = {
	targetRepo: TARGET_REPO,
	ignorePatterns: [],
	validationCommands: ['bun run check'],
	pathMappings: {},
}

const BASE_PULL_REQUEST: PullRequestRef = {
	number: 42,
	title: 'Test PR',
	body: '',
	url: 'https://github.com/acme/source-repo/pull/42',
	labels: [],
}

/**
 * Build a `PortContext` for decision tests.
 *
 * @param input - Partial context overrides.
 * @param input.files - Changed files included in the synthetic context.
 * @param input.labels - Optional pull request labels override.
 * @param input.pullRequest - Optional pull request override. Pass `null` to simulate missing PR context.
 * @param input.ignorePatterns - Optional ignore patterns override.
 * @returns Context ready for `decide()`.
 */
function makeContext(input: {
	files: ChangedFile[]
	labels?: string[]
	pullRequest?: PullRequestRef | null
	ignorePatterns?: string[]
}): PortContext {
	const pullRequest =
		input.pullRequest === null
			? undefined
			: {
					...BASE_PULL_REQUEST,
					...input.pullRequest,
					labels: input.labels ?? input.pullRequest?.labels ?? BASE_PULL_REQUEST.labels,
				}
	const sourceChange: SourceChange = {
		mergedCommitSha: 'abc123',
		pullRequest,
		files: input.files,
	}

	return {
		runId: 'run-1',
		startedAt: '2026-03-03T00:00:00.000Z',
		sourceRepo: SOURCE_REPO,
		sourceChange,
		pluginConfig: {
			...BASE_PLUGIN_CONFIG,
			ignorePatterns: input.ignorePatterns ?? [],
		},
	}
}

describe('decide', () => {
	test('returns NEEDS_HUMAN when pull request metadata is missing', () => {
		const context = makeContext({
			pullRequest: null,
			files: [{ path: 'src/foo.ts', status: 'modified', additions: 1, deletions: 0 }],
		})

		const result = decide(context)

		expect(result.kind).toBe('NEEDS_HUMAN')
		expect(result.signals).toContain('missing-pr')
	})

	test('returns PORT_NOT_REQUIRED for auto-port label (loop prevention)', () => {
		const context = makeContext({
			labels: ['auto-port'],
			files: [{ path: 'src/foo.ts', status: 'modified', additions: 1, deletions: 0 }],
		})

		const result = decide(context)

		expect(result.kind).toBe('PORT_NOT_REQUIRED')
		expect(result.signals).toContain('loop-prevention')
	})

	test('returns PORT_NOT_REQUIRED for no-port label', () => {
		const context = makeContext({
			labels: ['no-port'],
			files: [{ path: 'src/foo.ts', status: 'modified', additions: 1, deletions: 0 }],
		})

		const result = decide(context)

		expect(result.kind).toBe('PORT_NOT_REQUIRED')
		expect(result.signals).toContain('no-port-label')
	})

	test('returns PORT_NOT_REQUIRED for docs-only changes', () => {
		const context = makeContext({
			labels: [],
			files: [
				{ path: 'README.md', status: 'modified', additions: 5, deletions: 1 },
				{ path: 'docs/arch/agent-loop.md', status: 'modified', additions: 4, deletions: 2 },
			],
		})

		const result = decide(context)

		expect(result.kind).toBe('PORT_NOT_REQUIRED')
		expect(result.signals).toContain('docs-only')
	})

	test('returns PORT_NOT_REQUIRED for config-only changes', () => {
		const context = makeContext({
			labels: [],
			files: [
				{
					path: '.github/workflows/port-bot.yml',
					status: 'modified',
					additions: 2,
					deletions: 1,
				},
				{ path: 'package.json', status: 'modified', additions: 3, deletions: 1 },
			],
		})

		const result = decide(context)

		expect(result.kind).toBe('PORT_NOT_REQUIRED')
		expect(result.signals).toContain('config-only')
	})

	test('treats ignored paths as config-only for skip decision', () => {
		const context = makeContext({
			labels: [],
			ignorePatterns: ['generated/**'],
			files: [
				{ path: 'generated/client.ts', status: 'modified', additions: 10, deletions: 3 },
			],
		})

		const result = decide(context)

		expect(result.kind).toBe('PORT_NOT_REQUIRED')
		expect(result.signals).toContain('config-only')
	})

	test('falls through to classifier stub for mixed changes', () => {
		const context = makeContext({
			labels: [],
			files: [
				{ path: 'docs/guide.md', status: 'modified', additions: 2, deletions: 0 },
				{ path: 'src/app.ts', status: 'modified', additions: 4, deletions: 1 },
			],
		})

		const result = decide(context)

		expect(result.kind).toBe('NEEDS_HUMAN')
		expect(result.signals).toContain('classifier-stub')
	})
})

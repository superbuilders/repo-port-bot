import { describe, expect, test } from 'bun:test'

import { readSourceContext } from './read-source-context.ts'

import type { Octokit } from '@octokit/rest'

type CommitPullResponse = Awaited<
	ReturnType<Octokit['rest']['repos']['listPullRequestsAssociatedWithCommit']>
>['data']
type PullFilesResponse = Awaited<ReturnType<Octokit['rest']['pulls']['listFiles']>>['data']

interface OctokitMockConfig {
	pullRequests: CommitPullResponse
	files: PullFilesResponse
}

/**
 * Build a lightweight Octokit mock with controllable PR/file responses.
 *
 * @param config - Mock response payloads.
 * @returns Mock octokit and recorded paginate call parameters.
 */
function createOctokitMock(config: OctokitMockConfig): {
	octokit: Octokit
	paginateCalls: { owner: string; per_page: number; pull_number: number; repo: string }[]
} {
	const paginateCalls: {
		owner: string
		per_page: number
		pull_number: number
		repo: string
	}[] = []

	const octokit = {
		rest: {
			repos: {
				listPullRequestsAssociatedWithCommit: async () => ({
					data: config.pullRequests,
				}),
			},
			pulls: {
				listFiles: async () => ({
					data: config.files,
				}),
			},
		},
		paginate: async (
			_: unknown,
			params: { owner: string; per_page: number; pull_number: number; repo: string },
		) => {
			paginateCalls.push(params)

			return config.files
		},
	} as unknown as Octokit

	return { octokit, paginateCalls }
}

describe('readSourceContext', () => {
	test('returns pull request metadata and changed files', async () => {
		const pullRequests = [
			{
				body: 'PR body',
				html_url: 'https://github.com/acme/source-repo/pull/42',
				labels: [{ name: 'no-port' }, { name: 'sdk' }],
				number: 42,
				title: 'Add feature',
			},
		] as unknown as CommitPullResponse
		const files = [
			{
				additions: 12,
				deletions: 4,
				filename: 'src/new-file.ts',
				status: 'added',
				patch: '@@ -0,0 +1,12 @@\n+export const value = 1',
			},
		] as unknown as PullFilesResponse
		const { octokit } = createOctokitMock({ pullRequests, files })

		const result = await readSourceContext({
			octokit,
			owner: 'acme',
			repo: 'source-repo',
			commitSha: 'abc123',
		})

		expect(result.mergedCommitSha).toBe('abc123')
		expect(result.pullRequest).toEqual({
			number: 42,
			title: 'Add feature',
			body: 'PR body',
			url: 'https://github.com/acme/source-repo/pull/42',
			labels: ['no-port', 'sdk'],
		})
		expect(result.files).toEqual([
			{
				path: 'src/new-file.ts',
				status: 'added',
				additions: 12,
				deletions: 4,
				patch: '@@ -0,0 +1,12 @@\n+export const value = 1',
				previousPath: undefined,
			},
		])
	})

	test('returns empty context when commit has no associated pull request', async () => {
		const { octokit, paginateCalls } = createOctokitMock({
			pullRequests: [],
			files: [],
		})

		const result = await readSourceContext({
			octokit,
			owner: 'acme',
			repo: 'source-repo',
			commitSha: 'no-pr-commit',
		})

		expect(result).toEqual({
			mergedCommitSha: 'no-pr-commit',
			pullRequest: undefined,
			files: [],
		})
		expect(paginateCalls.length).toBe(0)
	})

	test('maps renamed files and missing patches', async () => {
		const pullRequests = [
			{
				body: null,
				html_url: 'https://github.com/acme/source-repo/pull/7',
				labels: [{ name: 'feature' }],
				number: 7,
				title: 'Rename file',
			},
		] as unknown as CommitPullResponse
		const files = [
			{
				additions: 2,
				deletions: 2,
				filename: 'src/new-name.ts',
				previous_filename: 'src/old-name.ts',
				status: 'renamed',
			},
		] as unknown as PullFilesResponse
		const { octokit } = createOctokitMock({ pullRequests, files })

		const result = await readSourceContext({
			octokit,
			owner: 'acme',
			repo: 'source-repo',
			commitSha: 'rename123',
		})

		expect(result.files[0]).toEqual({
			path: 'src/new-name.ts',
			status: 'renamed',
			additions: 2,
			deletions: 2,
			patch: undefined,
			previousPath: 'src/old-name.ts',
		})
	})

	test('uses pagination and normalizes github statuses', async () => {
		const pullRequests = [
			{
				body: '',
				html_url: 'https://github.com/acme/source-repo/pull/18',
				labels: [{ name: 'auto-port' }],
				number: 18,
				title: 'Mixed file changes',
			},
		] as unknown as CommitPullResponse
		const files = [
			{
				additions: 1,
				deletions: 9,
				filename: 'src/removed.ts',
				status: 'removed',
			},
			{
				additions: 30,
				deletions: 0,
				filename: 'src/copied.ts',
				status: 'copied',
			},
			{
				additions: 6,
				deletions: 6,
				filename: 'src/changed.ts',
				status: 'changed',
			},
		] as unknown as PullFilesResponse
		const { octokit, paginateCalls } = createOctokitMock({ pullRequests, files })

		const result = await readSourceContext({
			octokit,
			owner: 'acme',
			repo: 'source-repo',
			commitSha: 'paginate123',
		})

		expect(paginateCalls).toEqual([
			{
				owner: 'acme',
				repo: 'source-repo',
				pull_number: 18,
				per_page: 100,
			},
		])

		expect(result.files.map(file => file.status)).toEqual(['deleted', 'added', 'modified'])
	})
})

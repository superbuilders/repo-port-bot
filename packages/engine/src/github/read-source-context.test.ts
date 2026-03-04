import { describe, expect, test } from 'bun:test'

import { readSourceContext } from './read-source-context.ts'

import type { ChangedFile, GitHubReader, PullRequestRef } from '../types.ts'

interface ReaderMockConfig {
	pullRequests: PullRequestRef[]
	files: ChangedFile[]
}

/**
 * Build a GitHubReader fake with controllable PR/file responses.
 *
 * @param config - Mock response payloads.
 * @returns Fake reader and recorded call parameters.
 */
function createReaderFake(config: ReaderMockConfig): {
	reader: GitHubReader
	listFilesCalls: { owner: string; repo: string; pullRequestNumber: number }[]
} {
	const listFilesCalls: { owner: string; repo: string; pullRequestNumber: number }[] = []

	const reader: GitHubReader = {
		async listPullRequestsForCommit() {
			return config.pullRequests
		},
		async listChangedFiles(owner, repo, pullRequestNumber) {
			listFilesCalls.push({ owner, repo, pullRequestNumber })

			return config.files
		},
		async getFileContent() {
			return undefined
		},
	}

	return { reader, listFilesCalls }
}

describe('readSourceContext', () => {
	test('returns pull request metadata and changed files', async () => {
		const pullRequests: PullRequestRef[] = [
			{
				number: 42,
				title: 'Add feature',
				body: 'PR body',
				url: 'https://github.com/acme/source-repo/pull/42',
				labels: ['no-port', 'sdk'],
			},
		]
		const files: ChangedFile[] = [
			{
				path: 'src/new-file.ts',
				status: 'added',
				additions: 12,
				deletions: 4,
				patch: '@@ -0,0 +1,12 @@\n+export const value = 1',
			},
		]
		const { reader } = createReaderFake({ pullRequests, files })

		const result = await readSourceContext({
			reader,
			owner: 'acme',
			repo: 'source-repo',
			commitSha: 'abc123',
		})

		expect(result.mergedCommitSha).toBe('abc123')
		expect(result.pullRequest).toEqual(pullRequests[0])
		expect(result.files).toEqual(files)
	})

	test('returns empty context when commit has no associated pull request', async () => {
		const { reader, listFilesCalls } = createReaderFake({
			pullRequests: [],
			files: [],
		})

		const result = await readSourceContext({
			reader,
			owner: 'acme',
			repo: 'source-repo',
			commitSha: 'no-pr-commit',
		})

		expect(result).toEqual({
			mergedCommitSha: 'no-pr-commit',
			pullRequest: undefined,
			files: [],
		})
		expect(listFilesCalls.length).toBe(0)
	})

	test('passes owner/repo/prNumber to listChangedFiles', async () => {
		const pullRequests: PullRequestRef[] = [
			{
				number: 18,
				title: 'Mixed file changes',
				body: '',
				url: 'https://github.com/acme/source-repo/pull/18',
				labels: ['auto-port'],
			},
		]
		const files: ChangedFile[] = [
			{ path: 'src/removed.ts', status: 'deleted', additions: 1, deletions: 9 },
			{ path: 'src/copied.ts', status: 'added', additions: 30, deletions: 0 },
			{ path: 'src/changed.ts', status: 'modified', additions: 6, deletions: 6 },
		]
		const { reader, listFilesCalls } = createReaderFake({ pullRequests, files })

		const result = await readSourceContext({
			reader,
			owner: 'acme',
			repo: 'source-repo',
			commitSha: 'paginate123',
		})

		expect(listFilesCalls).toEqual([
			{ owner: 'acme', repo: 'source-repo', pullRequestNumber: 18 },
		])
		expect(result.files.map(file => file.status)).toEqual(['deleted', 'added', 'modified'])
	})
})

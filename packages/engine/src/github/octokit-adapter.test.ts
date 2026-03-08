import { describe, expect, test } from 'bun:test'

import { createOctokitWriter } from './octokit-adapter.ts'

describe('createOctokitWriter', () => {
	test('findNeedsHumanIssueForSource matches open issue by source PR or commit', async () => {
		const octokit = {
			paginate: async () => [
				{
					number: 11,
					html_url: 'https://github.com/acme/target-repo/issues/11',
					body: [
						'Needs human.',
						'',
						'---',
						'Source-PR: https://github.com/acme/source-repo/pull/42',
						'Source-Commit: abc123',
					].join('\n'),
				},
				{
					number: 12,
					html_url: 'https://github.com/acme/target-repo/issues/12',
					body: 'Source-Commit: def456',
					pull_request: { url: 'https://api.github.com/repos/acme/target-repo/pulls/12' },
				},
			],
			rest: {
				issues: {
					listForRepo: {},
					update: async () => {},
				},
				pulls: {
					create: async () => ({ data: {} }),
					update: async () => {},
					get: async () => ({ data: { draft: false } }),
					list: async () => ({ data: [] }),
				},
			},
			graphql: async () => ({}),
		} as const

		const writer = createOctokitWriter(octokit as never)
		const byPr = await writer.findNeedsHumanIssueForSource?.({
			owner: 'acme',
			repo: 'target-repo',
			sourcePullRequestUrl: 'https://github.com/acme/source-repo/pull/42',
			sourceCommitSha: 'zzz999',
		})
		const byCommit = await writer.findNeedsHumanIssueForSource?.({
			owner: 'acme',
			repo: 'target-repo',
			sourceCommitSha: 'abc123',
		})

		expect(byPr).toEqual({
			number: 11,
			url: 'https://github.com/acme/target-repo/issues/11',
		})
		expect(byCommit).toEqual({
			number: 11,
			url: 'https://github.com/acme/target-repo/issues/11',
		})
	})

	test('updateIssue forwards title and body to issues.update', async () => {
		const updateCalls: unknown[] = []
		const octokit = {
			paginate: async () => [],
			rest: {
				issues: {
					listForRepo: {},
					update: async (params: unknown) => {
						updateCalls.push(params)
					},
				},
				pulls: {
					create: async () => ({ data: {} }),
					update: async () => {},
					get: async () => ({ data: { draft: false } }),
					list: async () => ({ data: [] }),
				},
			},
			graphql: async () => ({}),
		} as const

		const writer = createOctokitWriter(octokit as never)

		await writer.updateIssue?.({
			owner: 'acme',
			repo: 'target-repo',
			issueNumber: 99,
			title: 'Needs review: Sync feature',
			body: 'Updated issue body',
		})

		expect(updateCalls).toEqual([
			{
				owner: 'acme',
				repo: 'target-repo',
				issue_number: 99,
				title: 'Needs review: Sync feature',
				body: 'Updated issue body',
			},
		])
	})
})

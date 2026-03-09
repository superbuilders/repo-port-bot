import { describe, expect, test } from 'bun:test'

import { fetchPortBotJson } from './fetch-port-bot-json.ts'

import type { GitHubReader } from '../types.ts'

/**
 * Build a GitHubReader fake with configurable getFileContent behavior.
 *
 * @param getFileContent - Mocked getFileContent implementation.
 * @returns GitHubReader fake.
 */
function createReaderFake(getFileContent: GitHubReader['getFileContent']): GitHubReader {
	return {
		async listPullRequestsForCommit() {
			return []
		},
		async listChangedFiles() {
			return []
		},
		getFileContent,
	}
}

describe('fetchPortBotJson', () => {
	test('returns decoded config when file exists', async () => {
		const reader = createReaderFake(async (_owner, _repo, path) =>
			path === 'port-bot.json'
				? JSON.stringify({
						target: 'acme/target-repo',
						validation: ['bun run check'],
					})
				: undefined,
		)

		const result = await fetchPortBotJson({
			reader,
			owner: 'acme',
			repo: 'source-repo',
			ref: 'abc123',
		})

		expect(result).toEqual({
			target: 'acme/target-repo',
			validation: ['bun run check'],
		})
	})

	test('returns undefined when file does not exist', async () => {
		const reader = createReaderFake(async () => undefined)

		const result = await fetchPortBotJson({
			reader,
			owner: 'acme',
			repo: 'source-repo',
			ref: 'abc123',
		})

		expect(result).toBeUndefined()
	})

	test('returns undefined and warns on errors', async () => {
		let warned = false
		const originalWarn = console.warn

		console.warn = () => {
			warned = true
		}

		const reader = createReaderFake(async () => {
			throw new Error('boom')
		})

		const result = await fetchPortBotJson({
			reader,
			owner: 'acme',
			repo: 'source-repo',
			ref: 'abc123',
		})

		expect(result).toBeUndefined()
		expect(warned).toBe(true)
		console.warn = originalWarn
	})

	test('falls back to alternate supported config filenames', async () => {
		const reader = createReaderFake(async (_owner, _repo, path) =>
			path === '.github/repo-port-bot.json'
				? JSON.stringify({
						target: 'acme/target-repo',
						prompt: 'Use the alternate config file.',
					})
				: undefined,
		)

		const result = await fetchPortBotJson({
			reader,
			owner: 'acme',
			repo: 'source-repo',
			ref: 'abc123',
		})

		expect(result).toEqual({
			target: 'acme/target-repo',
			prompt: 'Use the alternate config file.',
		})
	})

	test('uses the first matching filename by precedence order', async () => {
		const requestedPaths: string[] = []
		const reader = createReaderFake(async (_owner, _repo, path) => {
			requestedPaths.push(path)

			if (path === '.port-bot.json') {
				return JSON.stringify({
					target: 'acme/target-repo',
					prompt: 'Selected by precedence.',
				})
			}

			if (path === '.github/port-bot.json') {
				return JSON.stringify({
					target: 'acme/other-repo',
					prompt: 'Should never win.',
				})
			}

			return undefined
		})

		const result = await fetchPortBotJson({
			reader,
			owner: 'acme',
			repo: 'source-repo',
			ref: 'abc123',
		})

		expect(result).toEqual({
			target: 'acme/target-repo',
			prompt: 'Selected by precedence.',
		})
		expect(requestedPaths).toEqual(['port-bot.json', '.port-bot.json'])
	})
})

import { describe, expect, test } from 'bun:test'

import { fetchPortBotJson } from './fetch-port-bot-json.ts'

import type { Octokit } from '@octokit/rest'

/**
 * Build an Octokit mock with configurable getContent behavior.
 *
 * @param getContent - Mocked getContent implementation.
 * @returns Octokit mock.
 */
function createOctokitMock(getContent: () => Promise<unknown>): Octokit {
	return {
		rest: {
			repos: {
				getContent,
			},
		},
	} as unknown as Octokit
}

describe('fetchPortBotJson', () => {
	test('returns decoded config when file exists', async () => {
		const content = Buffer.from(
			JSON.stringify({
				target: 'acme/target-repo',
				validation: ['bun run check'],
			}),
			'utf8',
		).toString('base64')
		const octokit = createOctokitMock(async () => ({
			data: {
				type: 'file',
				content,
			},
		}))

		const result = await fetchPortBotJson({
			octokit,
			owner: 'acme',
			repo: 'source-repo',
			ref: 'abc123',
		})

		expect(result).toEqual({
			target: 'acme/target-repo',
			validation: ['bun run check'],
		})
	})

	test('returns undefined on 404', async () => {
		const octokit = createOctokitMock(async () => {
			throw { status: 404 }
		})

		const result = await fetchPortBotJson({
			octokit,
			owner: 'acme',
			repo: 'source-repo',
			ref: 'abc123',
		})

		expect(result).toBeUndefined()
	})

	test('returns undefined and warns on non-404 errors', async () => {
		let warned = false
		const originalWarn = console.warn

		console.warn = () => {
			warned = true
		}

		const octokit = createOctokitMock(async () => {
			throw new Error('boom')
		})

		const result = await fetchPortBotJson({
			octokit,
			owner: 'acme',
			repo: 'source-repo',
			ref: 'abc123',
		})

		expect(result).toBeUndefined()
		expect(warned).toBe(true)
		console.warn = originalWarn
	})
})

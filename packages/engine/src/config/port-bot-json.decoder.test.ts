import { describe, expect, test } from 'bun:test'

import { decodePortBotJson, parseAndDecodePortBotJson } from './port-bot-json.decoder.ts'

describe('portBotJson decoder', () => {
	test('decodes valid object input', () => {
		const result = decodePortBotJson({
			target: 'acme/target-repo',
			ignore: ['docs/**'],
			validation: ['bun run check'],
			sync: [
				{
					source: 'tests/fixtures/**',
					target: 'tests/fixtures/',
					mode: 'mirror',
				},
			],
			mapping: {
				'src/': 'pkg/',
			},
			conventions: {
				naming: 'camelCase -> snake_case',
			},
			prompt: 'Keep compatibility.',
		})

		expect(result.target).toBe('acme/target-repo')
		expect(result.sync).toEqual([
			{
				source: 'tests/fixtures/**',
				target: 'tests/fixtures/',
				mode: 'mirror',
			},
		])
		expect(result.mapping?.['src/']).toBe('pkg/')
	})

	test('throws on invalid object shape', () => {
		expect(() => {
			decodePortBotJson({
				target: 123,
			})
		}).toThrow()
	})

	test('parses valid json string input', () => {
		const result = parseAndDecodePortBotJson(
			JSON.stringify({
				target: 'acme/target-repo',
				validation: ['bun run test'],
			}),
		)

		expect(result.target).toBe('acme/target-repo')
		expect(result.validation).toEqual(['bun run test'])
	})

	test('throws on invalid json string input', () => {
		expect(() => {
			parseAndDecodePortBotJson('{invalid-json')
		}).toThrow('Invalid port-bot.json content. Expected valid JSON.')
	})

	test('throws on invalid sync mode', () => {
		expect(() => {
			decodePortBotJson({
				sync: [
					{
						source: 'tests/fixtures/**',
						target: 'tests/fixtures/',
						mode: 'rename',
					},
				],
			})
		}).toThrow()
	})
})

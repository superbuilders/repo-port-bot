import { describe, expect, test } from 'bun:test'

import { resolvePluginConfig } from './resolve-plugin-config.ts'

describe('resolvePluginConfig', () => {
	test('parses port-bot.json object into PluginConfig', () => {
		const result = resolvePluginConfig({
			portBotJson: {
				target: 'acme/target-repo',
				ignore: ['docs/**', '.github/**'],
				validation: ['bun run test', 'bun run check'],
				mapping: {
					'src/client/': 'packages/client/src/',
				},
				conventions: {
					naming: 'camelCase -> snake_case',
				},
				prompt: 'Keep backwards compatibility.',
			},
			targetDefaultBranch: 'dev',
		})

		expect(result).toEqual({
			targetRepo: {
				owner: 'acme',
				name: 'target-repo',
				defaultBranch: 'dev',
			},
			ignorePatterns: ['docs/**', '.github/**'],
			validationCommands: ['bun run test', 'bun run check'],
			pathMappings: {
				'src/client/': 'packages/client/src/',
			},
			namingConventions: 'camelCase -> snake_case',
			prompt: 'Keep backwards compatibility.',
		})
	})

	test('accepts raw json string', () => {
		const result = resolvePluginConfig({
			portBotJson: JSON.stringify({
				target: 'acme/py-sdk',
				validation: ['just test'],
				mapping: {
					'src/': 'pkg/',
				},
			}),
		})

		expect(result.targetRepo).toEqual({
			owner: 'acme',
			name: 'py-sdk',
			defaultBranch: 'main',
		})
		expect(result.validationCommands).toEqual(['just test'])
	})

	test('built-in config takes precedence over port-bot.json', () => {
		const result = resolvePluginConfig({
			builtInConfig: {
				targetRepo: {
					owner: 'built',
					name: 'in-repo',
					defaultBranch: 'release',
				},
				validationCommands: ['bun run check'],
				pathMappings: {
					'src/a': 'dst/a',
				},
				ignorePatterns: ['generated/**'],
				namingConventions: 'preserve casing',
				prompt: 'Use built-in prompt.',
			},
			portBotJson: {
				target: 'json/repo',
				validation: ['just test'],
				mapping: {
					'src/b': 'dst/b',
				},
				ignore: ['docs/**'],
				conventions: {
					naming: 'snake_case',
				},
				prompt: 'Use json prompt.',
			},
		})

		expect(result).toEqual({
			targetRepo: {
				owner: 'built',
				name: 'in-repo',
				defaultBranch: 'release',
			},
			ignorePatterns: ['generated/**'],
			validationCommands: ['bun run check'],
			pathMappings: {
				'src/a': 'dst/a',
			},
			namingConventions: 'preserve casing',
			prompt: 'Use built-in prompt.',
		})
	})

	test('throws for invalid target format', () => {
		expect(() => {
			resolvePluginConfig({
				portBotJson: {
					target: 'missing-slash',
				},
			})
		}).toThrow('Invalid `target` in port-bot.json. Expected format "owner/repo".')
	})

	test('throws when target repo cannot be resolved', () => {
		expect(() => {
			resolvePluginConfig({
				portBotJson: {
					validation: ['bun run check'],
					mapping: {
						'src/': 'dst/',
					},
				},
			})
		}).toThrow(
			'Plugin config is missing target repository fields (owner, name, defaultBranch).',
		)
	})
})

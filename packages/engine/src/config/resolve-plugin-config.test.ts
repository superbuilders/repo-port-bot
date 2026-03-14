import { describe, expect, test } from 'bun:test'

import { resolvePluginConfig } from './resolve-plugin-config.ts'

describe('resolvePluginConfig', () => {
	test('parses port-bot.json object into PluginConfig', () => {
		const result = resolvePluginConfig({
			portBotJson: {
				target: 'acme/target-repo',
				ignore: ['docs/**', '.github/**'],
				validation: ['bun run test', 'bun run check'],
				sync: [
					{
						source: 'tests/fixtures/**',
						target: 'tests/fixtures/',
						mode: 'mirror',
					},
				],
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
			deterministicOperations: [
				{
					kind: 'sync',
					source: 'tests/fixtures/**',
					target: 'tests/fixtures/',
					mode: 'mirror',
				},
			],
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
				deterministicOperations: [
					{
						kind: 'sync',
						source: 'from-built-in',
						target: 'to-built-in',
						mode: 'copy',
					},
				],
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
				sync: [
					{
						source: 'from-json',
						target: 'to-json',
						mode: 'mirror',
					},
				],
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
			deterministicOperations: [
				{
					kind: 'sync',
					source: 'from-built-in',
					target: 'to-built-in',
					mode: 'copy',
				},
			],
			pathMappings: {
				'src/a': 'dst/a',
			},
			namingConventions: 'preserve casing',
			prompt: 'Use built-in prompt.',
		})
	})

	test('empty built-in arrays do not clobber port-bot.json values', () => {
		const result = resolvePluginConfig({
			builtInConfig: {
				targetRepo: { owner: 'acme', name: 'target', defaultBranch: 'main' },
				validationCommands: [],
				ignorePatterns: [],
				deterministicOperations: [],
				pathMappings: {},
			},
			portBotJson: {
				target: 'acme/target',
				validation: ['just check-ci'],
				ignore: ['docs/**'],
				sync: [{ source: 'fixtures/**', target: 'fixtures/', mode: 'mirror' }],
				mapping: { 'packages/sdk/': 'packages/timeback/' },
			},
		})

		expect(result.validationCommands).toEqual(['just check-ci'])
		expect(result.ignorePatterns).toEqual(['docs/**'])
		expect(result.deterministicOperations).toEqual([
			{ kind: 'sync', source: 'fixtures/**', target: 'fixtures/', mode: 'mirror' },
		])
		expect(result.pathMappings).toEqual({ 'packages/sdk/': 'packages/timeback/' })
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

	test('rejects sync source paths that traverse outside the repo checkout', () => {
		expect(() => {
			resolvePluginConfig({
				portBotJson: {
					target: 'acme/target-repo',
					sync: [
						{
							source: '../secrets.txt',
							target: 'tests/manifest.json',
							mode: 'copy',
						},
					],
				},
			})
		}).toThrow('Sync operation source must not traverse outside the repo checkout.')
	})

	test('rejects sync target paths that traverse outside the repo checkout', () => {
		expect(() => {
			resolvePluginConfig({
				portBotJson: {
					target: 'acme/target-repo',
					sync: [
						{
							source: 'tests/manifest.json',
							target: '../../other-repo/file',
							mode: 'copy',
						},
					],
				},
			})
		}).toThrow('Sync operation target must not traverse outside the repo checkout.')
	})

	test('rejects traversal hidden inside normalized path segments', () => {
		expect(() => {
			resolvePluginConfig({
				portBotJson: {
					target: 'acme/target-repo',
					sync: [
						{
							source: 'fixtures/../secrets/**',
							target: 'fixtures/',
							mode: 'mirror',
						},
					],
				},
			})
		}).toThrow('must not traverse outside the repo checkout')

		expect(() => {
			resolvePluginConfig({
				portBotJson: {
					target: 'acme/target-repo',
					sync: [
						{
							source: 'tests/manifest.json',
							target: 'dir/../escape.json',
							mode: 'copy',
						},
					],
				},
			})
		}).toThrow('must not traverse outside the repo checkout')
	})

	test('rejects glob source in copy mode', () => {
		expect(() => {
			resolvePluginConfig({
				portBotJson: {
					target: 'acme/target-repo',
					sync: [
						{
							source: 'fixtures/*.json',
							target: 'fixtures/',
							mode: 'copy',
						},
					],
				},
			})
		}).toThrow('Copy source must be a literal file path, not a glob pattern')
	})

	test('rejects literal directory source in mirror mode', () => {
		expect(() => {
			resolvePluginConfig({
				portBotJson: {
					target: 'acme/target-repo',
					sync: [
						{
							source: 'fixtures',
							target: 'fixtures/',
							mode: 'mirror',
						},
					],
				},
			})
		}).toThrow('Mirror source must be a glob pattern')
	})

	test('rejects directory-like target in copy mode', () => {
		expect(() => {
			resolvePluginConfig({
				portBotJson: {
					target: 'acme/target-repo',
					sync: [
						{
							source: 'tests/manifest.json',
							target: 'tests/',
							mode: 'copy',
						},
					],
				},
			})
		}).toThrow('Copy target must be a file path, not a directory')

		expect(() => {
			resolvePluginConfig({
				portBotJson: {
					target: 'acme/target-repo',
					sync: [
						{
							source: 'tests/manifest.json',
							target: '.',
							mode: 'copy',
						},
					],
				},
			})
		}).toThrow('Copy target must be a file path, not a directory')
	})

	test('rejects absolute sync target paths', () => {
		expect(() => {
			resolvePluginConfig({
				portBotJson: {
					target: 'acme/target-repo',
					sync: [
						{
							source: 'tests/manifest.json',
							target: '/tmp/leak.txt',
							mode: 'copy',
						},
					],
				},
			})
		}).toThrow('Sync operation target must be repo-relative, not absolute.')
	})
})

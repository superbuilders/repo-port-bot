import { describe, expect, test } from 'bun:test'

import { buildSystemPrompt, buildUserPrompt } from './build-prompt.ts'

import type { AgentInput, PluginConfig } from '@repo-port-bot/engine'

/**
 * Build a plugin config fixture for prompt tests.
 *
 * @param overrides - Partial overrides.
 * @returns Plugin config.
 */
function makePluginConfig(overrides?: Partial<PluginConfig>): PluginConfig {
	return {
		targetRepo: {
			owner: 'acme',
			name: 'target',
			defaultBranch: 'main',
		},
		ignorePatterns: [],
		validationCommands: ['bun run check'],
		pathMappings: {},
		...overrides,
	}
}

/**
 * Build an agent input fixture for prompt tests.
 *
 * @param overrides - Partial overrides.
 * @returns Agent input fixture.
 */
function makeInput(overrides?: Partial<AgentInput>): AgentInput {
	return {
		files: [
			{
				path: 'src/feature.ts',
				status: 'modified',
				additions: 5,
				deletions: 1,
				patch: '@@ -1,1 +1,2 @@\n-export const before = true\n+export const before = false',
			},
		],
		targetWorkingDirectory: '/tmp/target',
		pluginConfig: makePluginConfig(),
		previousAttempts: [],
		...overrides,
	}
}

describe('buildSystemPrompt', () => {
	test('includes path mappings when provided', () => {
		const prompt = buildSystemPrompt({
			pluginConfig: makePluginConfig({
				pathMappings: {
					'src/lib/': 'lib/',
				},
			}),
		})

		expect(prompt).toContain('Source-to-target path mappings')
		expect(prompt).toContain('`src/lib/` -> `lib/`')
	})

	test('includes naming conventions and custom prompt when provided', () => {
		const prompt = buildSystemPrompt({
			pluginConfig: makePluginConfig({
				namingConventions: 'snake_case for python modules',
				prompt: 'Prefer target repository helper abstractions.',
			}),
		})

		expect(prompt).toContain('Naming conventions')
		expect(prompt).toContain('snake_case for python modules')
		expect(prompt).toContain('Additional instructions')
		expect(prompt).toContain('Prefer target repository helper abstractions.')
	})

	test('omits optional sections when absent', () => {
		const prompt = buildSystemPrompt({ pluginConfig: makePluginConfig() })

		expect(prompt).not.toContain('Source-to-target path mappings')
		expect(prompt).not.toContain('Naming conventions')
		expect(prompt).not.toContain('Additional instructions')
	})

	test('includes source checkout and diff file rules when provided', () => {
		const prompt = buildSystemPrompt({
			pluginConfig: makePluginConfig(),
			sourceWorkingDirectory: '/tmp/source',
			diffFilePath: '/tmp/source/port-diff.patch',
		})

		expect(prompt).toContain('Source repository checkout')
		expect(prompt).toContain('/tmp/source')
		expect(prompt).toContain('Source diff file')
		expect(prompt).toContain('/tmp/source/port-diff.patch')
	})
})

describe('buildUserPrompt', () => {
	test('includes changed files and source references when disk context is provided', () => {
		const prompt = buildUserPrompt(
			makeInput({
				sourceWorkingDirectory: '/tmp/source',
				diffFilePath: '/tmp/source/port-diff.patch',
			}),
		)

		expect(prompt).toContain('Changed files:')
		expect(prompt).toContain('`src/feature.ts`')
		expect(prompt).toContain('Source repository path: `/tmp/source`')
		expect(prompt).toContain('Full diff file: `/tmp/source/port-diff.patch`')
		expect(prompt).toContain('Apply equivalent changes in the target repository.')
		expect(prompt).not.toContain('```diff')
		expect(prompt).not.toContain('Previous attempt feedback')
	})

	test('falls back to inline patches when source paths are absent', () => {
		const prompt = buildUserPrompt(makeInput())

		expect(prompt).toContain('Changed files:')
		expect(prompt).toContain('`src/feature.ts`')
		expect(prompt).toContain('```diff')
		expect(prompt).toContain('Apply equivalent changes in the target repository.')
		expect(prompt).not.toContain('Previous attempt feedback')
	})

	test('includes retry validation details when previous attempts exist', () => {
		const prompt = buildUserPrompt(
			makeInput({
				previousAttempts: [
					{
						attempt: 1,
						touchedFiles: ['src/feature.ts'],
						validation: [
							{
								command: 'bun run check',
								ok: false,
								exitCode: 1,
								stdout: '',
								stderr: 'Type error in src/feature.ts',
								durationMs: 1000,
							},
						],
						notes: 'Updated the main function but missed an import.',
						toolCallLog: [],
					},
				],
			}),
		)

		expect(prompt).toContain('Previous attempt feedback')
		expect(prompt).toContain('Attempt 1')
		expect(prompt).toContain('Validation failure')
		expect(prompt).toContain('Type error in src/feature.ts')
		expect(prompt).toContain('Previous attempt failed validation')
	})
})

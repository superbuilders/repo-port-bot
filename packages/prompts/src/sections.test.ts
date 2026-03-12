import { describe, expect, test } from 'bun:test'

import {
	renderAdditionalInstructions,
	renderChangedFiles,
	renderDeterministicContext,
	renderDiffFileSection,
	renderIgnorePatterns,
	renderNamingConventions,
	renderPathMappings,
	renderRetryFeedback,
	renderSourceRepoSection,
} from './sections.ts'

import type { ExecutePortAttemptResult, PluginConfig } from '@repo-port-bot/engine'

/**
 * @param overrides - Partial overrides.
 * @returns Minimal plugin config fixture.
 */
function makeConfig(overrides?: Partial<PluginConfig>): PluginConfig {
	return {
		targetRepo: { owner: 'acme', name: 'target', defaultBranch: 'main' },
		ignorePatterns: [],
		validationCommands: [],
		deterministicOperations: [],
		pathMappings: {},
		...overrides,
	}
}

describe('renderPathMappings', () => {
	test('returns undefined when no mappings', () => {
		expect(renderPathMappings(makeConfig())).toBeUndefined()
	})

	test('renders mapping entries', () => {
		const result = renderPathMappings(
			makeConfig({ pathMappings: { 'src/': 'lib/', 'tests/': 'spec/' } }),
		)

		expect(result).toContain('Source-to-target path mappings:')
		expect(result).toContain('`src/` -> `lib/`')
		expect(result).toContain('`tests/` -> `spec/`')
	})
})

describe('renderNamingConventions', () => {
	test('returns undefined when not set', () => {
		expect(renderNamingConventions(makeConfig())).toBeUndefined()
	})

	test('renders conventions', () => {
		const result = renderNamingConventions(
			makeConfig({ namingConventions: 'snake_case for modules' }),
		)

		expect(result).toContain('Naming conventions')
		expect(result).toContain('snake_case for modules')
	})
})

describe('renderAdditionalInstructions', () => {
	test('returns undefined when no prompt', () => {
		expect(renderAdditionalInstructions(makeConfig())).toBeUndefined()
	})

	test('renders custom prompt', () => {
		const result = renderAdditionalInstructions(
			makeConfig({ prompt: 'Use helper abstractions.' }),
		)

		expect(result).toContain('Additional instructions')
		expect(result).toContain('Use helper abstractions.')
	})
})

describe('renderIgnorePatterns', () => {
	test('returns undefined when no ignore patterns', () => {
		expect(renderIgnorePatterns(makeConfig())).toBeUndefined()
	})

	test('renders ignore patterns', () => {
		const result = renderIgnorePatterns(
			makeConfig({
				ignorePatterns: ['.github/**', 'scripts/**'],
			}),
		)

		expect(result).toContain('excluded from porting scope')
		expect(result).toContain('`.github/**`')
		expect(result).toContain('`scripts/**`')
	})
})

describe('renderSourceRepoSection', () => {
	test('returns undefined when not provided', () => {
		expect(renderSourceRepoSection()).toBeUndefined()
		expect(renderSourceRepoSection(undefined)).toBeUndefined()
	})

	test('renders path', () => {
		expect(renderSourceRepoSection('/tmp/source')).toContain('/tmp/source')
	})
})

describe('renderDiffFileSection', () => {
	test('returns undefined when not provided', () => {
		expect(renderDiffFileSection()).toBeUndefined()
	})

	test('renders path', () => {
		expect(renderDiffFileSection('/tmp/diff.patch')).toContain('/tmp/diff.patch')
	})
})

describe('renderDeterministicContext', () => {
	test('returns undefined when no deterministic changes were applied', () => {
		expect(
			renderDeterministicContext({
				changed: false,
				operations: [],
				touchedFiles: [],
			}),
		).toBeUndefined()
	})

	test('renders deterministic operations and touched files', () => {
		const result = renderDeterministicContext({
			changed: true,
			operations: [
				{
					kind: 'sync',
					source: 'tests/fixtures/**',
					target: 'tests/fixtures/',
					mode: 'mirror',
				},
			],
			touchedFiles: ['tests/fixtures/example.json'],
		})

		expect(result).toContain('Deterministic baseline')
		expect(result).toContain('authoritative baseline')
		expect(result).toContain('[mirror] `tests/fixtures/**` -> `tests/fixtures/`')
		expect(result).toContain('`tests/fixtures/example.json`')
	})
})

describe('renderChangedFiles', () => {
	test('renders file stats', () => {
		const result = renderChangedFiles({
			files: [{ path: 'src/app.ts', status: 'modified', additions: 5, deletions: 2 }],
			targetWorkingDirectory: '/tmp/target',
		})

		expect(result).toContain('Changed files:')
		expect(result).toContain('`src/app.ts` (modified, +5 / -2)')
	})

	test('includes inline patches when no disk context', () => {
		const result = renderChangedFiles({
			files: [
				{
					path: 'src/app.ts',
					status: 'modified',
					additions: 1,
					deletions: 0,
					patch: '@@ added line',
				},
			],
			targetWorkingDirectory: '/tmp/target',
		})

		expect(result).toContain('```diff')
		expect(result).toContain('@@ added line')
	})

	test('omits inline patches when disk context is available', () => {
		const result = renderChangedFiles({
			files: [
				{
					path: 'src/app.ts',
					status: 'modified',
					additions: 1,
					deletions: 0,
					patch: '@@ added line',
				},
			],
			targetWorkingDirectory: '/tmp/target',
			sourceWorkingDirectory: '/tmp/source',
		})

		expect(result).not.toContain('```diff')
		expect(result).toContain('Source repository path: `/tmp/source`')
	})

	test('shows missing-patch note when no patch and no disk context', () => {
		const result = renderChangedFiles({
			files: [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0 }],
			targetWorkingDirectory: '/tmp/target',
		})

		expect(result).toContain('(patch omitted by source API)')
	})

	test('includes diff file reference when provided', () => {
		const result = renderChangedFiles({
			files: [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 0 }],
			targetWorkingDirectory: '/tmp/target',
			diffFilePath: '/tmp/port-diff.patch',
		})

		expect(result).toContain('Full diff file: `/tmp/port-diff.patch`')
	})
})

describe('renderRetryFeedback', () => {
	test('returns undefined for first attempt', () => {
		expect(renderRetryFeedback([])).toBeUndefined()
	})

	test('renders attempt summary with failure details', () => {
		const attempts: ExecutePortAttemptResult[] = [
			{
				attempt: 1,
				status: 'VALIDATION_FAILED',
				touchedFiles: ['src/app.ts'],
				validation: [
					{
						command: 'bun run check',
						ok: false,
						exitCode: 1,
						stdout: '',
						stderr: 'Type error',
						durationMs: 500,
					},
				],
				trace: {
					notes: 'Missed an import.',
					toolCallLog: [],
					events: [],
				},
			},
		]

		const result = renderRetryFeedback(attempts)

		expect(result).toContain('Previous attempt feedback')
		expect(result).toContain('Attempt 1')
		expect(result).toContain('`src/app.ts`')
		expect(result).toContain('Validation failure')
		expect(result).toContain('Type error')
		expect(result).toContain('Missed an import.')
	})

	test('renders multiple attempts', () => {
		const attempts: ExecutePortAttemptResult[] = [
			{
				attempt: 1,
				status: 'VALIDATION_FAILED',
				touchedFiles: ['a.ts'],
				validation: [
					{
						command: 'check',
						ok: false,
						exitCode: 1,
						stdout: '',
						stderr: 'err1',
						durationMs: 1,
					},
				],
				trace: { toolCallLog: [], events: [] },
			},
			{
				attempt: 2,
				status: 'VALIDATION_FAILED',
				touchedFiles: ['a.ts', 'b.ts'],
				validation: [
					{
						command: 'check',
						ok: false,
						exitCode: 1,
						stdout: '',
						stderr: 'err2',
						durationMs: 1,
					},
				],
				trace: { toolCallLog: [], events: [] },
			},
		]

		const result = renderRetryFeedback(attempts)

		expect(result).toContain('Attempt 1')
		expect(result).toContain('Attempt 2')
		expect(result).toContain('err1')
		expect(result).toContain('err2')
	})

	test('shows "none" when no files touched', () => {
		const attempts: ExecutePortAttemptResult[] = [
			{
				attempt: 1,
				status: 'VALIDATION_FAILED',
				touchedFiles: [],
				validation: [],
				trace: { toolCallLog: [], events: [] },
			},
		]

		const result = renderRetryFeedback(attempts)

		expect(result).toContain('Touched files: none')
	})
})

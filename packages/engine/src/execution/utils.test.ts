import { describe, expect, test } from 'bun:test'

import { buildValidationFailureReason } from './utils.ts'

describe('buildValidationFailureReason', () => {
	test('includes failing command and exit code when present', () => {
		const reason = buildValidationFailureReason(
			[
				{
					command: 'bun run check',
					ok: false,
					exitCode: 2,
					stdout: '',
					stderr: 'failed',
					durationMs: 100,
				},
			],
			3,
		)

		expect(reason).toContain('Validation failed after 3 attempts')
		expect(reason).toContain('`bun run check`')
		expect(reason).toContain('(exit code 2)')
	})

	test('falls back to generic message when no failure entry exists', () => {
		const reason = buildValidationFailureReason(
			[
				{
					command: 'bun run check',
					ok: true,
					exitCode: 0,
					stdout: 'ok',
					stderr: '',
					durationMs: 50,
				},
			],
			2,
		)

		expect(reason).toBe('Validation failed after 2 attempts.')
	})
})

import { describe, expect, test } from 'bun:test'

import { parseRsyncItemizedOutput, runShellCommand } from './shell.ts'

describe('runShellCommand', () => {
	test('captures stdout from a successful command', async () => {
		const output = await runShellCommand(['echo', 'hello'])

		expect(output.trim()).toBe('hello')
	})

	test('throws when command exits non-zero', async () => {
		await expect(runShellCommand(['sh', '-c', 'exit 1'])).rejects.toThrow(
			'Command failed (sh -c exit 1): exit 1',
		)
	})

	test('includes stderr in the error message', async () => {
		await expect(runShellCommand(['sh', '-c', 'echo fail >&2; exit 2'])).rejects.toThrow('fail')
	})
})

describe('parseRsyncItemizedOutput', () => {
	/**
	 * @param parts - Path segments.
	 * @returns Joined path.
	 */
	function join(...parts: string[]): string {
		return parts.filter(Boolean).join('/')
	}

	test('parses new file entries', () => {
		const output = '>f+++++++++ a.json\n>f+++++++++ nested/b.json\n'

		expect(parseRsyncItemizedOutput(output, 'fixtures', join)).toEqual([
			'fixtures/a.json',
			'fixtures/nested/b.json',
		])
	})

	test('parses delete entries', () => {
		const output = '*deleting   stale/old.json\n*deleting   stale/\n'

		expect(parseRsyncItemizedOutput(output, 'fixtures', join)).toEqual([
			'fixtures/stale/old.json',
			'fixtures/stale',
		])
	})

	test('skips blank lines and directory-only markers', () => {
		const output = 'cd+++++++++ ./\n>f+++++++++ a.json\n\n'

		expect(parseRsyncItemizedOutput(output, 'target', join)).toEqual(['target/a.json'])
	})

	test('returns empty array for no-change output', () => {
		expect(parseRsyncItemizedOutput('', 'target', join)).toEqual([])
		expect(parseRsyncItemizedOutput('\n\n', 'target', join)).toEqual([])
	})

	test('handles mixed creates, updates, and deletes', () => {
		const output = [
			'>f+++++++++ new-file.txt',
			'>f..t...... updated-file.txt',
			'*deleting   removed.txt',
			'',
		].join('\n')

		expect(parseRsyncItemizedOutput(output, 'base', join)).toEqual([
			'base/new-file.txt',
			'base/updated-file.txt',
			'base/removed.txt',
		])
	})
})

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runValidationCommands } from './run-validation.ts'

const tempDirectories: string[] = []

/**
 * Create and track a temporary directory for one test case.
 *
 * @returns Absolute temp directory path.
 */
async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'repo-port-bot-validation-'))

	tempDirectories.push(directory)

	return directory
}

afterEach(async () => {
	for (const directory of tempDirectories.splice(0, tempDirectories.length)) {
		await rm(directory, { recursive: true, force: true })
	}
})

describe('runValidationCommands', () => {
	test('returns empty list for empty command input', async () => {
		const directory = await createTempDirectory()
		const results = await runValidationCommands({ commands: [], workingDirectory: directory })

		expect(results).toEqual([])
	})

	test('captures stdout/stderr and exit code for successful command', async () => {
		const directory = await createTempDirectory()
		const results = await runValidationCommands({
			commands: ['echo hello && echo warning 1>&2'],
			workingDirectory: directory,
		})

		expect(results).toHaveLength(1)
		expect(results[0]?.ok).toBe(true)
		expect(results[0]?.exitCode).toBe(0)
		expect(results[0]?.stdout).toContain('hello')
		expect(results[0]?.stderr).toContain('warning')
		expect(results[0]?.durationMs).toBeGreaterThanOrEqual(0)
	})

	test('stops on first failure and does not execute later commands', async () => {
		const directory = await createTempDirectory()
		const markerFile = join(directory, 'second-command-ran.txt')
		const results = await runValidationCommands({
			commands: ['false', `echo ran > "${markerFile}"`],
			workingDirectory: directory,
		})

		expect(results).toHaveLength(1)
		expect(results[0]?.ok).toBe(false)
		expect(results[0]?.exitCode).not.toBe(0)

		await expect(readFile(markerFile, 'utf8')).rejects.toThrow()
	})
})

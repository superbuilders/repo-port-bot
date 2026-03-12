import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executeDeterministic } from './execute-deterministic.ts'

const tempDirectories: string[] = []

/**
 * Create a temporary directory for one deterministic test.
 *
 * @returns Absolute temp directory path.
 */
async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'repo-port-bot-deterministic-'))

	tempDirectories.push(directory)

	return directory
}

afterEach(async () => {
	for (const directory of tempDirectories.splice(0, tempDirectories.length)) {
		await rm(directory, { recursive: true, force: true })
	}
})

describe('executeDeterministic', () => {
	test('copies a single file and reports touched target files', async () => {
		const sourceDirectory = await createTempDirectory()
		const targetDirectory = await createTempDirectory()

		await mkdir(join(sourceDirectory, 'tests'), { recursive: true })
		await writeFile(join(sourceDirectory, 'tests/manifest.json'), '{"source":true}')

		const result = await executeDeterministic({
			deterministicOperations: [
				{
					kind: 'sync',
					source: 'tests/manifest.json',
					target: 'tests/manifest.json',
					mode: 'copy',
				},
			],
			sourceWorkingDirectory: sourceDirectory,
			targetWorkingDirectory: targetDirectory,
		})

		expect(result.changed).toBe(true)
		expect(result.touchedFiles).toEqual(['tests/manifest.json'])
		expect(await readFile(join(targetDirectory, 'tests/manifest.json'), 'utf8')).toBe(
			'{"source":true}',
		)
	})

	test('mirrors a directory tree and deletes stale target files', async () => {
		const sourceDirectory = await createTempDirectory()
		const targetDirectory = await createTempDirectory()

		await mkdir(join(sourceDirectory, 'tests/fixtures/nested'), { recursive: true })
		await mkdir(join(targetDirectory, 'tests/fixtures/stale'), { recursive: true })
		await writeFile(join(sourceDirectory, 'tests/fixtures/a.json'), '{"a":1}')
		await writeFile(join(sourceDirectory, 'tests/fixtures/nested/b.json'), '{"b":2}')
		await writeFile(join(targetDirectory, 'tests/fixtures/stale/old.json'), '{"old":true}')

		const result = await executeDeterministic({
			deterministicOperations: [
				{
					kind: 'sync',
					source: 'tests/fixtures/**',
					target: 'tests/fixtures/',
					mode: 'mirror',
				},
			],
			sourceWorkingDirectory: sourceDirectory,
			targetWorkingDirectory: targetDirectory,
		})

		expect(result.changed).toBe(true)
		expect(result.touchedFiles).toContain('tests/fixtures/stale/old.json')
		expect(result.touchedFiles).toContain('tests/fixtures/a.json')
		expect(result.touchedFiles).toContain('tests/fixtures/nested/b.json')
		expect(await readFile(join(targetDirectory, 'tests/fixtures/a.json'), 'utf8')).toBe(
			'{"a":1}',
		)
		expect(await readFile(join(targetDirectory, 'tests/fixtures/nested/b.json'), 'utf8')).toBe(
			'{"b":2}',
		)
		expect(
			readFile(join(targetDirectory, 'tests/fixtures/stale/old.json'), 'utf8'),
		).rejects.toThrow()
	})

	test('returns unchanged when target already matches source state', async () => {
		const sourceDirectory = await createTempDirectory()
		const targetDirectory = await createTempDirectory()

		await mkdir(join(sourceDirectory, 'tests/fixtures'), { recursive: true })
		await mkdir(join(targetDirectory, 'tests/fixtures'), { recursive: true })
		await writeFile(join(sourceDirectory, 'tests/fixtures/a.json'), '{"a":1}')
		await writeFile(join(targetDirectory, 'tests/fixtures/a.json'), '{"a":1}')

		const result = await executeDeterministic({
			deterministicOperations: [
				{
					kind: 'sync',
					source: 'tests/fixtures/**',
					target: 'tests/fixtures/',
					mode: 'mirror',
				},
			],
			sourceWorkingDirectory: sourceDirectory,
			targetWorkingDirectory: targetDirectory,
		})

		expect(result.changed).toBe(false)
		expect(result.touchedFiles).toEqual([])
	})

	test('replaces an existing target directory with a synced file in copy mode', async () => {
		const sourceDirectory = await createTempDirectory()
		const targetDirectory = await createTempDirectory()

		await mkdir(join(sourceDirectory, 'tests'), { recursive: true })
		await mkdir(join(targetDirectory, 'tests/manifest.json'), { recursive: true })
		await writeFile(join(sourceDirectory, 'tests/manifest.json'), '{"source":true}')
		await writeFile(join(targetDirectory, 'tests/manifest.json/old.txt'), 'old')

		const result = await executeDeterministic({
			deterministicOperations: [
				{
					kind: 'sync',
					source: 'tests/manifest.json',
					target: 'tests/manifest.json',
					mode: 'copy',
				},
			],
			sourceWorkingDirectory: sourceDirectory,
			targetWorkingDirectory: targetDirectory,
		})

		expect(result.changed).toBe(true)
		expect(result.touchedFiles).toEqual(['tests/manifest.json'])
		expect(await readFile(join(targetDirectory, 'tests/manifest.json'), 'utf8')).toBe(
			'{"source":true}',
		)
		expect(
			readFile(join(targetDirectory, 'tests/manifest.json/old.txt'), 'utf8'),
		).rejects.toThrow()
	})

	test('replaces an existing target file with a mirrored directory tree', async () => {
		const sourceDirectory = await createTempDirectory()
		const targetDirectory = await createTempDirectory()

		await mkdir(join(sourceDirectory, 'tests/fixtures'), { recursive: true })
		await mkdir(join(targetDirectory, 'tests'), { recursive: true })
		await writeFile(join(sourceDirectory, 'tests/fixtures/a.json'), '{"a":1}')
		await writeFile(join(targetDirectory, 'tests/fixtures'), 'old-file')

		const result = await executeDeterministic({
			deterministicOperations: [
				{
					kind: 'sync',
					source: 'tests/fixtures/**',
					target: 'tests/fixtures/',
					mode: 'mirror',
				},
			],
			sourceWorkingDirectory: sourceDirectory,
			targetWorkingDirectory: targetDirectory,
		})

		expect(result.changed).toBe(true)
		expect(result.touchedFiles.sort()).toEqual(['tests/fixtures', 'tests/fixtures/a.json'])
		expect(await readFile(join(targetDirectory, 'tests/fixtures/a.json'), 'utf8')).toBe(
			'{"a":1}',
		)
	})

	test('removes an existing target directory when a copy source is absent', async () => {
		const sourceDirectory = await createTempDirectory()
		const targetDirectory = await createTempDirectory()

		await mkdir(join(targetDirectory, 'tests/manifest.json'), { recursive: true })
		await writeFile(join(targetDirectory, 'tests/manifest.json/old.txt'), 'old')

		const result = await executeDeterministic({
			deterministicOperations: [
				{
					kind: 'sync',
					source: 'tests/manifest.json',
					target: 'tests/manifest.json',
					mode: 'copy',
				},
			],
			sourceWorkingDirectory: sourceDirectory,
			targetWorkingDirectory: targetDirectory,
		})

		expect(result.changed).toBe(true)
		expect(result.touchedFiles).toEqual(['tests/manifest.json'])
		expect(
			readFile(join(targetDirectory, 'tests/manifest.json/old.txt'), 'utf8'),
		).rejects.toThrow()
	})

	test('rejects copy operations whose target escapes the target checkout', async () => {
		const sourceDirectory = await createTempDirectory()
		const targetDirectory = await createTempDirectory()

		await mkdir(join(sourceDirectory, 'tests'), { recursive: true })
		await writeFile(join(sourceDirectory, 'tests/manifest.json'), '{"source":true}')

		expect(
			executeDeterministic({
				deterministicOperations: [
					{
						kind: 'sync',
						source: 'tests/manifest.json',
						target: '../leak.txt',
						mode: 'copy',
					},
				],
				sourceWorkingDirectory: sourceDirectory,
				targetWorkingDirectory: targetDirectory,
			}),
		).rejects.toThrow('Sync target path escaped the repo checkout: ../leak.txt')
	})

	test('rejects mirror operations whose source base escapes the source checkout', async () => {
		const sourceDirectory = await createTempDirectory()
		const targetDirectory = await createTempDirectory()

		expect(
			executeDeterministic({
				deterministicOperations: [
					{
						kind: 'sync',
						source: '../secrets/**',
						target: 'tests/fixtures/',
						mode: 'mirror',
					},
				],
				sourceWorkingDirectory: sourceDirectory,
				targetWorkingDirectory: targetDirectory,
			}),
		).rejects.toThrow('Sync source glob base escaped the repo checkout: ../secrets')
	})
})

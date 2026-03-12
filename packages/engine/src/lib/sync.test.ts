import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { applySyncOperation } from './sync.ts'

const tempDirectories: string[] = []

/**
 * @returns Absolute temp directory path.
 */
async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'repo-port-bot-sync-'))

	tempDirectories.push(directory)

	return directory
}

afterEach(async () => {
	for (const directory of tempDirectories.splice(0, tempDirectories.length)) {
		await rm(directory, { recursive: true, force: true })
	}
})

describe('applySyncOperation', () => {
	describe('copy mode', () => {
		test('copies a file from source to target', async () => {
			const source = await createTempDirectory()
			const target = await createTempDirectory()
			const touched = new Set<string>()

			await mkdir(join(source, 'data'), { recursive: true })
			await writeFile(join(source, 'data/config.json'), '{"v":1}')

			await applySyncOperation({
				operation: {
					kind: 'sync',
					mode: 'copy',
					source: 'data/config.json',
					target: 'data/config.json',
				},
				sourceWorkingDirectory: source,
				targetWorkingDirectory: target,
				touchedFiles: touched,
			})

			expect(await readFile(join(target, 'data/config.json'), 'utf8')).toBe('{"v":1}')
			expect(touched.has('data/config.json')).toBe(true)
		})

		test('removes target when source is absent', async () => {
			const source = await createTempDirectory()
			const target = await createTempDirectory()
			const touched = new Set<string>()

			await mkdir(join(target, 'data'), { recursive: true })
			await writeFile(join(target, 'data/config.json'), '{"old":true}')

			await applySyncOperation({
				operation: {
					kind: 'sync',
					mode: 'copy',
					source: 'data/config.json',
					target: 'data/config.json',
				},
				sourceWorkingDirectory: source,
				targetWorkingDirectory: target,
				touchedFiles: touched,
			})

			await expect(readFile(join(target, 'data/config.json'), 'utf8')).rejects.toThrow()
			expect(touched.has('data/config.json')).toBe(true)
		})

		test('no-ops when source and target are identical', async () => {
			const source = await createTempDirectory()
			const target = await createTempDirectory()
			const touched = new Set<string>()

			await mkdir(join(source, 'data'), { recursive: true })
			await mkdir(join(target, 'data'), { recursive: true })
			await writeFile(join(source, 'data/config.json'), '{"v":1}')
			await writeFile(join(target, 'data/config.json'), '{"v":1}')

			await applySyncOperation({
				operation: {
					kind: 'sync',
					mode: 'copy',
					source: 'data/config.json',
					target: 'data/config.json',
				},
				sourceWorkingDirectory: source,
				targetWorkingDirectory: target,
				touchedFiles: touched,
			})

			expect(touched.size).toBe(0)
		})
	})

	describe('mirror mode', () => {
		test('syncs files and removes stale target files', async () => {
			const source = await createTempDirectory()
			const target = await createTempDirectory()
			const touched = new Set<string>()

			await mkdir(join(source, 'fixtures'), { recursive: true })
			await mkdir(join(target, 'fixtures'), { recursive: true })
			await writeFile(join(source, 'fixtures/a.json'), '1')
			await writeFile(join(target, 'fixtures/stale.json'), '2')

			await applySyncOperation({
				operation: {
					kind: 'sync',
					mode: 'mirror',
					source: 'fixtures/**',
					target: 'fixtures/',
				},
				sourceWorkingDirectory: source,
				targetWorkingDirectory: target,
				touchedFiles: touched,
			})

			expect(await readFile(join(target, 'fixtures/a.json'), 'utf8')).toBe('1')
			await expect(readFile(join(target, 'fixtures/stale.json'), 'utf8')).rejects.toThrow()
			expect(touched.has('fixtures/a.json')).toBe(true)
		})

		test('no-ops when already in sync', async () => {
			const source = await createTempDirectory()
			const target = await createTempDirectory()
			const touched = new Set<string>()

			await mkdir(join(source, 'fixtures'), { recursive: true })
			await mkdir(join(target, 'fixtures'), { recursive: true })
			await writeFile(join(source, 'fixtures/a.json'), '1')
			await writeFile(join(target, 'fixtures/a.json'), '1')

			await applySyncOperation({
				operation: {
					kind: 'sync',
					mode: 'mirror',
					source: 'fixtures/**',
					target: 'fixtures/',
				},
				sourceWorkingDirectory: source,
				targetWorkingDirectory: target,
				touchedFiles: touched,
			})

			expect(touched.size).toBe(0)
		})
	})
})

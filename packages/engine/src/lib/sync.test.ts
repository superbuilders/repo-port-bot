import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

		test('no-ops when JSON files differ only in formatting', async () => {
			const source = await createTempDirectory()
			const target = await createTempDirectory()
			const touched = new Set<string>()

			const compact = '{"items":["a","b","c"],"count":3}'
			const expanded = '{\n\t"items": [\n\t\t"a",\n\t\t"b",\n\t\t"c"\n\t],\n\t"count": 3\n}'

			await mkdir(join(source, 'data'), { recursive: true })
			await mkdir(join(target, 'data'), { recursive: true })
			await writeFile(join(source, 'data/manifest.json'), compact)
			await writeFile(join(target, 'data/manifest.json'), expanded)

			await applySyncOperation({
				operation: {
					kind: 'sync',
					mode: 'copy',
					source: 'data/manifest.json',
					target: 'data/manifest.json',
				},
				sourceWorkingDirectory: source,
				targetWorkingDirectory: target,
				touchedFiles: touched,
			})

			expect(touched.size).toBe(0)
			expect(await readFile(join(target, 'data/manifest.json'), 'utf8')).toBe(expanded)
		})

		test('copies JSON file when content actually differs', async () => {
			const source = await createTempDirectory()
			const target = await createTempDirectory()
			const touched = new Set<string>()

			await mkdir(join(source, 'data'), { recursive: true })
			await mkdir(join(target, 'data'), { recursive: true })
			await writeFile(join(source, 'data/manifest.json'), '{"items":["a","b","c","d"]}')
			await writeFile(
				join(target, 'data/manifest.json'),
				'{\n\t"items": [\n\t\t"a",\n\t\t"b",\n\t\t"c"\n\t]\n}',
			)

			await applySyncOperation({
				operation: {
					kind: 'sync',
					mode: 'copy',
					source: 'data/manifest.json',
					target: 'data/manifest.json',
				},
				sourceWorkingDirectory: source,
				targetWorkingDirectory: target,
				touchedFiles: touched,
			})

			expect(touched.has('data/manifest.json')).toBe(true)
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

		test('creates empty source directories in target and removes stale empty target directories', async () => {
			const source = await createTempDirectory()
			const target = await createTempDirectory()
			const touched = new Set<string>()

			await mkdir(join(source, 'fixtures/empty-dir'), { recursive: true })
			await mkdir(join(target, 'fixtures/stale-empty'), { recursive: true })

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

			const emptyDirStats = await stat(join(target, 'fixtures/empty-dir'))

			expect(emptyDirStats.isDirectory()).toBe(true)
			await expect(stat(join(target, 'fixtures/stale-empty'))).rejects.toThrow()
		})

		test('mirrors into a brand-new nested target directory', async () => {
			const source = await createTempDirectory()
			const target = await createTempDirectory()
			const touched = new Set<string>()

			await mkdir(join(source, 'nested/fixtures'), { recursive: true })
			await writeFile(join(source, 'nested/fixtures/a.json'), '1')

			await applySyncOperation({
				operation: {
					kind: 'sync',
					mode: 'mirror',
					source: 'nested/fixtures/**',
					target: 'nested/fixtures/',
				},
				sourceWorkingDirectory: source,
				targetWorkingDirectory: target,
				touchedFiles: touched,
			})

			expect(await readFile(join(target, 'nested/fixtures/a.json'), 'utf8')).toBe('1')
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

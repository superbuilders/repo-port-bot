/**
 * Temp git repo creation and lifecycle for scenario tests.
 */
import { afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { RepoSetup } from './types.ts'

const tempDirectories: string[] = []

/**
 * @param prefix - Temp directory name prefix.
 * @returns Absolute temp directory path.
 */
async function createTempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), `port-bot-scenario-${prefix}-`))

	tempDirectories.push(dir)

	return dir
}

/**
 * Register an afterEach hook to clean up temp directories.
 */
export function cleanupTempDirs(): void {
	afterEach(async () => {
		const { rm } = await import('node:fs/promises')

		for (const dir of tempDirectories.splice(0, tempDirectories.length)) {
			await rm(dir, { recursive: true, force: true })
		}
	})
}

/**
 * @param cwd - Working directory.
 * @param args - Git arguments.
 */
function git(cwd: string, ...args: string[]): void {
	const result = spawnSync('git', args, { cwd, stdio: 'pipe' })

	if (result.status !== 0) {
		const stderr = result.stderr?.toString() ?? ''

		throw new Error(`git ${args.join(' ')} failed (${String(result.status)}): ${stderr}`)
	}
}

/**
 * Create a target repo with a bare remote (so `git push` works) and an
 * optional source repo for deterministic sync operations.
 *
 * @param initialTargetFiles - Files to seed in the target repo.
 * @param initialSourceFiles - Files to seed in the source repo.
 * @returns Local repo paths.
 */
export async function createRepos(
	initialTargetFiles?: Record<string, string>,
	initialSourceFiles?: Record<string, string>,
): Promise<RepoSetup> {
	const bareRemoteDir = await createTempDir('remote')
	const targetDir = await createTempDir('target')
	const sourceDir = await createTempDir('source')

	git(bareRemoteDir, 'init', '--bare')

	git(targetDir, 'init')
	git(targetDir, 'remote', 'add', 'origin', bareRemoteDir)
	git(
		targetDir,
		'-c',
		'user.name=test',
		'-c',
		'user.email=test@test.com',
		'commit',
		'--allow-empty',
		'-m',
		'init',
	)

	if (initialTargetFiles) {
		for (const [path, content] of Object.entries(initialTargetFiles)) {
			const fullPath = join(targetDir, path)

			await mkdir(join(fullPath, '..'), { recursive: true })
			await writeFile(fullPath, content)
		}

		git(targetDir, 'add', '-A')
		git(
			targetDir,
			'-c',
			'user.name=test',
			'-c',
			'user.email=test@test.com',
			'commit',
			'-m',
			'seed target',
		)
	}

	git(targetDir, 'push', '-u', 'origin', 'HEAD')

	if (initialSourceFiles) {
		git(sourceDir, 'init')

		for (const [path, content] of Object.entries(initialSourceFiles)) {
			const fullPath = join(sourceDir, path)

			await mkdir(join(fullPath, '..'), { recursive: true })
			await writeFile(fullPath, content)
		}

		git(sourceDir, 'add', '-A')
		git(
			sourceDir,
			'-c',
			'user.name=test',
			'-c',
			'user.email=test@test.com',
			'commit',
			'-m',
			'seed source',
		)
	}

	return { targetDir, bareRemoteDir, sourceDir }
}

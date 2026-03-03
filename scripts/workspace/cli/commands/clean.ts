#!/usr/bin/env bun
/**
 * Clean build artifacts and dependencies across all packages.
 *
 * Deletes from root and all workspace packages:
 *   - dist/          (build output)
 *   - .tsbuildinfo   (TypeScript incremental build cache)
 *
 * With --all flag, also deletes:
 *   - node_modules/  (requires re-running `bun install`)
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import * as p from '@clack/prompts'
import { greenBright } from 'colorette'

import type { CleanOptions, PackageJson } from './types'

const CLEAN_DIRS = ['dist', '.tsbuildinfo']
const CLEAN_ALL_DIRS = [...CLEAN_DIRS, 'node_modules']
const EXIT_SUCCESS = 0

// ─────────────────────────────────────────────────────────────────────────────
// Main Export
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Clean build artifacts and dependencies across all packages.
 *
 * @param options - Clean options
 * @returns Number of directories cleaned
 */
export async function clean(options: CleanOptions = {}): Promise<number> {
	const { all = false, skipConfirm = false, silent = false } = options
	const dirsToClean = all ? CLEAN_ALL_DIRS : CLEAN_DIRS

	const rootPkg: PackageJson = await Bun.file('package.json').json()
	const workspacePatterns = Array.isArray(rootPkg.workspaces)
		? rootPkg.workspaces
		: (rootPkg.workspaces?.packages ?? [])

	const packageDirs = workspacePatterns
		.filter(pattern => pattern.endsWith('/*'))
		.map(pattern => pattern.replace('/*', ''))

	const packagePaths: string[] = []
	const nestedDirs = packageDirs.filter(dir => dir.includes('/'))

	for (const dir of packageDirs) {
		if (existsSync(dir)) {
			const entries = readdirSync(dir, { withFileTypes: true })
				.filter(d => d.isDirectory() && !d.name.startsWith('_'))
				.filter(d => !nestedDirs.some(nested => nested === join(dir, d.name)))

			for (const entry of entries) {
				packagePaths.push(join(dir, entry.name))
			}
		}
	}

	if (all && !skipConfirm) {
		p.note(`This will also remove ${greenBright('node_modules')}.`)

		const confirmed = await p.confirm({
			message: 'Continue?',
			initialValue: false,
		})

		if (p.isCancel(confirmed) || !confirmed) {
			p.cancel('Cancelled')
			process.exit(EXIT_SUCCESS)
		}
	}

	const s = p.spinner()

	s.start('Cleaning')

	let count = 0

	for (const dir of dirsToClean) {
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true })
			count++
		}
	}

	for (const pkgPath of packagePaths) {
		for (const dir of dirsToClean) {
			const targetPath = join(pkgPath, dir)

			if (existsSync(targetPath)) {
				rmSync(targetPath, { recursive: true, force: true })
				count++
			}
		}
	}

	s.stop(`Cleaned ${count} directories`)

	if (!silent && all) {
		p.log.info('Next step: bun install')
	}

	return count
}

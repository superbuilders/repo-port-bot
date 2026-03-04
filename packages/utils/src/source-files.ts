import { join } from 'node:path'

import type { SourceFileOptions } from './types.ts'

/**
 * Directories to exclude from source file scanning.
 */
const EXCLUDED_DIRS = ['node_modules/', 'dist/', '.next/', '.turbo/', 'srcref/']

/**
 * Check whether a file path should be skipped during scanning.
 *
 * Excludes .d.ts files and paths under node_modules, dist, etc.
 *
 * @param filePath - Path to check
 * @returns True if the path should be excluded
 */
function isExcludedPath(filePath: string): boolean {
	if (filePath.endsWith('.d.ts')) {
		return true
	}

	return EXCLUDED_DIRS.some(dir => filePath.includes(dir))
}

/**
 * Build the full relative path from a scan result.
 *
 * @param directory - Scan directory (e.g. '.' or 'src')
 * @param path - Glob result path
 * @returns Combined path
 */
function buildFilePath(directory: string, path: string): string {
	if (directory === '.') {
		return path
	}

	return join(directory, path)
}

/**
 * Get all TypeScript source files matching the given options.
 *
 * Scans for `.ts` and `.tsx` files, excluding common non-source
 * directories (node_modules, dist, .next, .turbo) and declaration files.
 *
 * @param options - Optional directory and exclude filter
 * @returns Sorted array of relative file paths
 */
export function getSourceFiles(options?: SourceFileOptions): string[] {
	const directory = (options && options.directory) || '.'
	const exclude = options && options.exclude

	const glob = new Bun.Glob('**/*.{ts,tsx}')
	const paths = [...glob.scanSync(directory)]

	return paths
		.map(scanned => buildFilePath(directory, scanned))
		.filter(file => !isExcludedPath(file))
		.filter(file => !exclude || !exclude(file))
		.toSorted()
}

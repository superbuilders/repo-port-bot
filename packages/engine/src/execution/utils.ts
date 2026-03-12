import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { ValidationCommandResult } from '../types.ts'

/**
 * Build a failure reason from validation command output.
 *
 * @param validation - Validation result list from one attempt.
 * @param attempts - Number of attempts that were executed.
 * @returns Failure reason for final execution result.
 */
export function buildValidationFailureReason(
	validation: ValidationCommandResult[],
	attempts: number,
): string {
	const failed = validation.find(result => !result.ok)

	if (!failed) {
		return `Validation failed after ${String(attempts)} attempts.`
	}

	const exitCodeSuffix =
		failed.exitCode === undefined ? '' : ` (exit code ${String(failed.exitCode)})`

	return `Validation failed after ${String(attempts)} attempts: \`${failed.command}\`${exitCodeSuffix}.`
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Read path metadata when it exists.
 *
 * @param path - Absolute path.
 * @returns Stats object or undefined when absent.
 */
async function statIfExists(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
	try {
		return await stat(path)
	} catch {
		return undefined
	}
}

/**
 * Check whether a path exists.
 *
 * @param path - Absolute path.
 * @returns True when the path exists.
 */
export async function pathExists(path: string): Promise<boolean> {
	return (await statIfExists(path)) !== undefined
}

/**
 * Recursively list files within a directory as paths relative to that directory.
 *
 * @param directoryPath - Absolute directory path.
 * @returns Relative file paths using `/` separators.
 */
export async function listFilesWithinDirectory(directoryPath: string): Promise<string[]> {
	if (!(await pathExists(directoryPath))) {
		return []
	}

	const directoryEntries = await readdir(directoryPath, { withFileTypes: true })
	const files: string[] = []

	for (const entry of directoryEntries) {
		const entryPath = join(directoryPath, entry.name)

		if (entry.isDirectory()) {
			const nestedFiles = await listFilesWithinDirectory(entryPath)

			for (const nestedFile of nestedFiles) {
				files.push(joinRelativePath(entry.name, nestedFile))
			}
		} else if (entry.isFile()) {
			files.push(entry.name)
		}
	}

	return files
}

/**
 * Recursively list directories within a directory as paths relative to that directory.
 *
 * Returns leaf directories (directories with no subdirectories) and empty directories.
 *
 * @param directoryPath - Absolute directory path.
 * @returns Relative directory paths using `/` separators.
 */
export async function listDirectoriesWithinDirectory(directoryPath: string): Promise<string[]> {
	if (!(await pathExists(directoryPath))) {
		return []
	}

	const directoryEntries = await readdir(directoryPath, { withFileTypes: true })
	const directories: string[] = []

	for (const entry of directoryEntries) {
		if (entry.isDirectory()) {
			directories.push(entry.name)

			const entryPath = join(directoryPath, entry.name)
			const nestedDirs = await listDirectoriesWithinDirectory(entryPath)

			for (const nestedDir of nestedDirs) {
				directories.push(joinRelativePath(entry.name, nestedDir))
			}
		}
	}

	return directories
}

/**
 * Copy a file only when contents differ.
 *
 * Handles file/directory type transitions: if the target path is currently a
 * directory, it is removed before writing the file.
 *
 * @param sourcePath - Absolute source file path.
 * @param targetPath - Absolute target file path.
 * @param targetRelativePath - Repo-relative target path.
 * @param targetWorkingDirectory - Target checkout root for parent-path normalization.
 * @param touchedFiles - Accumulator for changed paths.
 */
export async function syncFile(
	sourcePath: string,
	targetPath: string,
	targetRelativePath: string,
	targetWorkingDirectory: string,
	touchedFiles: Set<string>,
): Promise<void> {
	const sourceContents = await readFile(sourcePath)
	const targetStats = await statIfExists(targetPath)

	if (targetStats?.isDirectory()) {
		await rm(targetPath, { recursive: true, force: true })
		touchedFiles.add(targetRelativePath)
	} else if (targetStats?.isFile()) {
		const existingTargetContents = await readFile(targetPath)

		if (sourceContents.equals(existingTargetContents)) {
			return
		}
	}

	await ensureDirectoryPath(dirname(targetPath), targetWorkingDirectory, touchedFiles)
	await writeFile(targetPath, sourceContents)
	touchedFiles.add(targetRelativePath)
}

/**
 * Ensure a target directory path exists and remove any conflicting file ancestors.
 *
 * @param directoryPath - Absolute directory path that must exist as a directory.
 * @param targetWorkingDirectory - Target checkout root for touched-path tracking.
 * @param touchedFiles - Accumulator for changed paths.
 */
async function ensureDirectoryPath(
	directoryPath: string,
	targetWorkingDirectory: string,
	touchedFiles: Set<string>,
): Promise<void> {
	if (directoryPath === targetWorkingDirectory) {
		return
	}

	const parentPath = dirname(directoryPath)

	if (parentPath !== directoryPath) {
		await ensureDirectoryPath(parentPath, targetWorkingDirectory, touchedFiles)
	}

	const stats = await statIfExists(directoryPath)

	if (stats?.isDirectory()) {
		return
	}

	if (stats) {
		await rm(directoryPath, { recursive: true, force: true })

		const relativePath = normalizeRelativePath(relative(targetWorkingDirectory, directoryPath))

		if (relativePath.length > 0) {
			touchedFiles.add(relativePath)
		}
	}

	await mkdir(directoryPath, { recursive: true })
}

/**
 * Remove a path when it exists but is not a directory.
 *
 * @param absolutePath - Absolute path that should either be missing or a directory.
 * @param relativePath - Repo-relative path for touched-path tracking.
 * @param touchedFiles - Accumulator for changed paths.
 */
export async function clearNonDirectoryPath(
	absolutePath: string,
	relativePath: string,
	touchedFiles: Set<string>,
): Promise<void> {
	const stats = await statIfExists(absolutePath)

	if (!stats || stats.isDirectory()) {
		return
	}

	await rm(absolutePath, { recursive: true, force: true })
	touchedFiles.add(relativePath)
}

/**
 * Resolve a repo-relative path and ensure it stays within the checkout root.
 *
 * @param rootDirectory - Checkout root.
 * @param relativePath - Repo-relative path or base path.
 * @param label - Human-readable label for error messages.
 * @returns Absolute resolved path within the checkout root.
 */
export function resolveContainedPath(
	rootDirectory: string,
	relativePath: string,
	label: string,
): string {
	const resolvedPath = resolve(rootDirectory, relativePath)
	const relativeToRoot = relative(rootDirectory, resolvedPath)

	if (
		relativeToRoot === '..' ||
		relativeToRoot.startsWith(`..${sep}`) ||
		isAbsolute(relativeToRoot)
	) {
		throw new Error(`${label} escaped the repo checkout: ${relativePath}`)
	}

	return resolvedPath
}

// ---------------------------------------------------------------------------
// Path string helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a repo-relative path to use `/` separators.
 *
 * @param path - Relative path.
 * @returns Normalized path.
 */
export function normalizeRelativePath(path: string): string {
	return path
		.split(sep)
		.join('/')
		.replace(/^\.\/+/u, '')
		.replace(/\/$/u, '')
}

/**
 * Join repo-relative path segments using `/`.
 *
 * @param parts - Path segments.
 * @returns Joined relative path.
 */
export function joinRelativePath(...parts: string[]): string {
	return parts.filter(part => part.length > 0).join('/')
}

/**
 * Remove trailing slashes from a target path.
 *
 * @param path - Relative path.
 * @returns Path without a trailing slash.
 */
export function trimTrailingSlash(path: string): string {
	return path.replace(/\/+$/u, '')
}

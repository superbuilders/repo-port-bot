import { mkdir, rm, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

import micromatch from 'micromatch'

import {
	clearNonDirectoryPath,
	joinRelativePath,
	listDirectoriesWithinDirectory,
	listFilesWithinDirectory,
	normalizeRelativePath,
	pathExists,
	resolveContainedPath,
	syncFile,
	trimTrailingSlash,
} from '../execution/utils.ts'
import { isRsyncAvailable, parseRsyncItemizedOutput, runShellCommand } from './shell.ts'

import type { SyncOperation } from '../types.ts'

interface ApplySyncOperationInput {
	operation: SyncOperation
	sourceWorkingDirectory: string
	targetWorkingDirectory: string
	touchedFiles: Set<string>
}

/**
 * Apply a sync operation (mirror or copy).
 *
 * @param input - Sync operation input.
 */
export async function applySyncOperation(input: ApplySyncOperationInput): Promise<void> {
	if (input.operation.mode === 'copy') {
		await applyCopyOperation(input)
	} else {
		await applyMirrorOperation(input)
	}
}

/**
 * Apply a single-file copy operation.
 *
 * Missing source files remove the target file so the target reflects source state.
 *
 * @param input - Operation input.
 */
async function applyCopyOperation(input: ApplySyncOperationInput): Promise<void> {
	const sourcePath = resolveContainedPath(
		input.sourceWorkingDirectory,
		input.operation.source,
		'Sync source path',
	)
	const targetRelativePath = trimTrailingSlash(input.operation.target)
	const targetPath = resolveContainedPath(
		input.targetWorkingDirectory,
		targetRelativePath,
		'Sync target path',
	)

	if (!(await pathExists(sourcePath))) {
		if (await pathExists(targetPath)) {
			await rm(targetPath, { recursive: true, force: true })
			input.touchedFiles.add(targetRelativePath)
		}

		return
	}

	const sourceStats = await stat(sourcePath)

	if (!sourceStats.isFile()) {
		throw new Error(`Copy source must be a file: ${input.operation.source}`)
	}

	await syncFile(
		sourcePath,
		targetPath,
		targetRelativePath,
		input.targetWorkingDirectory,
		input.touchedFiles,
	)
}

// ---------------------------------------------------------------------------
// Mirror: rsync with TS fallback
// ---------------------------------------------------------------------------

/**
 * Apply a directory mirror operation with delete semantics.
 *
 * Prefers `rsync --delete` when available on the host. Falls back to a pure
 * TypeScript implementation when rsync is not installed.
 *
 * @param input - Operation input.
 */
async function applyMirrorOperation(input: ApplySyncOperationInput): Promise<void> {
	const scanResult = micromatch.scan(input.operation.source)
	const sourceBase = normalizeRelativePath(scanResult.base)
	const sourcePath = resolveContainedPath(
		input.sourceWorkingDirectory,
		sourceBase.length === 0 ? '.' : sourceBase,
		'Sync source glob base',
	)
	const targetBase = trimTrailingSlash(input.operation.target)
	const targetPath = resolveContainedPath(
		input.targetWorkingDirectory,
		targetBase,
		'Sync target base path',
	)

	await clearNonDirectoryPath(targetPath, targetBase, input.touchedFiles)

	const isWholeDirectoryGlob = scanResult.glob === '**'
	const sourceExists = await pathExists(sourcePath)

	if (isWholeDirectoryGlob && sourceExists && (await isRsyncAvailable())) {
		await applyMirrorWithRsync(sourcePath, targetPath, targetBase, input.touchedFiles)
	} else {
		await applyMirrorWithTypeScript(input)
	}
}

/**
 * Mirror using rsync --delete with itemized dry-run for touched-file tracking.
 *
 * @param sourcePath - Absolute source directory path.
 * @param targetPath - Absolute target directory path.
 * @param targetBase - Repo-relative target base for touched-path tracking.
 * @param touchedFiles - Accumulator for changed paths.
 */
async function applyMirrorWithRsync(
	sourcePath: string,
	targetPath: string,
	targetBase: string,
	touchedFiles: Set<string>,
): Promise<void> {
	const sourceTrailing = sourcePath.endsWith('/') ? sourcePath : `${sourcePath}/`
	const targetTrailing = targetPath.endsWith('/') ? targetPath : `${targetPath}/`

	await mkdir(targetPath, { recursive: true })

	const dryRunOutput = await runShellCommand([
		'rsync',
		'-a',
		'--delete',
		'--dry-run',
		'--itemize-changes',
		sourceTrailing,
		targetTrailing,
	])

	const hasChanges = dryRunOutput.trim().length > 0

	if (!hasChanges) {
		return
	}

	await runShellCommand(['rsync', '-a', '--delete', sourceTrailing, targetTrailing])

	const changedPaths = parseRsyncItemizedOutput(dryRunOutput, targetBase, joinRelativePath)

	for (const path of changedPaths) {
		touchedFiles.add(path)
	}
}

// ---------------------------------------------------------------------------
// Mirror: TypeScript fallback
// ---------------------------------------------------------------------------

/**
 * Pure TypeScript mirror implementation used when rsync is not available.
 *
 * @param input - Operation input.
 */
async function applyMirrorWithTypeScript(input: ApplySyncOperationInput): Promise<void> {
	const sourceFiles = await expandSourceGlob(input.operation.source, input.sourceWorkingDirectory)
	const sourceBase = normalizeRelativePath(micromatch.scan(input.operation.source).base)
	const targetBase = trimTrailingSlash(input.operation.target)
	const expectedTargetFiles = new Map<string, string>()

	for (const sourceRelativePath of sourceFiles) {
		const relativeSuffix =
			sourceBase.length === 0
				? sourceRelativePath
				: normalizeRelativePath(relative(sourceBase, sourceRelativePath))
		const targetRelativePath = joinRelativePath(targetBase, relativeSuffix)

		expectedTargetFiles.set(
			targetRelativePath,
			join(input.sourceWorkingDirectory, sourceRelativePath),
		)
	}

	const targetBasePath = resolveContainedPath(
		input.targetWorkingDirectory,
		targetBase,
		'Sync target base path',
	)

	await clearNonDirectoryPath(targetBasePath, targetBase, input.touchedFiles)

	const existingTargetFiles = await listFilesWithinDirectory(targetBasePath)

	for (const existingTargetFile of existingTargetFiles) {
		const targetRelativePath = joinRelativePath(targetBase, existingTargetFile)

		if (!expectedTargetFiles.has(targetRelativePath)) {
			await rm(
				resolveContainedPath(
					input.targetWorkingDirectory,
					targetRelativePath,
					'Sync target path',
				),
				{ force: true },
			)
			input.touchedFiles.add(targetRelativePath)
		}
	}

	for (const [targetRelativePath, sourceFilePath] of expectedTargetFiles) {
		const targetFilePath = resolveContainedPath(
			input.targetWorkingDirectory,
			targetRelativePath,
			'Sync target path',
		)

		await syncFile(
			sourceFilePath,
			targetFilePath,
			targetRelativePath,
			input.targetWorkingDirectory,
			input.touchedFiles,
		)
	}

	const sourceBasePath = resolveContainedPath(
		input.sourceWorkingDirectory,
		sourceBase.length === 0 ? '.' : sourceBase,
		'Sync source base path',
	)
	const sourceDirs = await listDirectoriesWithinDirectory(sourceBasePath)

	for (const sourceDir of sourceDirs) {
		const targetDirRelative = joinRelativePath(targetBase, sourceDir)
		const targetDirAbsolute = join(input.targetWorkingDirectory, targetDirRelative)

		if (!(await pathExists(targetDirAbsolute))) {
			await mkdir(targetDirAbsolute, { recursive: true })
			input.touchedFiles.add(targetDirRelative)
		}
	}

	const existingTargetDirs = await listDirectoriesWithinDirectory(targetBasePath)

	for (const existingDir of existingTargetDirs) {
		const targetDirRelative = joinRelativePath(targetBase, existingDir)

		if (!sourceDirs.includes(existingDir)) {
			const targetDirAbsolute = resolveContainedPath(
				input.targetWorkingDirectory,
				targetDirRelative,
				'Sync target directory',
			)

			await rm(targetDirAbsolute, { recursive: true, force: true })
			input.touchedFiles.add(targetDirRelative)
		}
	}
}

/**
 * Expand a source-side glob pattern into repo-relative file paths.
 *
 * @param pattern - Source glob pattern.
 * @param sourceWorkingDirectory - Source repo root.
 * @returns Matching repo-relative file paths.
 */
async function expandSourceGlob(
	pattern: string,
	sourceWorkingDirectory: string,
): Promise<string[]> {
	const scanResult = micromatch.scan(pattern)
	const baseDirectory = resolveContainedPath(
		sourceWorkingDirectory,
		scanResult.base.length === 0 ? '.' : scanResult.base,
		'Sync source glob base',
	)

	if (!(await pathExists(baseDirectory))) {
		return []
	}

	const baseStats = await stat(baseDirectory)
	const candidateFiles = baseStats.isDirectory()
		? await listFilesWithinDirectory(baseDirectory)
		: ['']

	return candidateFiles
		.map(relativePath =>
			relativePath.length === 0
				? normalizeRelativePath(relative(sourceWorkingDirectory, baseDirectory))
				: joinRelativePath(normalizeRelativePath(scanResult.base), relativePath),
		)
		.filter(filePath => micromatch.isMatch(filePath, pattern))
}

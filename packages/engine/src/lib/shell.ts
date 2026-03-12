import { spawn } from 'node:child_process'

/**
 * Run a shell command and return its stdout.
 *
 * @param command - Command and arguments.
 * @returns Captured stdout.
 */
export async function runShellCommand(command: string[]): Promise<string> {
	const [cmd, ...args] = command
	const childProcess = spawn(cmd ?? '', args, {
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const stdoutChunks: Buffer[] = []
	const stderrChunks: Buffer[] = []

	childProcess.stdout?.on('data', (chunk: Buffer | string) => {
		stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	})
	childProcess.stderr?.on('data', (chunk: Buffer | string) => {
		stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	})

	const exitCode = await new Promise<number>(resolve => {
		childProcess.once('close', code => {
			resolve(code ?? 1)
		})
		childProcess.once('error', () => {
			resolve(1)
		})
	})

	if (exitCode !== 0) {
		const stderr = Buffer.concat(stderrChunks).toString('utf8')

		throw new Error(
			`Command failed (${command.join(' ')}): exit ${String(exitCode)}\n${stderr}`,
		)
	}

	return Buffer.concat(stdoutChunks).toString('utf8')
}

let rsyncAvailableCache: boolean | undefined = undefined

/**
 * Check whether rsync is available on the host.
 *
 * Result is cached after the first call.
 *
 * @returns True when rsync is in PATH.
 */
export async function isRsyncAvailable(): Promise<boolean> {
	if (rsyncAvailableCache !== undefined) {
		return rsyncAvailableCache
	}

	try {
		await runShellCommand(['which', 'rsync'])
		rsyncAvailableCache = true
	} catch {
		rsyncAvailableCache = false
	}

	return rsyncAvailableCache
}

/**
 * Parse rsync --itemize-changes output into repo-relative touched paths.
 *
 * Each line from rsync looks like `>f+++++++++ path/to/file` or `*deleting   path/to/file`.
 * We extract the path portion and prepend the target base.
 *
 * @param output - Raw stdout from rsync --itemize-changes --dry-run.
 * @param targetBase - Repo-relative target base prefix.
 * @param joinPath - Path joiner function.
 * @returns Repo-relative paths that rsync would change.
 */
export function parseRsyncItemizedOutput(
	output: string,
	targetBase: string,
	joinPath: (...parts: string[]) => string,
): string[] {
	const paths: string[] = []

	for (const line of output.split('\n')) {
		const trimmed = line.trim()

		if (trimmed.length === 0 || trimmed.startsWith('cd')) {
			// blank lines and directory-only markers are not file changes
		} else if (trimmed.startsWith('*deleting')) {
			const deletedPath = trimmed.replace(/^\*deleting\s+/u, '').replace(/\/$/u, '')

			if (deletedPath.length > 0) {
				paths.push(joinPath(targetBase, deletedPath))
			}
		} else {
			const spaceIndex = trimmed.indexOf(' ')

			if (spaceIndex > 0) {
				const changedPath = trimmed.slice(spaceIndex + 1).replace(/\/$/u, '')

				if (changedPath.length > 0) {
					paths.push(joinPath(targetBase, changedPath))
				}
			}
		}
	}

	return paths
}

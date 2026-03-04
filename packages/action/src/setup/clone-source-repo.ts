import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type {
	CloneSourceRepoDependencies,
	CloneSourceRepoOptions,
	CloneSourceRepoResult,
} from '../types.ts'

const DIFF_FILE_NAME = 'port-diff.patch'

/**
 * Run command and capture output.
 *
 * @param input - Command execution input.
 * @param input.command - Command and args.
 * @param input.workingDirectory - Optional command cwd.
 * @returns Exit status and decoded streams.
 */
async function runCommand(input: {
	command: string[]
	workingDirectory?: string
}): Promise<{ exitCode: number; stderr: string; stdout: string }> {
	const [command, ...args] = input.command
	const childProcess = spawn(command ?? '', args, {
		cwd: input.workingDirectory,
		stdio: ['ignore', 'pipe', 'pipe'],
	})
	const stdoutChunks: Buffer[] = []
	const stderrChunks: Buffer[] = []

	childProcess.stdout?.on('data', chunk => {
		stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	})
	childProcess.stderr?.on('data', chunk => {
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

	return {
		exitCode,
		stdout: Buffer.concat(stdoutChunks).toString('utf8'),
		stderr: Buffer.concat(stderrChunks).toString('utf8'),
	}
}

/**
 * Assert a command completed successfully.
 *
 * @param dependencies - Command dependency container.
 * @param input - Command details.
 * @param input.command - Command and args.
 * @param input.workingDirectory - Optional command cwd.
 * @returns Command stdout.
 */
async function expectCommandSuccess(
	dependencies: CloneSourceRepoDependencies,
	input: {
		command: string[]
		workingDirectory?: string
	},
): Promise<string> {
	const result = await dependencies.runCommand(input)

	if (result.exitCode !== 0) {
		throw new Error(
			`Command failed (${input.command.join(' ')}): exit ${String(result.exitCode)}\n${result.stderr}`,
		)
	}

	return result.stdout
}

/**
 * Clone source repository at merge commit and generate a full local diff file.
 *
 * @param options - Clone options.
 * @param dependencies - Injectable dependencies for testing.
 * @returns Source working directory and generated diff path.
 */
export async function cloneSourceRepo(
	options: CloneSourceRepoOptions,
	dependencies: Partial<CloneSourceRepoDependencies> = {},
): Promise<CloneSourceRepoResult> {
	const resolvedDependencies: CloneSourceRepoDependencies = {
		createTempDirectory: dependencies.createTempDirectory ?? (prefix => mkdtemp(prefix)),
		runCommand: dependencies.runCommand ?? runCommand,
		writeFile:
			dependencies.writeFile ??
			(async (filePath, content) => {
				await writeFile(filePath, content, 'utf8')
			}),
	}

	const sourceWorkingDirectory = await resolvedDependencies.createTempDirectory(
		path.join(tmpdir(), 'repo-port-bot-source-'),
	)

	const token = encodeURIComponent(options.token)
	const remoteUrl = `https://x-access-token:${token}@github.com/${options.repo.owner}/${options.repo.name}.git`

	await expectCommandSuccess(resolvedDependencies, {
		command: ['git', 'init'],
		workingDirectory: sourceWorkingDirectory,
	})

	await expectCommandSuccess(resolvedDependencies, {
		command: ['git', 'remote', 'add', 'origin', remoteUrl],
		workingDirectory: sourceWorkingDirectory,
	})

	await expectCommandSuccess(resolvedDependencies, {
		command: ['git', 'fetch', '--depth', '2', 'origin', options.commitSha],
		workingDirectory: sourceWorkingDirectory,
	})

	await expectCommandSuccess(resolvedDependencies, {
		command: ['git', 'checkout', 'FETCH_HEAD'],
		workingDirectory: sourceWorkingDirectory,
	})

	const diffContent = await expectCommandSuccess(resolvedDependencies, {
		command: ['git', 'diff', 'HEAD~1'],
		workingDirectory: sourceWorkingDirectory,
	})

	const diffFilePath = path.join(sourceWorkingDirectory, DIFF_FILE_NAME)

	await resolvedDependencies.writeFile(diffFilePath, diffContent)

	return {
		sourceWorkingDirectory,
		diffFilePath,
	}
}

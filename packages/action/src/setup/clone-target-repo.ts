import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import type { CloneTargetRepoDependencies, CloneTargetRepoOptions } from '../types.ts'

const GIT_BOT_USER_NAME = 'repo-port-bot[bot]'
const GIT_BOT_USER_EMAIL = 'repo-port-bot[bot]@users.noreply.github.com'

/**
 * Run command with Bun and capture output.
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
	const process = Bun.spawn(input.command, {
		cwd: input.workingDirectory,
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [exitCode, stdoutBytes, stderrBytes] = await Promise.all([
		process.exited,
		new Response(process.stdout).bytes(),
		new Response(process.stderr).bytes(),
	])

	return {
		exitCode,
		stdout: Buffer.from(stdoutBytes).toString('utf8'),
		stderr: Buffer.from(stderrBytes).toString('utf8'),
	}
}

/**
 * Assert a command completed successfully.
 *
 * @param dependencies - Command dependency container.
 * @param input - Command details.
 * @param input.command - Command and args.
 * @param input.workingDirectory - Optional command cwd.
 */
async function expectCommandSuccess(
	dependencies: CloneTargetRepoDependencies,
	input: {
		command: string[]
		workingDirectory?: string
	},
): Promise<void> {
	const result = await dependencies.runCommand(input)

	if (result.exitCode !== 0) {
		throw new Error(
			`Command failed (${input.command.join(' ')}): exit ${String(result.exitCode)}\n${result.stderr}`,
		)
	}
}

/**
 * Clone target repository into a temporary directory and configure git identity.
 *
 * @param options - Clone options.
 * @param dependencies - Injectable dependencies for testing.
 * @returns Absolute path to the checked-out repository.
 */
export async function cloneTargetRepo(
	options: CloneTargetRepoOptions,
	dependencies: Partial<CloneTargetRepoDependencies> = {},
): Promise<string> {
	const resolvedDependencies: CloneTargetRepoDependencies = {
		createTempDirectory: dependencies.createTempDirectory ?? (prefix => mkdtemp(prefix)),
		runCommand: dependencies.runCommand ?? runCommand,
	}
	const workingDirectory = await resolvedDependencies.createTempDirectory(
		path.join(tmpdir(), 'repo-port-bot-target-'),
	)
	const token = encodeURIComponent(options.token)
	const remoteUrl = `https://x-access-token:${token}@github.com/${options.repo.owner}/${options.repo.name}.git`

	await expectCommandSuccess(resolvedDependencies, {
		command: [
			'git',
			'clone',
			'--depth',
			'1',
			'--branch',
			options.defaultBranch,
			remoteUrl,
			workingDirectory,
		],
	})
	await expectCommandSuccess(resolvedDependencies, {
		command: ['git', 'config', 'user.name', GIT_BOT_USER_NAME],
		workingDirectory,
	})
	await expectCommandSuccess(resolvedDependencies, {
		command: ['git', 'config', 'user.email', GIT_BOT_USER_EMAIL],
		workingDirectory,
	})

	return workingDirectory
}

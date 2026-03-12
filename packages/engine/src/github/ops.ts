import { spawn } from 'node:child_process'

import { renderPortPullRequestTitle } from './render-body.ts'

import type {
	CommandRunner,
	DeterministicPhaseResult,
	ExecutePortResult,
	PortContext,
	PrFramingMode,
	ValidationCommandResult,
} from '../types.ts'

const PORT_BOT_FOOTER = 'Ported-By: repo-port-bot'
const SHORT_SHA_LENGTH = 7

/**
 * Run a command and capture exit code + streams.
 *
 * @param input - Command execution input.
 * @param input.command - Command and arguments to execute.
 * @param input.workingDirectory - Directory where the command should run.
 * @returns Exit code and decoded output.
 */
export async function runCommand(input: {
	command: string[]
	workingDirectory: string
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
 * Ensure command exits with code 0.
 *
 * @param runner - Command runner.
 * @param command - Command vector.
 * @param workingDirectory - Command cwd.
 */
export async function expectCommandSuccess(
	runner: CommandRunner,
	command: string[],
	workingDirectory: string,
): Promise<void> {
	const result = await runner({ command, workingDirectory })

	if (result.exitCode !== 0) {
		throw new Error(
			`Command failed (${command.join(' ')}): exit ${String(result.exitCode)}\n${result.stderr}`,
		)
	}
}

/**
 * Build deterministic branch name for port branches.
 *
 * @param context - Port context.
 * @returns Branch name.
 */
export function buildPortBranchName(context: PortContext): string {
	const shortSha = context.sourceChange.mergedCommitSha.slice(0, SHORT_SHA_LENGTH)
	const pullRequestNumber = context.sourceChange.pullRequest?.number ?? 0

	return `port/${context.sourceRepo.name}/${String(pullRequestNumber)}-${shortSha}`
}

/**
 * Build git commit message for the final delivery commit.
 *
 * @param context - Port context.
 * @param model - Optional agent model identifier for trailer.
 * @returns Commit message with git trailers.
 */
export function buildCommitMessage(context: PortContext, model?: string): string {
	const title = renderPortPullRequestTitle(context)
	const trailers = [
		context.sourceChange.pullRequest
			? `Source-PR: ${context.sourceChange.pullRequest.url}`
			: undefined,
		`Source-Commit: ${context.sourceChange.mergedCommitSha}`,
		model ? `Agent-Model: ${model}` : undefined,
		PORT_BOT_FOOTER,
	].filter(Boolean)

	return `${title}\n\n${trailers.join('\n')}`
}

/**
 * Stage and commit current working tree state if there are staged changes.
 *
 * @param runner - Command runner.
 * @param workingDirectory - Repository root.
 * @param commitMessage - Commit message.
 * @param touchedPaths - Target-repo paths reported as touched by this run.
 * @returns Whether a commit was created.
 */
export async function stageAndCommit(
	runner: CommandRunner,
	workingDirectory: string,
	commitMessage: string,
	touchedPaths: string[],
): Promise<boolean> {
	const addCommand =
		touchedPaths.length > 0 ? ['git', 'add', '-A', '--', ...touchedPaths] : ['git', 'add', '-A']

	await expectCommandSuccess(runner, addCommand, workingDirectory)

	const diffResult = await runner({
		command: ['git', 'diff', '--cached', '--quiet'],
		workingDirectory,
	})

	if (diffResult.exitCode === 0) {
		return false
	}

	if (diffResult.exitCode !== 1) {
		throw new Error(`Unable to inspect staged diff: ${diffResult.stderr}`)
	}

	await expectCommandSuccess(runner, ['git', 'commit', '-m', commitMessage], workingDirectory)

	return true
}

/**
 * Check whether the current target working tree contains any deliverable changes
 * among the specified touched paths.
 *
 * @param runner - Command runner.
 * @param workingDirectory - Repository root.
 * @param touchedPaths - Target-repo paths reported as touched by this run.
 * @returns Whether target-side changes exist.
 */
export async function checkTargetSideDiff(
	runner: CommandRunner,
	workingDirectory: string,
	touchedPaths: string[],
): Promise<boolean> {
	if (touchedPaths.length === 0) {
		return false
	}

	const statusResult = await runner({
		command: ['git', 'status', '--short', '--', ...touchedPaths],
		workingDirectory,
	})

	if (statusResult.exitCode !== 0) {
		throw new Error(`Unable to inspect target status: ${statusResult.stderr}`)
	}

	return statusResult.stdout.trim().length > 0
}

/**
 * Decide whether validation indicates a draft PR should be opened.
 *
 * @param validation - Validation command results.
 * @returns Whether validation succeeded.
 */
export function isValidationSuccessful(validation?: ValidationCommandResult[]): boolean {
	if (!validation || validation.length === 0) {
		return true
	}

	return validation.every(command => command.ok)
}

/**
 * Collect target-repo paths touched by this run from deterministic and execution results.
 *
 * @param deterministic - Deterministic phase result.
 * @param contextDeterministic - Context-level deterministic result (fallback).
 * @param execution - Execution result.
 * @returns Unique target-repo paths touched by the run.
 */
export function collectTouchedPaths(
	deterministic: DeterministicPhaseResult | undefined,
	contextDeterministic: DeterministicPhaseResult | undefined,
	execution: ExecutePortResult | undefined,
): string[] {
	const touchedPaths = new Set<string>()

	for (const path of deterministic?.touchedFiles ?? contextDeterministic?.touchedFiles ?? []) {
		touchedPaths.add(path)
	}

	for (const path of execution?.outcome.touchedFiles ?? []) {
		touchedPaths.add(path)
	}

	return [...touchedPaths]
}

/**
 * Resolve PR framing mode for delivery.
 *
 * @param explicitMode - Explicitly requested framing mode.
 * @param isPortRequired - Whether the decision was PORT_REQUIRED.
 * @param executionStatus - Execution outcome status when available.
 * @param decisionKind - Port decision kind.
 * @returns Resolved framing mode for PR body rendering.
 */
export function resolveFramingMode(
	explicitMode: PrFramingMode | undefined,
	isPortRequired: boolean,
	executionStatus: string | undefined,
	decisionKind: string,
): PrFramingMode {
	if (explicitMode) {
		return explicitMode
	}

	if (isPortRequired) {
		return executionStatus === 'SUCCEEDED' ? 'agent_success' : 'agent_stalled'
	}

	return decisionKind === 'NEEDS_HUMAN' ? 'residual_handoff' : 'deterministic_only'
}

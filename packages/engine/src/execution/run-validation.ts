import { spawn } from 'node:child_process'

import type { ValidationCommandResult } from '../types.ts'

interface RunValidationOptions {
	commands: string[]
	workingDirectory: string
}

const SUCCESS_EXIT_CODE = 0
const OUTPUT_ENCODING = 'utf8'

/**
 * Run one validation command and capture stdout/stderr/exit status.
 *
 * @param command - Validation command string.
 * @param workingDirectory - Directory where the command should run.
 * @returns Captured command result.
 */
async function runValidationCommand(
	command: string,
	workingDirectory: string,
): Promise<ValidationCommandResult> {
	const startedAt = Date.now()
	const childProcess = spawn('sh', ['-lc', command], {
		cwd: workingDirectory,
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
	const durationMs = Date.now() - startedAt

	return {
		command,
		ok: exitCode === SUCCESS_EXIT_CODE,
		exitCode,
		stdout: Buffer.concat(stdoutChunks).toString(OUTPUT_ENCODING),
		stderr: Buffer.concat(stderrChunks).toString(OUTPUT_ENCODING),
		durationMs,
	}
}

/**
 * Run validation commands sequentially and stop at the first failure.
 *
 * @param options - Validation execution options.
 * @param options.commands - Ordered validation commands.
 * @param options.workingDirectory - Directory where commands run.
 * @returns Validation results in execution order.
 */
export async function runValidationCommands(
	options: RunValidationOptions,
): Promise<ValidationCommandResult[]> {
	const results: ValidationCommandResult[] = []

	for (const command of options.commands) {
		const result = await runValidationCommand(command, options.workingDirectory)

		results.push(result)

		if (!result.ok) {
			break
		}
	}

	return results
}

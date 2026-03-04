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
	const process = Bun.spawn(['sh', '-lc', command], {
		cwd: workingDirectory,
		stdout: 'pipe',
		stderr: 'pipe',
	})

	const [exitCode, stdoutBytes, stderrBytes] = await Promise.all([
		process.exited,
		new Response(process.stdout).bytes(),
		new Response(process.stderr).bytes(),
	])
	const durationMs = Date.now() - startedAt

	return {
		command,
		ok: exitCode === SUCCESS_EXIT_CODE,
		exitCode,
		stdout: Buffer.from(stdoutBytes).toString(OUTPUT_ENCODING),
		stderr: Buffer.from(stderrBytes).toString(OUTPUT_ENCODING),
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

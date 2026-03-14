/**
 * Validation command helpers for scenario tests.
 *
 * Generates validation commands that produce known stdout/stderr tokens
 * without tests needing to manage temp script files. Script filenames
 * are opaque counters so the token only appears in the command output,
 * not in the command name rendered by the diagnostics section.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

let scriptCounter = 0

/**
 * @returns Opaque script filename that does not contain the output token.
 */
function nextScriptName(): string {
	return `check-${String(scriptCounter++)}.sh`
}

/**
 * Create a validation command that passes and writes a known token to stdout.
 *
 * @param targetDir - Target repo working directory (where the script is created).
 * @param token - Unique string that tests can assert on in the diagnostics section.
 * @returns Shell command string to use in `portBotJson.validation`.
 */
export async function passingValidation(targetDir: string, token: string): Promise<string> {
	const scriptName = nextScriptName()

	await writeFile(join(targetDir, scriptName), `#!/bin/sh\necho "${token}"\n`)

	return `sh ${scriptName}`
}

/**
 * Create a validation command that fails and writes a known token to stderr.
 *
 * @param targetDir - Target repo working directory (where the script is created).
 * @param token - Unique string that tests can assert on in the diagnostics section.
 * @returns Shell command string to use in `portBotJson.validation`.
 */
export async function failingValidation(targetDir: string, token: string): Promise<string> {
	const scriptName = nextScriptName()

	await writeFile(join(targetDir, scriptName), `#!/bin/sh\nprintf "${token}" >&2\nexit 1\n`)

	return `sh ${scriptName}`
}

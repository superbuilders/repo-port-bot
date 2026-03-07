import type {
	ChangedFile,
	ExecutePortAttemptResult,
	PluginConfig,
	ValidationCommandResult,
} from '@repo-port-bot/engine'

const MISSING_PATCH_NOTE = '(patch omitted by source API)'

/**
 * Render the path-mappings slot from plugin config.
 *
 * @param pluginConfig - Resolved plugin config.
 * @returns Mappings section or undefined.
 */
export function renderPathMappings(pluginConfig: PluginConfig): string | undefined {
	const entries = Object.entries(pluginConfig.pathMappings)

	if (entries.length === 0) {
		return undefined
	}

	return [
		'Source-to-target path mappings:',
		...entries.map(([source, target]) => `- \`${source}\` -> \`${target}\``),
	].join('\n')
}

/**
 * Render the naming-conventions slot from plugin config.
 *
 * @param pluginConfig - Resolved plugin config.
 * @returns Naming section or undefined.
 */
export function renderNamingConventions(pluginConfig: PluginConfig): string | undefined {
	if (!pluginConfig.namingConventions) {
		return undefined
	}

	return `Naming conventions:\n- ${pluginConfig.namingConventions}`
}

/**
 * Render the additional-instructions slot from plugin config.
 *
 * @param pluginConfig - Resolved plugin config.
 * @returns Instructions section or undefined.
 */
export function renderAdditionalInstructions(pluginConfig: PluginConfig): string | undefined {
	if (!pluginConfig.prompt) {
		return undefined
	}

	return `Additional instructions:\n${pluginConfig.prompt}`
}

/**
 * Render the source-repo-checkout slot.
 *
 * @param sourceWorkingDirectory - Source repo path.
 * @returns Section or undefined.
 */
export function renderSourceRepoSection(sourceWorkingDirectory?: string): string | undefined {
	if (!sourceWorkingDirectory) {
		return undefined
	}

	return `Source repository checkout:\n- \`${sourceWorkingDirectory}\``
}

/**
 * Render the diff-file slot.
 *
 * @param diffFilePath - Source diff file path.
 * @returns Section or undefined.
 */
export function renderDiffFileSection(diffFilePath?: string): string | undefined {
	if (!diffFilePath) {
		return undefined
	}

	return `Source diff file:\n- \`${diffFilePath}\``
}

/**
 * Render changed files with stats and optional inline patches.
 *
 * @param input - Changed file context.
 * @param input.files - Changed file list.
 * @param input.sourceWorkingDirectory - Optional source checkout path.
 * @param input.diffFilePath - Optional diff file path.
 * @param input.targetWorkingDirectory - Target repo path.
 * @returns Formatted changed-files section.
 */
export function renderChangedFiles(input: {
	files: ChangedFile[]
	sourceWorkingDirectory?: string
	diffFilePath?: string
	targetWorkingDirectory: string
}): string {
	const lines = ['Changed files:']
	const hasDiskSourceContext = Boolean(input.sourceWorkingDirectory || input.diffFilePath)

	for (const file of input.files) {
		lines.push(
			`- \`${file.path}\` (${file.status}, +${String(file.additions)} / -${String(file.deletions)})`,
		)

		if (!hasDiskSourceContext) {
			lines.push(file.patch ? `\`\`\`diff\n${file.patch}\n\`\`\`` : MISSING_PATCH_NOTE)
		}
	}

	if (input.diffFilePath) {
		lines.push(`Full diff file: \`${input.diffFilePath}\``)
	}

	if (input.sourceWorkingDirectory) {
		lines.push(`Source repository path: \`${input.sourceWorkingDirectory}\``)
	}

	return lines.join('\n')
}

/**
 * Render retry feedback from previous attempts.
 *
 * @param attempts - Prior execution attempts.
 * @returns Retry section or undefined for first attempt.
 */
export function renderRetryFeedback(attempts: ExecutePortAttemptResult[]): string | undefined {
	if (attempts.length === 0) {
		return undefined
	}

	const summaries = attempts.map(attempt => {
		const failure = renderValidationFailure(attempt.validation)
		const touchedFiles =
			attempt.touchedFiles.length === 0
				? 'none'
				: attempt.touchedFiles.map((path: string) => `\`${path}\``).join(', ')

		const parts = [
			`Attempt ${String(attempt.attempt)}:`,
			`- Touched files: ${touchedFiles}`,
			failure ? `- Validation failure: ${failure}` : undefined,
			attempt.trace.notes ? `- Notes: ${attempt.trace.notes}` : undefined,
		]

		return parts.filter(Boolean).join('\n')
	})

	return ['Previous attempt feedback', ...summaries].filter(Boolean).join('\n')
}

/**
 * Format the first failing validation command from an attempt.
 *
 * @param validation - Validation command results.
 * @returns Failure summary or undefined when all pass.
 */
function renderValidationFailure(validation: ValidationCommandResult[]): string | undefined {
	const failed = validation.find(result => !result.ok)

	if (!failed) {
		return undefined
	}

	const exitCode = failed.exitCode === undefined ? 'unknown' : String(failed.exitCode)
	const stderr = failed.stderr.trim()
	const stderrSuffix = stderr.length === 0 ? '' : `; stderr: ${stderr}`

	return `\`${failed.command}\` (exit ${exitCode})${stderrSuffix}`
}

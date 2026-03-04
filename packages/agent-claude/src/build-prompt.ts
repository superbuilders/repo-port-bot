import type {
	AgentInput,
	ExecutionAttempt,
	PluginConfig,
	ValidationCommandResult,
} from '@repo-port-bot/engine'

const PROMPT_DIVIDER = '\n\n---\n\n'
const RETRY_TITLE = 'Previous attempt feedback'
const MISSING_PATCH_NOTE = '(patch omitted by source API)'

/**
 * Build a system prompt from plugin configuration.
 *
 * @param pluginConfig - Resolved plugin config.
 * @returns System prompt text.
 */
export function buildSystemPrompt(pluginConfig: PluginConfig): string {
	const mappingEntries = Object.entries(pluginConfig.pathMappings)
	const mappingsSection =
		mappingEntries.length === 0
			? undefined
			: [
					'Source-to-target path mappings:',
					...mappingEntries.map(([source, target]) => `- \`${source}\` -> \`${target}\``),
				].join('\n')
	const namingSection = pluginConfig.namingConventions
		? `Naming conventions:\n- ${pluginConfig.namingConventions}`
		: undefined
	const additionalInstructions = pluginConfig.prompt
		? `Additional instructions:\n${pluginConfig.prompt}`
		: undefined

	return (
		joinNonEmptyLines(
			[
				'You are a code porting agent. Apply equivalent changes from a source repository into the target repository.',
				mappingsSection,
				namingSection,
				additionalInstructions,
				[
					'Rules:',
					'- Only modify files in the target repository.',
					'- Do NOT run validation commands; the orchestrator handles validation.',
					'- If uncertain, include uncertainty in your notes.',
				].join('\n'),
			],
			PROMPT_DIVIDER,
		) ?? ''
	)
}

/**
 * Build the user prompt for one execution attempt.
 *
 * @param input - Agent attempt input.
 * @returns User prompt text.
 */
export function buildUserPrompt(input: AgentInput): string {
	const changedFilesSection = renderChangedFilesSection(input)
	const retrySection = renderRetrySection(input.previousAttempts)
	const retryInstruction =
		input.previousAttempts.length === 0
			? 'Apply equivalent changes in the target repository.'
			: 'Previous attempt failed validation. Apply targeted fixes and update files in place.'

	return (
		joinNonEmptyLines(
			[
				'Task: Port the source changes into this target repository checkout.',
				changedFilesSection,
				retrySection,
				retryInstruction,
			],
			PROMPT_DIVIDER,
		) ?? retryInstruction
	)
}

/**
 * Render changed files with stats and patch text.
 *
 * @param input - Agent input.
 * @returns Formatted changed files section.
 */
function renderChangedFilesSection(input: AgentInput): string {
	const lines = ['Changed files:']

	for (const file of input.files) {
		lines.push(
			`- \`${file.path}\` (${file.status}, +${String(file.additions)} / -${String(file.deletions)})`,
		)
		lines.push(file.patch ? `\`\`\`diff\n${file.patch}\n\`\`\`` : MISSING_PATCH_NOTE)
	}

	return lines.join('\n')
}

/**
 * Render retry feedback from previous attempts.
 *
 * @param attempts - Prior attempts.
 * @returns Retry section or undefined for first attempt.
 */
function renderRetrySection(attempts: ExecutionAttempt[]): string | undefined {
	if (attempts.length === 0) {
		return undefined
	}

	const attemptSummaries = attempts.map(attempt => {
		const failure = renderValidationFailure(attempt.validation)
		const touchedFiles =
			attempt.touchedFiles.length === 0
				? 'none'
				: attempt.touchedFiles.map(path => `\`${path}\``).join(', ')

		return joinNonEmptyLines([
			`Attempt ${String(attempt.attempt)}:`,
			`- Touched files: ${touchedFiles}`,
			failure && `- Validation failure: ${failure}`,
			attempt.notes && `- Notes: ${attempt.notes}`,
		])
	})

	return joinNonEmptyLines([RETRY_TITLE, ...attemptSummaries])
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

/**
 * Join lines while skipping blank or undefined values.
 *
 * @param lines - Candidate lines.
 * @param delimiter - Delimiter used for joining.
 * @returns Joined text or undefined.
 */
function joinNonEmptyLines(lines: (string | undefined)[], delimiter = '\n'): string | undefined {
	const nonEmpty = lines.filter(line => line && line.trim().length > 0)

	if (nonEmpty.length === 0) {
		return undefined
	}

	return nonEmpty.join(delimiter)
}

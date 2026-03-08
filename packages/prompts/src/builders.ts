import { renderPrompt } from './render.ts'
import {
	renderAdditionalInstructions,
	renderChangedFiles,
	renderDiffFileSection,
	renderNamingConventions,
	renderPathMappings,
	renderRetryFeedback,
	renderSourceRepoSection,
} from './sections.ts'

import type { DecidePortInput, ExecutePortAttemptInput, PluginConfig } from '@repo-port-bot/engine'

interface SystemPromptInput {
	pluginConfig: PluginConfig
	sourceWorkingDirectory?: string
	diffFilePath?: string
}

/**
 * Build a system prompt for the execution stage.
 *
 * @param input - Prompt context.
 * @returns Rendered system prompt text.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
	return renderPrompt('execution-system', {
		sourceRepoSection: renderSourceRepoSection(input.sourceWorkingDirectory),
		diffFileSection: renderDiffFileSection(input.diffFilePath),
		pathMappings: renderPathMappings(input.pluginConfig),
		namingConventions: renderNamingConventions(input.pluginConfig),
		additionalInstructions: renderAdditionalInstructions(input.pluginConfig),
	})
}

/**
 * Build a system prompt for the decision (classification) stage.
 *
 * @param input - Prompt context.
 * @returns Rendered system prompt text.
 */
export function buildDecideSystemPrompt(input: SystemPromptInput): string {
	return renderPrompt('decision-system', {
		sourceRepoSection: renderSourceRepoSection(input.sourceWorkingDirectory),
		diffFileSection: renderDiffFileSection(input.diffFilePath),
		pathMappings: renderPathMappings(input.pluginConfig),
		namingConventions: renderNamingConventions(input.pluginConfig),
		additionalInstructions: renderAdditionalInstructions(input.pluginConfig),
	})
}

/**
 * Build a user prompt for one execution attempt.
 *
 * @param input - Agent attempt input.
 * @returns Rendered user prompt text.
 */
export function buildUserPrompt(input: ExecutePortAttemptInput): string {
	const isRetry = input.previousAttempts.length > 0

	return renderPrompt('execution-user', {
		targetWorkingDirectory: input.targetWorkingDirectory,
		changedFiles: renderChangedFiles(input),
		retryFeedback: renderRetryFeedback(input.previousAttempts),
		instruction: isRetry
			? 'Previous attempt failed validation. Apply targeted fixes and update files in place.'
			: 'Apply equivalent changes in the target repository.',
	})
}

/**
 * Build a user prompt for "port required?" classification.
 *
 * @param input - Decision input.
 * @returns Rendered user prompt text.
 */
export function buildDecideUserPrompt(input: DecidePortInput): string {
	return renderPrompt('decision-user', {
		targetWorkingDirectory: input.targetWorkingDirectory,
		changedFiles: renderChangedFiles(input),
	})
}

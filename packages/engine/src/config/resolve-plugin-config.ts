import { parseAndDecodePortBotJson } from './port-bot-json.decoder.ts'

import type { PartialPluginConfig, PluginConfig, RepoRef } from '../types.ts'
import type { PortBotJsonConfig } from './types.ts'

interface ResolvePluginConfigOptions {
	builtInConfig?: PartialPluginConfig
	portBotJson?: PortBotJsonConfig | string
	targetDefaultBranch?: string
}

/**
 * Parse a repository string in the form `owner/name`.
 *
 * @param repo - Repository slug.
 * @returns Parsed owner and name.
 */
function parseTargetRepo(repo: string): Pick<RepoRef, 'name' | 'owner'> {
	const trimmed = repo.trim()

	if (!trimmed.includes('/')) {
		throw new Error('Invalid `target` in port-bot.json. Expected format "owner/repo".')
	}

	const [owner, name] = trimmed.split('/')

	if (!owner || !name) {
		throw new Error('Invalid `target` in port-bot.json. Expected format "owner/repo".')
	}

	return { owner, name }
}

/**
 * Validate that command/pattern/mapping fields have expected types.
 *
 * @param config - Final merged config.
 */
function validatePluginConfig(config: PluginConfig): void {
	if (!config.targetRepo.owner || !config.targetRepo.name || !config.targetRepo.defaultBranch) {
		throw new Error(
			'Plugin config is missing target repository fields (owner, name, defaultBranch).',
		)
	}

	if (
		!Array.isArray(config.ignorePatterns) ||
		!config.ignorePatterns.every(p => typeof p === 'string')
	) {
		throw new Error('Plugin config `ignorePatterns` must be a string array.')
	}

	if (
		!Array.isArray(config.validationCommands) ||
		!config.validationCommands.every(command => typeof command === 'string')
	) {
		throw new Error('Plugin config `validationCommands` must be a string array.')
	}

	if (
		!config.pathMappings ||
		typeof config.pathMappings !== 'object' ||
		Array.isArray(config.pathMappings)
	) {
		throw new Error('Plugin config `pathMappings` must be an object map.')
	}
}

/**
 * Resolve final `PluginConfig` from built-in plugin config and optional `port-bot.json`.
 * Built-in plugin config takes precedence for overlapping fields.
 *
 * @param options - Resolution inputs.
 * @returns Fully validated plugin config.
 */
export function resolvePluginConfig(options: ResolvePluginConfigOptions): PluginConfig {
	const parsedPortBotJson = parseAndDecodePortBotJson(options.portBotJson)
	const targetDefaultBranch = options.targetDefaultBranch ?? 'main'
	const builtInConfig = options.builtInConfig ?? {}

	const fromPortBotJson: PartialPluginConfig = {
		targetRepo: parsedPortBotJson.target
			? {
					...parseTargetRepo(parsedPortBotJson.target),
					defaultBranch: targetDefaultBranch,
				}
			: undefined,
		ignorePatterns: parsedPortBotJson.ignore ?? [],
		validationCommands: parsedPortBotJson.validation ?? [],
		pathMappings: parsedPortBotJson.mapping ?? {},
		namingConventions: parsedPortBotJson.conventions?.naming,
		prompt: parsedPortBotJson.prompt,
	}

	const merged: PluginConfig = {
		targetRepo: {
			owner: builtInConfig.targetRepo?.owner ?? fromPortBotJson.targetRepo?.owner ?? '',
			name: builtInConfig.targetRepo?.name ?? fromPortBotJson.targetRepo?.name ?? '',
			defaultBranch:
				builtInConfig.targetRepo?.defaultBranch ??
				fromPortBotJson.targetRepo?.defaultBranch ??
				targetDefaultBranch,
		},
		ignorePatterns: builtInConfig.ignorePatterns ?? fromPortBotJson.ignorePatterns ?? [],
		validationCommands:
			builtInConfig.validationCommands ?? fromPortBotJson.validationCommands ?? [],
		pathMappings: builtInConfig.pathMappings ?? fromPortBotJson.pathMappings ?? {},
		namingConventions: builtInConfig.namingConventions ?? fromPortBotJson.namingConventions,
		prompt: builtInConfig.prompt ?? fromPortBotJson.prompt,
	}

	validatePluginConfig(merged)

	return merged
}

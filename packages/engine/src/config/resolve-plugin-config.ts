import micromatch from 'micromatch'

import { parseAndDecodePortBotJson } from './port-bot-json.decoder.ts'
import { collectDeterministicOperations } from './utils'

import type { PartialPluginConfig, PluginConfig, RepoRef } from '../types.ts'
import type { PortBotJsonConfig } from './types.ts'

interface ResolvePluginConfigOptions {
	builtInConfig?: PartialPluginConfig
	portBotJson?: PortBotJsonConfig | string
	targetDefaultBranch?: string
}

const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[A-Za-z]:[\\/]/u

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
 * Validate that a config path stays within the source/target checkout root.
 *
 * Config paths are declarative repo-relative strings. Reject absolute paths and
 * any parent-directory traversal segments so deterministic operations cannot
 * escape the cloned repository roots.
 *
 * @param value - Raw configured path or glob.
 * @param field - Human-readable field label for error messages.
 */
function validateRepoRelativeConfigPath(value: string, field: string): void {
	const canonical = value.replaceAll('\\', '/').trim()

	if (canonical.length === 0) {
		throw new Error(`${field} must not be empty.`)
	}

	if (canonical.startsWith('/') || WINDOWS_ABSOLUTE_PATH_PATTERN.test(canonical)) {
		throw new Error(`${field} must be repo-relative, not absolute.`)
	}

	const rawSegments = canonical.split('/').filter(Boolean)

	if (rawSegments.includes('..')) {
		throw new Error(`${field} must not traverse outside the repo checkout.`)
	}
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

	if (!Array.isArray(config.deterministicOperations)) {
		throw new Error('Plugin config `deterministicOperations` must be an array.')
	}

	for (const operation of config.deterministicOperations) {
		if (!operation.kind) {
			throw new Error('Deterministic operation is missing a `kind` tag.')
		}

		switch (operation.kind) {
			case 'sync': {
				if (
					typeof operation.source !== 'string' ||
					typeof operation.target !== 'string' ||
					(operation.mode !== 'mirror' && operation.mode !== 'copy')
				) {
					throw new Error(
						'Sync operation must have string `source`, string `target`, and mode `mirror` or `copy`.',
					)
				}

				validateRepoRelativeConfigPath(operation.source, 'Sync operation source')
				validateRepoRelativeConfigPath(operation.target, 'Sync operation target')

				const sourceIsGlob = micromatch.scan(operation.source).isGlob

				if (operation.mode === 'mirror' && !sourceIsGlob) {
					throw new Error(
						`Mirror source must be a glob pattern (e.g. "${operation.source}/**"), not a literal path.`,
					)
				}

				if (operation.mode === 'copy' && sourceIsGlob) {
					throw new Error(
						`Copy source must be a literal file path, not a glob pattern: "${operation.source}"`,
					)
				}

				if (
					operation.mode === 'copy' &&
					(operation.target.endsWith('/') ||
						operation.target === '.' ||
						operation.target === '..')
				) {
					throw new Error(
						`Copy target must be a file path, not a directory: "${operation.target}"`,
					)
				}

				break
			}
			default: {
				throw new Error(`Unknown deterministic operation kind: ${String(operation.kind)}`)
			}
		}
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
		deterministicOperations: collectDeterministicOperations(parsedPortBotJson),
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
		deterministicOperations:
			builtInConfig.deterministicOperations ?? fromPortBotJson.deterministicOperations ?? [],
		pathMappings: builtInConfig.pathMappings ?? fromPortBotJson.pathMappings ?? {},
		namingConventions: builtInConfig.namingConventions ?? fromPortBotJson.namingConventions,
		prompt: builtInConfig.prompt ?? fromPortBotJson.prompt,
	}

	validatePluginConfig(merged)

	return merged
}

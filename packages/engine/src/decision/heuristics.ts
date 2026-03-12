import micromatch from 'micromatch'

import type { PortContext, PortDecision } from '../types.ts'

type DecisionHeuristic = (context: PortContext) => PortDecision | null

const MATCH_OPTIONS: micromatch.Options = { dot: true }

const DOC_PATTERNS = ['README.md', '**/*.md', 'docs/**', 'LICENSE', 'CHANGELOG*']

const CONFIG_PATTERNS = [
	'.changeset/**',
	'.github/**',
	'.gitignore',
	'*.config.*',
	'.eslintrc*',
	'.prettierrc*',
	'Dockerfile',
	'docker-compose*',
	'Makefile',
	'Justfile',
]

/**
 * Build a skip reason that includes ignore-filter context when available.
 *
 * @param context - Decision context.
 * @param baseReason - Reason used when no files were filtered out.
 * @param filteredReason - Reason used when files were filtered out.
 * @returns Human-readable skip reason.
 */
function skipReason(context: PortContext, baseReason: string, filteredReason: string): string {
	const filtering = context.filtering

	if (!filtering || filtering.removedFileCount === 0) {
		return baseReason
	}

	return `${String(filtering.removedFileCount)} of ${String(filtering.originalFileCount)} files excluded by ignore patterns. ${filteredReason}`
}

/**
 * Skip when no changed files remain after pipeline-level filtering.
 *
 * @param context - Decision context.
 * @returns `NO_AGENT_PORT_NEEDED` when there are no changed files to evaluate.
 */
function checkNoRemainingFiles(context: PortContext): PortDecision | null {
	if (context.sourceChange.files.length === 0) {
		const filtering = context.filtering
		const reason =
			filtering && filtering.removedFileCount > 0
				? `Skipping because all ${String(filtering.originalFileCount)} changed files were excluded by ignore patterns.`
				: 'Skipping because no changed files remain after ignore filtering.'

		return {
			kind: 'NO_AGENT_PORT_NEEDED',
			reason,
		}
	}

	return null
}

/**
 * Skip when the push event has no associated pull request.
 *
 * Without PR metadata the pipeline lacks a changed-file list, labels, and
 * title/body context. Supporting plain pushes is a future goal — for now the
 * safest default is to skip silently.
 *
 * @param context - Decision context.
 * @returns `NO_AGENT_PORT_NEEDED` when pull request metadata is missing.
 */
function checkMissingPullRequest(context: PortContext): PortDecision | null {
	if (!context.sourceChange.pullRequest) {
		return {
			kind: 'NO_AGENT_PORT_NEEDED',
			reason: 'Skipping because the push has no associated pull request (plain push).',
		}
	}

	return null
}

/**
 * Check loop-prevention signals that indicate this is already a bot-generated port.
 *
 * @param context - Decision context.
 * @returns `NO_AGENT_PORT_NEEDED` when loop-prevention signal is present.
 */
function checkLoopPrevention(context: PortContext): PortDecision | null {
	const labels = context.sourceChange.pullRequest?.labels ?? []
	const normalizedLabels = labels.map(label => label.toLowerCase())
	const hasAutoPortLabel = normalizedLabels.includes('auto-port')

	if (hasAutoPortLabel) {
		return {
			kind: 'NO_AGENT_PORT_NEEDED',
			reason: 'Skipping because source PR is labeled auto-port (loop prevention).',
		}
	}

	return null
}

/**
 * Check explicit `no-port` label override.
 *
 * @param context - Decision context.
 * @returns `NO_AGENT_PORT_NEEDED` when no-port label is set.
 */
function checkNoPortLabel(context: PortContext): PortDecision | null {
	const labels = context.sourceChange.pullRequest?.labels ?? []
	const normalizedLabels = labels.map(label => label.toLowerCase())
	const hasNoPortLabel = normalizedLabels.includes('no-port')

	if (hasNoPortLabel) {
		return {
			kind: 'NO_AGENT_PORT_NEEDED',
			reason: 'Skipping because source PR is labeled no-port.',
		}
	}

	return null
}

/**
 * Check whether a file path matches documentation-only patterns.
 *
 * @param path - Repository-relative file path.
 * @returns `true` if path is considered documentation content.
 */
function isDocumentationPath(path: string): boolean {
	return micromatch.isMatch(path, DOC_PATTERNS, MATCH_OPTIONS)
}

/**
 * Check whether every changed file is docs-only.
 *
 * @param context - Decision context.
 * @returns `NO_AGENT_PORT_NEEDED` when all files are documentation.
 */
function checkDocsOnly(context: PortContext): PortDecision | null {
	const files = context.sourceChange.files

	if (files.length === 0) {
		return null
	}

	const docsOnly =
		files.every(file => isDocumentationPath(file.path)) &&
		files.some(file => !isConfigPath(file.path))

	if (docsOnly) {
		return {
			kind: 'NO_AGENT_PORT_NEEDED',
			reason: skipReason(
				context,
				'Skipping because all changed files are documentation-only.',
				'Remaining files are documentation-only.',
			),
		}
	}

	return null
}

/**
 * Check whether a path is a root-level JSON file.
 *
 * @param path - Repository-relative path.
 * @returns `true` when file is `*.json` at repo root.
 */
function isRootJsonPath(path: string): boolean {
	return path.endsWith('.json') && !path.includes('/')
}

/**
 * Check whether a path is ignorable for config-only detection.
 *
 * @param path - Repository-relative path.
 * @param ignorePatterns - Plugin ignore patterns.
 * @returns `true` when path matches an ignore pattern.
 */
function isIgnoredPath(path: string, ignorePatterns: string[]): boolean {
	if (ignorePatterns.length === 0) {
		return false
	}

	return micromatch.isMatch(path, ignorePatterns, MATCH_OPTIONS)
}

/**
 * Check whether a path is config/CI related.
 *
 * @param path - Repository-relative path.
 * @returns `true` when path is config-like.
 */
function isConfigPath(path: string): boolean {
	return micromatch.isMatch(path, CONFIG_PATTERNS, MATCH_OPTIONS) || isRootJsonPath(path)
}

/**
 * Check whether every changed file is config-only or explicitly ignored.
 *
 * @param context - Decision context.
 * @returns `NO_AGENT_PORT_NEEDED` when all files are config/ignorable.
 */
function checkConfigOnly(context: PortContext): PortDecision | null {
	const files = context.sourceChange.files

	if (files.length === 0) {
		return null
	}

	const ignorePatterns = context.pluginConfig.ignorePatterns
	const configOnly = files.every(
		file => isConfigPath(file.path) || isIgnoredPath(file.path, ignorePatterns),
	)

	if (configOnly) {
		return {
			kind: 'NO_AGENT_PORT_NEEDED',
			reason: skipReason(
				context,
				'Skipping because all changed files are config-only or explicitly ignored.',
				'Remaining files are config-only or explicitly ignored.',
			),
		}
	}

	return null
}

/**
 * Ordered list of heuristics that must suppress the run before any deterministic
 * target mutation happens.
 *
 * These are global skip/loop-prevention signals, not residual-work decisions.
 */
export const PRE_DETERMINISTIC_SKIP_HEURISTICS: DecisionHeuristic[] = [
	checkMissingPullRequest,
	checkLoopPrevention,
	checkNoPortLabel,
]

/**
 * Ordered list of fast heuristics for the decision stage.
 *
 * Pre-deterministic skip heuristics are intentionally excluded here because
 * `decidePreDeterministicSkip` already runs them earlier in the pipeline.
 * Including them would cause redundant evaluation.
 */
export const DECISION_HEURISTICS: DecisionHeuristic[] = [
	checkDocsOnly,
	checkConfigOnly,
	checkNoRemainingFiles,
]

import micromatch from 'micromatch'

import type { PortContext, PortDecision } from '../types.ts'

type DecisionHeuristic = (context: PortContext) => PortDecision | null

const DOC_PATTERNS = ['README.md', '**/*.md', 'docs/**', 'LICENSE', 'CHANGELOG*']

const CONFIG_PATTERNS = [
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
 * Check if the source change has no associated pull request context.
 *
 * @param context - Decision context.
 * @returns `NEEDS_HUMAN` when pull request metadata is missing.
 */
function checkMissingPullRequest(context: PortContext): PortDecision | null {
	if (!context.sourceChange.pullRequest) {
		return {
			kind: 'NEEDS_HUMAN',
			reason: 'Source commit could not be associated with a pull request.',
			signals: ['missing-pr'],
		}
	}

	return null
}

/**
 * Check loop-prevention signals that indicate this is already a bot-generated port.
 *
 * @param context - Decision context.
 * @returns `PORT_NOT_REQUIRED` when loop-prevention signal is present.
 */
function checkLoopPrevention(context: PortContext): PortDecision | null {
	const labels = context.sourceChange.pullRequest?.labels ?? []
	const normalizedLabels = labels.map(label => label.toLowerCase())
	const hasAutoPortLabel = normalizedLabels.includes('auto-port')

	if (hasAutoPortLabel) {
		return {
			kind: 'PORT_NOT_REQUIRED',
			reason: 'Skipping because source PR is labeled auto-port (loop prevention).',
			signals: ['loop-prevention', 'auto-port-label'],
		}
	}

	return null
}

/**
 * Check explicit `no-port` label override.
 *
 * @param context - Decision context.
 * @returns `PORT_NOT_REQUIRED` when no-port label is set.
 */
function checkNoPortLabel(context: PortContext): PortDecision | null {
	const labels = context.sourceChange.pullRequest?.labels ?? []
	const normalizedLabels = labels.map(label => label.toLowerCase())
	const hasNoPortLabel = normalizedLabels.includes('no-port')

	if (hasNoPortLabel) {
		return {
			kind: 'PORT_NOT_REQUIRED',
			reason: 'Skipping because source PR is labeled no-port.',
			signals: ['no-port-label'],
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
	return micromatch.isMatch(path, DOC_PATTERNS)
}

/**
 * Check whether every changed file is docs-only.
 *
 * @param context - Decision context.
 * @returns `PORT_NOT_REQUIRED` when all files are documentation.
 */
function checkDocsOnly(context: PortContext): PortDecision | null {
	const files = context.sourceChange.files

	if (files.length === 0) {
		return null
	}

	const docsOnly = files.every(file => isDocumentationPath(file.path))

	if (docsOnly) {
		return {
			kind: 'PORT_NOT_REQUIRED',
			reason: 'Skipping because all changed files are documentation-only.',
			signals: ['docs-only'],
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

	return micromatch.isMatch(path, ignorePatterns)
}

/**
 * Check whether a path is config/CI related.
 *
 * @param path - Repository-relative path.
 * @returns `true` when path is config-like.
 */
function isConfigPath(path: string): boolean {
	return micromatch.isMatch(path, CONFIG_PATTERNS) || isRootJsonPath(path)
}

/**
 * Check whether every changed file is config-only or explicitly ignored.
 *
 * @param context - Decision context.
 * @returns `PORT_NOT_REQUIRED` when all files are config/ignorable.
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
			kind: 'PORT_NOT_REQUIRED',
			reason: 'Skipping because all changed files are config-only or explicitly ignored.',
			signals: ['config-only'],
		}
	}

	return null
}

/**
 * Ordered list of fast heuristics for the decision stage.
 */
export const DECISION_HEURISTICS: DecisionHeuristic[] = [
	checkMissingPullRequest,
	checkLoopPrevention,
	checkNoPortLabel,
	checkDocsOnly,
	checkConfigOnly,
]

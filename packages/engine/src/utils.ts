import { isAbsolute, relative } from 'node:path'

import { formatPortBotLine } from '@repo-port-bot/logger'

import type { Logger } from '@repo-port-bot/logger'

import type { AgentMessage } from './types.ts'

const MIN_DURATION_MS = 1
const MS_PER_SECOND = 1000
const MS_PER_TENTH_SECOND = 100
const TENTHS_PER_SECOND = 10
const MS_PER_MINUTE = 60_000

/**
 * Measure elapsed runtime in milliseconds.
 *
 * @param startedAtMs - Start timestamp from `Date.now()`.
 * @returns Elapsed duration, floored at 1ms.
 */
export function getDurationMs(startedAtMs: number): number {
	return Math.max(MIN_DURATION_MS, Date.now() - startedAtMs)
}

/**
 * Format milliseconds as a human-readable duration string.
 *
 * @param ms - Duration in milliseconds.
 * @returns Formatted string like `3m23s`, `18.6s`, or `234ms`.
 */
export function formatDuration(ms: number): string {
	if (ms < MS_PER_SECOND) {
		return `${String(ms)}ms`
	}

	if (ms < MS_PER_MINUTE) {
		const truncatedTenths = Math.floor(ms / MS_PER_TENTH_SECOND) / TENTHS_PER_SECOND

		return `${truncatedTenths.toFixed(1)}s`
	}

	const minutes = Math.floor(ms / MS_PER_MINUTE)
	const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND)

	return `${String(minutes)}m${String(seconds).padStart(2, '0')}s`
}

/**
 * Get a user-friendly error message string.
 *
 * @param error - Unknown thrown value.
 * @returns Normalized error message.
 */
export function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message
	}

	return String(error)
}

/**
 * Join text lines while skipping undefined/blank values.
 *
 * Useful when building optional multiline summaries from conditional parts.
 *
 * @param lines - Candidate lines to combine.
 * @param delimiter - Separator inserted between lines. Defaults to newline.
 * @returns Joined text, or `undefined` when no non-blank lines exist.
 */
export function joinNonEmptyLines(
	lines: (string | undefined)[],
	delimiter = '\n',
): string | undefined {
	const nonEmptyLines = lines.filter(line => line && line.trim().length > 0)

	if (nonEmptyLines.length === 0) {
		return undefined
	}

	return nonEmptyLines.join(delimiter)
}

/**
 * Extract file path from a tool input payload by checking common key names.
 *
 * @param toolInput - Tool input payload from streamed event.
 * @returns File path when present.
 */
function extractFilePath(toolInput: Record<string, unknown> | undefined): string | undefined {
	if (!toolInput) {
		return undefined
	}

	for (const key of ['file_path', 'path', 'file'] as const) {
		const value = toolInput[key]

		if (typeof value === 'string' && value.length > 0) {
			return value
		}
	}

	return undefined
}

/**
 * Normalize a file path to source/target-relative when inside known roots.
 *
 * @param input - Path normalization input.
 * @param input.filePath - Candidate raw path from tool input.
 * @param input.targetWorkingDirectory - Optional target repo root.
 * @param input.sourceWorkingDirectory - Optional source repo root.
 * @returns Relative path when inside known roots, else original path.
 */
function normalizeLoggedFilePath(input: {
	filePath: string | undefined
	targetWorkingDirectory?: string
	sourceWorkingDirectory?: string
}): string | undefined {
	const filePath = input.filePath

	if (!filePath || !isAbsolute(filePath)) {
		return filePath
	}

	for (const root of [input.targetWorkingDirectory, input.sourceWorkingDirectory]) {
		if (root) {
			const relativePath = relative(root, filePath)

			if (relativePath && !relativePath.startsWith('..')) {
				return relativePath
			}
		}
	}

	return filePath
}

const DEFAULT_MAX_LOG_TEXT_LENGTH = 240

/**
 * Truncate long text to keep line-oriented log output readable.
 *
 * @param value - Candidate text value.
 * @param maxLength - Maximum length before truncation. Defaults to 240.
 * @returns Truncated text with ellipsis when needed.
 */
function truncateLogText(
	value: string | undefined,
	maxLength = DEFAULT_MAX_LOG_TEXT_LENGTH,
): string | undefined {
	if (!value) {
		return undefined
	}

	if (value.length <= maxLength) {
		return value
	}

	return `${value.slice(0, maxLength - 3)}...`
}

/**
 * Log one streamed agent message using structured line formatting.
 *
 * Shared by both decision and execution stages to avoid drift.
 *
 * @param input - Message logging input.
 * @param input.logger - Logger implementation.
 * @param input.runId - Run identifier for correlation.
 * @param input.stage - Pipeline stage name for log lines.
 * @param input.message - Streamed agent message.
 * @param input.targetWorkingDirectory - Optional target repo root for path normalization.
 * @param input.sourceWorkingDirectory - Optional source repo root for path normalization.
 */
export function logAgentMessage(input: {
	logger: Logger
	runId: string
	stage: string
	message: AgentMessage
	targetWorkingDirectory?: string
	sourceWorkingDirectory?: string
}): void {
	const { logger, runId, stage, message } = input

	if (message.kind === 'tool_start') {
		const loggedFilePath = normalizeLoggedFilePath({
			filePath: extractFilePath(message.toolInput),
			targetWorkingDirectory: input.targetWorkingDirectory,
			sourceWorkingDirectory: input.sourceWorkingDirectory,
		})

		logger.info(
			formatPortBotLine({
				runId,
				fields: {
					stage,
					tool: message.toolName,
					file: loggedFilePath,
				},
			}),
		)

		return
	}

	if (message.kind === 'tool_end') {
		logger.debug(
			formatPortBotLine({
				runId,
				fields: {
					stage,
					tool: message.toolName,
					toolDurationMs: message.durationMs,
				},
			}),
		)

		return
	}

	logger.debug(
		formatPortBotLine({
			runId,
			fields: {
				stage,
				[message.kind]: truncateLogText(message.text),
			},
		}),
	)
}

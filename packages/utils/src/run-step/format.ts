import { bold, dim } from 'colorette'

const MILLIS_PER_SECOND = 1000
const ROUND_MILLISECONDS = 0
const DURATION_DECIMALS = 2

/**
 * Format elapsed milliseconds as a human-readable duration token.
 *
 * @param durationMs - Elapsed duration in milliseconds.
 * @returns Duration label wrapped in brackets.
 */
function formatDurationLabel(durationMs: number): string {
	if (durationMs < MILLIS_PER_SECOND) {
		return `${Math.round(durationMs).toFixed(ROUND_MILLISECONDS)}ms`
	}

	return `${(durationMs / MILLIS_PER_SECOND).toFixed(DURATION_DECIMALS)}s`
}

/**
 * Build the canonical success text styling used by step/task output.
 *
 * @param label - Step/task label.
 * @param durationMs - Elapsed duration in milliseconds.
 * @returns Bold label with dimmed duration suffix.
 */
export function formatStepSuccessText(label: string, durationMs: number): string {
	return `${bold(label)} ${dim(`[${formatDurationLabel(durationMs)}]`)}`
}

/**
 * Build the canonical task result text for both interactive and non-TTY output.
 *
 * @param input - Result rendering input.
 * @param input.ok - Whether the task succeeded.
 * @param input.label - Task display label.
 * @param input.durationMs - Elapsed duration in milliseconds.
 * @param input.cancelled - Whether the task was cancelled before completing.
 * @param input.includeFailurePrefix - Whether to prefix failures with `Failed:`.
 * @returns Formatted task result text.
 */
export function formatTaskResultText(input: {
	ok: boolean
	label: string
	durationMs: number
	cancelled?: boolean
	includeFailurePrefix?: boolean
}): string {
	const formattedLabel = formatStepSuccessText(input.label, input.durationMs)

	if (input.cancelled === true) {
		return `Cancelled: ${dim(input.label)} ${dim(`[${formatDurationLabel(input.durationMs)}]`)}`
	}

	if (input.includeFailurePrefix === true && !input.ok) {
		return `Failed: ${formattedLabel}`
	}

	return formattedLabel
}

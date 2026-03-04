const MIN_DURATION_MS = 1

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

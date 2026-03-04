/**
 * Format a Date into YYYY-MM-DD string.
 */
export function formatDate(date: Date): string {
	const year = date.getFullYear()
	const month = String(date.getMonth() + 1).padStart(2, '0')
	const day = String(date.getDate()).padStart(2, '0')
	return `${year}-${month}-${day}`
}

/**
 * Parse a YYYY-MM-DD string into a Date.
 */
export function parseDate(input: string): Date {
	const date = new Date(input)
	if (Number.isNaN(date.getTime())) {
		throw new Error(`Invalid date string: ${input}`)
	}
	return date
}

/**
 * Check whether a Date falls within a given range (inclusive).
 */
export function isDateInRange(date: Date, start: Date, end: Date): boolean {
	const timestamp = date.getTime()
	return timestamp >= start.getTime() && timestamp <= end.getTime()
}

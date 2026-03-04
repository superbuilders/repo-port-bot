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

/**
 * Return a human-readable relative time string like "3 days ago" or "in 2 hours".
 */
export function formatRelativeDate(date: Date, now: Date = new Date()): string {
	const diffMs = date.getTime() - now.getTime()
	const absDiffMs = Math.abs(diffMs)
	const seconds = Math.floor(absDiffMs / 1000)
	const minutes = Math.floor(seconds / 60)
	const hours = Math.floor(minutes / 60)
	const days = Math.floor(hours / 24)

	let label: string
	if (days > 0) label = `${String(days)} day${days === 1 ? '' : 's'}`
	else if (hours > 0) label = `${String(hours)} hour${hours === 1 ? '' : 's'}`
	else if (minutes > 0) label = `${String(minutes)} minute${minutes === 1 ? '' : 's'}`
	else label = `${String(seconds)} second${seconds === 1 ? '' : 's'}`

	if (diffMs < 0) return `${label} ago`
	if (diffMs > 0) return `in ${label}`
	return 'just now'
}

/**
 * Capitalize the first letter of a string.
 */
export function capitalize(input: string): string {
	if (input.length === 0) return input
	return input.charAt(0).toUpperCase() + input.slice(1)
}

/**
 * Convert a string to a URL-friendly slug.
 */
export function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^\w\s-]/g, '')
		.replace(/[\s_]+/g, '-')
		.replace(/-+/g, '-')
}

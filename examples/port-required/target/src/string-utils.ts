/**
 * Capitalize the first letter of a string.
 */
export function capitalize(input: string): string {
	if (input.length === 0) return input
	return input.charAt(0).toUpperCase() + input.slice(1)
}

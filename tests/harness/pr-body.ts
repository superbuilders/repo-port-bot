/**
 * Structured helpers for asserting on PR body content.
 *
 * Parses the markdown PR body into sections so tests can assert on specific
 * parts without fragile raw-string matching that accidentally hits command
 * names, headings, or other unrelated content.
 */
import type { ParsedPrBody } from './types.ts'

export type { ParsedPrBody } from './types.ts'

/**
 * Extract the content between a `<details>` block with the given summary text.
 *
 * @param body - Full PR body markdown.
 * @param summary - The `<summary>` text to match (case-insensitive substring).
 * @returns Content between the details tags, or empty string if not found.
 */
export function extractDetailsBlock(body: string, summary: string): string {
	const lowerSummary = summary.toLowerCase()
	const lines = body.split('\n')
	let collecting = false
	let depth = 0
	const collected: string[] = []

	for (const line of lines) {
		const lower = line.toLowerCase()

		if (!collecting && lower.includes('<summary>') && lower.includes(lowerSummary)) {
			collecting = true
			depth = 1
		} else if (collecting) {
			if (lower.includes('<details')) {
				depth++
			}

			if (lower.includes('</details>')) {
				depth--

				if (depth === 0) {
					break
				}
			}

			collected.push(line)
		}
	}

	return collected.join('\n').trim()
}

/**
 * Extract the content under a markdown heading (## or ###).
 *
 * @param body - Full PR body markdown.
 * @param heading - Heading text to match (case-insensitive).
 * @returns Content from after the heading to the next heading of equal or higher level.
 */
export function extractSection(body: string, heading: string): string {
	const lines = body.split('\n')
	const lowerHeading = heading.toLowerCase()
	let collecting = false
	let headingLevel = 0
	const collected: string[] = []

	for (const line of lines) {
		const headingMatch = /^(#{1,6})\s+(.+)$/u.exec(line)

		if (headingMatch) {
			const level = headingMatch[1]!.length
			const text = headingMatch[2]!.trim().toLowerCase()

			if (!collecting && text === lowerHeading) {
				collecting = true
				headingLevel = level
			} else if (collecting && level <= headingLevel) {
				break
			} else if (collecting) {
				collected.push(line)
			}
		} else if (collecting) {
			collected.push(line)
		}
	}

	return collected.join('\n').trim()
}

/**
 * Parse a PR body into structured sections for assertions.
 *
 * @param body - Raw PR body markdown.
 * @returns Parsed sections.
 */
export function parsePrBody(body: string): ParsedPrBody {
	const headings = [
		'Port rationale',
		'What changed',
		'What was ported',
		'What is already done',
		'What still needs human review',
	]
	const sections = new Map<string, string>()

	for (const heading of headings) {
		const content = extractSection(body, heading)

		if (content) {
			sections.set(heading, content)
		}
	}

	return {
		raw: body,
		rationale: extractSection(body, 'Port rationale'),
		diagnostics: extractDetailsBlock(body, 'Validation & diagnostics'),
		workLog: extractDetailsBlock(body, 'Work Log'),
		sections,
	}
}

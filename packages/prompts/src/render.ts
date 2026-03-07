import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TEMPLATES_DIR = join(import.meta.dirname, 'templates')

const templateCache = new Map<string, string>()

/**
 * Load a prompt template by name.
 *
 * @param name - Template filename without extension.
 * @returns Raw template text.
 */
function loadTemplate(name: string): string {
	const cached = templateCache.get(name)

	if (cached) {
		return cached
	}

	const content = readFileSync(join(TEMPLATES_DIR, `${name}.md`), 'utf8').trim()

	templateCache.set(name, content)

	return content
}

/**
 * Render a template by replacing `{{slot}}` placeholders with values.
 *
 * Slots whose values are `undefined` or empty strings are removed along
 * with their surrounding blank lines, so optional sections disappear
 * cleanly without leaving gaps.
 *
 * @param template - Raw template text with `{{slot}}` placeholders.
 * @param slots - Key-value map of slot names to values.
 * @returns Rendered text.
 */
export function renderTemplate(
	template: string,
	slots: Record<string, string | undefined>,
): string {
	let rendered = template

	for (const [key, value] of Object.entries(slots)) {
		const placeholder = `{{${key}}}`

		if (value && value.trim().length > 0) {
			rendered = rendered.replaceAll(placeholder, value)
		} else {
			rendered = rendered.replaceAll(
				new RegExp(`\\n*${escapeRegex(placeholder)}\\n*`, 'g'),
				'\n',
			)
		}
	}

	return rendered.replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Escape special regex characters in a string.
 *
 * @param str - Input string.
 * @returns Escaped string safe for use in a RegExp.
 */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
}

/**
 * Load and render a named prompt template.
 *
 * @param name - Template name (e.g. `'execution-system'`).
 * @param slots - Key-value slot replacements.
 * @returns Rendered prompt text.
 */
export function renderPrompt(name: string, slots: Record<string, string | undefined>): string {
	return renderTemplate(loadTemplate(name), slots)
}

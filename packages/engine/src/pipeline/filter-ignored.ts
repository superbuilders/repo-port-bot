import micromatch from 'micromatch'

import type { ChangedFile } from '../types.ts'

/**
 * Filter changed files using configured ignore patterns.
 *
 * @param files - Changed files from source context.
 * @param ignorePatterns - Glob patterns that should be excluded.
 * @returns Changed files that do not match ignore patterns.
 */
export function filterIgnoredFiles(files: ChangedFile[], ignorePatterns: string[]): ChangedFile[] {
	if (ignorePatterns.length === 0) {
		return files
	}

	return files.filter(file => !matchesAnyPattern(file.path, ignorePatterns))
}

/**
 * Remove ignored file sections from a unified git diff.
 *
 * @param diffContent - Raw diff content.
 * @param ignorePatterns - Glob patterns that should be excluded.
 * @returns Diff content without ignored file sections.
 */
export function filterDiffContent(diffContent: string, ignorePatterns: string[]): string {
	if (ignorePatterns.length === 0 || diffContent.length === 0) {
		return diffContent
	}

	const sectionHeader = /^diff --git a\/(.+?) b\/(.+)$/gm
	const sections: {
		start: number
		end: number
		oldPath: string
		newPath: string
	}[] = []

	for (const match of diffContent.matchAll(sectionHeader)) {
		const start = match.index

		if (start !== undefined) {
			sections.push({
				start,
				end: diffContent.length,
				oldPath: match[1] ?? '',
				newPath: match[2] ?? '',
			})
		}
	}

	if (sections.length === 0) {
		return diffContent
	}

	for (let index = 0; index < sections.length - 1; index += 1) {
		const next = sections[index + 1]

		if (next) {
			sections[index]!.end = next.start
		}
	}

	const preserved: string[] = [diffContent.slice(0, sections[0]!.start)]

	for (const section of sections) {
		const ignored =
			matchesAnyPattern(section.oldPath, ignorePatterns) ||
			matchesAnyPattern(section.newPath, ignorePatterns)

		if (!ignored) {
			preserved.push(diffContent.slice(section.start, section.end))
		}
	}

	return preserved.join('')
}

/**
 * Check whether a path matches any configured ignore pattern.
 *
 * @param path - Repository-relative path.
 * @param ignorePatterns - Glob patterns to match against.
 * @returns `true` when path matches at least one ignore pattern.
 */
function matchesAnyPattern(path: string, ignorePatterns: string[]): boolean {
	return micromatch.isMatch(path, ignorePatterns)
}

import { describe, expect, test } from 'bun:test'

import { filterDiffContent, filterIgnoredFiles } from './filter-ignored.ts'

import type { ChangedFile } from '../types.ts'

/**
 * Build a minimal changed-file fixture.
 *
 * @param path - Repository-relative path.
 * @returns Changed-file metadata fixture.
 */
function makeFile(path: string): ChangedFile {
	return {
		path,
		status: 'modified',
		additions: 1,
		deletions: 1,
	}
}

describe('filterIgnoredFiles', () => {
	test('returns original list when ignore patterns are empty', () => {
		const files = [makeFile('src/a.ts'), makeFile('.github/workflows/ci.yml')]

		expect(filterIgnoredFiles(files, [])).toEqual(files)
	})

	test('removes files matching an ignore pattern', () => {
		const files = [makeFile('src/a.ts'), makeFile('.github/workflows/ci.yml')]

		expect(filterIgnoredFiles(files, ['.github/**'])).toEqual([makeFile('src/a.ts')])
	})

	test('keeps non-ignored files when mixed with ignored files', () => {
		const files = [
			makeFile('src/a.ts'),
			makeFile('scripts/release.ts'),
			makeFile('tests/infra/example.test.ts'),
		]

		expect(filterIgnoredFiles(files, ['scripts/**'])).toEqual([
			makeFile('src/a.ts'),
			makeFile('tests/infra/example.test.ts'),
		])
	})

	test('returns empty list when all files are ignored', () => {
		const files = [makeFile('.github/workflows/ci.yml'), makeFile('scripts/release.ts')]

		expect(filterIgnoredFiles(files, ['.github/**', 'scripts/**'])).toEqual([])
	})
})

describe('filterDiffContent', () => {
	test('returns original diff when ignore patterns are empty', () => {
		const diff = [
			'diff --git a/src/a.ts b/src/a.ts',
			'index 0000000..1111111 100644',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -1 +1 @@',
			'-old',
			'+new',
			'',
		].join('\n')

		expect(filterDiffContent(diff, [])).toBe(diff)
	})

	test('removes matching file sections and keeps non-matching sections', () => {
		const diff = [
			'diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml',
			'index 0000000..1111111 100644',
			'--- a/.github/workflows/ci.yml',
			'+++ b/.github/workflows/ci.yml',
			'@@ -1 +1 @@',
			'-name: old',
			'+name: new',
			'diff --git a/src/a.ts b/src/a.ts',
			'index 0000000..1111111 100644',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -1 +1 @@',
			'-old',
			'+new',
			'',
		].join('\n')

		const result = filterDiffContent(diff, ['.github/**'])

		expect(result).not.toContain('.github/workflows/ci.yml')
		expect(result).toContain('diff --git a/src/a.ts b/src/a.ts')
		expect(result).toContain('+new')
	})

	test('returns original diff when no section matches ignore patterns', () => {
		const diff = [
			'diff --git a/src/a.ts b/src/a.ts',
			'index 0000000..1111111 100644',
			'--- a/src/a.ts',
			'+++ b/src/a.ts',
			'@@ -1 +1 @@',
			'-old',
			'+new',
			'',
		].join('\n')

		expect(filterDiffContent(diff, ['scripts/**'])).toBe(diff)
	})

	test('returns empty string when input diff is empty', () => {
		expect(filterDiffContent('', ['.github/**'])).toBe('')
	})
})

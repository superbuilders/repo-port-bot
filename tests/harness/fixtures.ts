/**
 * Source change factory functions for scenario tests.
 */
import type { SourceChange } from '../../packages/engine/src/index.ts'

/**
 * @param overrides - Fields to override on the default source change.
 * @returns Source change fixture.
 */
export function makeSourceChange(overrides?: Partial<SourceChange>): SourceChange {
	return {
		mergedCommitSha: 'scenario-test-sha-0000000',
		pullRequest: {
			number: 42,
			title: 'Add feature X',
			body: 'Implements feature X.',
			url: 'https://github.com/acme/source-repo/pull/42',
			labels: [],
		},
		files: [{ path: 'src/feature.ts', status: 'added', additions: 50, deletions: 0 }],
		...overrides,
	}
}

/**
 * @returns Source change with docs-only files.
 */
export function makeDocsOnlyChange(): SourceChange {
	return makeSourceChange({
		pullRequest: {
			number: 50,
			title: 'Update docs',
			body: 'Documentation only.',
			url: 'https://github.com/acme/source-repo/pull/50',
			labels: [],
		},
		files: [
			{ path: 'README.md', status: 'modified', additions: 10, deletions: 2 },
			{ path: 'docs/guide.md', status: 'added', additions: 30, deletions: 0 },
		],
	})
}

/**
 * @returns Source change with no-port label.
 */
export function makeNoPortChange(): SourceChange {
	return makeSourceChange({
		pullRequest: {
			number: 60,
			title: 'Skip this one',
			body: 'Labeled no-port.',
			url: 'https://github.com/acme/source-repo/pull/60',
			labels: ['no-port'],
		},
	})
}

/**
 * @returns Source change where all files are config/CI patterns.
 */
export function makeConfigOnlyChange(): SourceChange {
	return makeSourceChange({
		pullRequest: {
			number: 55,
			title: 'Update CI pipeline',
			body: 'CI config changes only.',
			url: 'https://github.com/acme/source-repo/pull/55',
			labels: [],
		},
		files: [
			{ path: '.github/workflows/ci.yml', status: 'modified', additions: 5, deletions: 2 },
			{ path: '.changeset/config.json', status: 'modified', additions: 1, deletions: 1 },
		],
	})
}

/**
 * @returns Source change with auto-port label (loop prevention).
 */
export function makeAutoPortChange(): SourceChange {
	return makeSourceChange({
		pullRequest: {
			number: 70,
			title: 'Port: something',
			body: 'Already ported.',
			url: 'https://github.com/acme/source-repo/pull/70',
			labels: ['auto-port'],
		},
	})
}

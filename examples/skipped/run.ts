#!/usr/bin/env bun
/**
 * SKIPPED scenario — docs-only change triggers PORT_NOT_REQUIRED heuristic.
 *
 * Usage:
 *   bun examples/skipped/run.ts
 *
 * No API key needed — the pipeline skips immediately. Demonstrates the
 * heuristic skip path with a source PR skip notification.
 */
import { cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { runPort } from '../../packages/engine/src/index.ts'
import { createConsoleLogger } from '../../packages/logger/src/index.ts'

import type {
	ChangedFile,
	GitHubReader,
	GitHubWriter,
	PullRequestRef,
	SourceChange,
} from '../../packages/engine/src/index.ts'

const EXAMPLE_DIR = resolve(import.meta.dirname ?? '.')

const docsOnlyChange: SourceChange = {
	mergedCommitSha: 'docs-only-sha-example',
	pullRequest: {
		number: 50,
		title: 'Update README with setup instructions',
		body: 'Documentation update only.',
		url: 'https://github.com/example/source-repo/pull/50',
		labels: [],
	},
	files: [
		{ path: 'README.md', status: 'modified', additions: 15, deletions: 3 },
		{ path: 'docs/setup.md', status: 'added', additions: 40, deletions: 0 },
	],
}

/**
 * GitHubReader returning canned source change data.
 *
 * @param change - Source change fixture.
 * @returns In-memory reader.
 */
function createLocalReader(change: SourceChange): GitHubReader {
	return {
		async listPullRequestsForCommit(): Promise<PullRequestRef[]> {
			return change.pullRequest ? [change.pullRequest] : []
		},
		async listChangedFiles(): Promise<ChangedFile[]> {
			return change.files
		},
		async getFileContent(): Promise<string | undefined> {
			return undefined
		},
	}
}

/**
 * GitHubWriter that logs the skip notification comment.
 *
 * @returns Dry-run writer.
 */
function createDryRunWriter(): GitHubWriter {
	return {
		async createPullRequest() {
			return { number: 0, url: '' }
		},
		async createIssue() {
			return { number: 0, url: '' }
		},
		async addLabels() {},
		async createComment(params) {
			console.log('\n--- [dry-run] Would comment on source PR ---')
			console.log(params.body)

			return 'https://example.com/comment/1'
		},
	}
}

// --- setup ---

const targetDir = mkdtempSync(join(tmpdir(), 'port-bot-target-'))

cpSync(join(EXAMPLE_DIR, 'target'), targetDir, { recursive: true })

Bun.spawnSync(['git', 'init'], { cwd: targetDir })
Bun.spawnSync(['git', 'add', '-A'], { cwd: targetDir })
Bun.spawnSync(['git', 'commit', '-m', 'initial'], { cwd: targetDir })

console.log(`Target: ${targetDir}`)
console.log('\n========================================')
console.log('  SKIPPED — docs-only change')
console.log('========================================\n')

// --- run pipeline ---

const result = await runPort({
	reader: createLocalReader(docsOnlyChange),
	writer: createDryRunWriter(),
	agentProvider: {
		async decidePort() {
			throw new Error('Should not be called — heuristic matches first.')
		},
		async executePort() {
			throw new Error('Should not be called in PORT_NOT_REQUIRED path.')
		},
	},
	sourceRepo: { owner: 'example', name: 'source-repo', defaultBranch: 'main' },
	commitSha: docsOnlyChange.mergedCommitSha,
	targetWorkingDirectory: targetDir,
	portBotJson: { target: 'example/target-repo', validation: ['true'] },
	logger: createConsoleLogger('info'),
})

// --- output ---

console.log('\n========================================')
console.log('  Result')
console.log('========================================')
console.log(JSON.stringify(result, null, 2))

#!/usr/bin/env bun
/**
 * NEEDS_HUMAN scenario — forced decision defers to human review.
 *
 * Usage:
 *   bun examples/needs-human/run.ts
 *
 * No API key needed — the pipeline never reaches the execution stage.
 * Demonstrates the issue-creation and source-comment notification paths.
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

const sourceChange: SourceChange = {
	mergedCommitSha: 'abc1234567890example',
	pullRequest: {
		number: 99,
		title: 'Add formatRelativeDate and slugify utilities',
		body: 'Adds `formatRelativeDate` to date-utils.ts and `slugify` to string-utils.ts.',
		url: 'https://github.com/example/source-repo/pull/99',
		labels: [],
	},
	files: [
		{ path: 'src/date-utils.ts', status: 'modified', additions: 28, deletions: 0 },
		{ path: 'src/string-utils.ts', status: 'modified', additions: 12, deletions: 0 },
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
 * GitHubWriter that logs operations instead of calling GitHub.
 *
 * @returns Dry-run writer.
 */
function createDryRunWriter(): GitHubWriter {
	return {
		async createPullRequest(params) {
			console.log('\n--- [dry-run] Would create pull request ---')
			console.log(`  title: ${params.title}`)

			return { number: 1, url: 'https://example.com/pull/1' }
		},
		async createIssue(params) {
			console.log('\n--- [dry-run] Would create issue ---')
			console.log(`  title:  ${params.title}`)
			console.log(`  labels: ${params.labels.join(', ')}`)

			return { number: 1, url: 'https://example.com/issues/1' }
		},
		async addLabels(params) {
			console.log(`--- [dry-run] Would add labels: ${params.labels.join(', ')}`)
		},
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
console.log('  NEEDS_HUMAN — classifier stub')
console.log('========================================\n')

// --- run pipeline ---

const result = await runPort({
	reader: createLocalReader(sourceChange),
	writer: createDryRunWriter(),
	agentProvider: {
		async decidePort() {
			throw new Error('Should not be called — decide is overridden.')
		},
		async executePort() {
			throw new Error('Should not be called in NEEDS_HUMAN path.')
		},
	},
	sourceRepo: { owner: 'example', name: 'source-repo', defaultBranch: 'main' },
	commitSha: sourceChange.mergedCommitSha,
	targetWorkingDirectory: targetDir,
	portBotJson: { target: 'example/target-repo', validation: ['true'] },
	logger: createConsoleLogger('info'),
	stageOverrides: {
		decide: async () => ({
			kind: 'NEEDS_HUMAN',
			reason: 'Forced NEEDS_HUMAN for local example.',
		}),
	},
})

// --- output ---

console.log('\n========================================')
console.log('  Result')
console.log('========================================')
console.log(JSON.stringify(result, null, 2))

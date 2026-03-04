#!/usr/bin/env bun
/**
 * PORT_REQUIRED scenario — real Claude edits files in the target repo.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun examples/port-required/run.ts
 *
 * Forces decision to PORT_REQUIRED so the agent executes. Validation is
 * `true` (always passes) so the focus is on seeing what Claude produces.
 */
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { ClaudeAgentProvider } from '../../packages/agent-claude/src/index.ts'
import { deliverResult, runPort } from '../../packages/engine/src/index.ts'
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
		{
			path: 'src/date-utils.ts',
			status: 'modified',
			additions: 28,
			deletions: 0,
			patch: [
				'@@ -29,3 +29,31 @@',
				'+/**',
				'+ * Return a human-readable relative time string.',
				'+ */',
				'+export function formatRelativeDate(date: Date, now: Date = new Date()): string {',
				'+  ...',
				'+}',
			].join('\n'),
		},
		{
			path: 'src/string-utils.ts',
			status: 'modified',
			additions: 12,
			deletions: 0,
			patch: [
				'@@ -9,3 +9,15 @@',
				'+/**',
				'+ * Convert a string to a URL-friendly slug.',
				'+ */',
				'+export function slugify(input: string): string {',
				'+  ...',
				'+}',
			].join('\n'),
		},
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
			console.log(`  repo:  ${params.owner}/${params.repo}`)
			console.log(`  title: ${params.title}`)
			console.log(`  head:  ${params.head} → ${params.base}`)
			console.log(`  draft: ${String(params.draft)}`)

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

const apiKey = process.env['ANTHROPIC_API_KEY']

if (!apiKey) {
	console.error('Missing ANTHROPIC_API_KEY environment variable.')
	process.exit(1)
}

const targetDir = mkdtempSync(join(tmpdir(), 'port-bot-target-'))
const sourceDir = mkdtempSync(join(tmpdir(), 'port-bot-source-'))

cpSync(join(EXAMPLE_DIR, 'target'), targetDir, { recursive: true })

Bun.spawnSync(['git', 'init'], { cwd: targetDir })
Bun.spawnSync(['git', 'add', '-A'], { cwd: targetDir })
Bun.spawnSync(['git', 'commit', '-m', 'initial'], { cwd: targetDir })

cpSync(join(EXAMPLE_DIR, 'target'), sourceDir, { recursive: true })
Bun.spawnSync(['git', 'init'], { cwd: sourceDir })
Bun.spawnSync(['git', 'add', '-A'], { cwd: sourceDir })
Bun.spawnSync(['git', 'commit', '-m', 'before'], { cwd: sourceDir })

cpSync(join(EXAMPLE_DIR, 'source'), sourceDir, { recursive: true })

const diffFilePath = join(sourceDir, 'port-diff.patch')
const diffResult = Bun.spawnSync(['git', 'diff'], { cwd: sourceDir })

writeFileSync(diffFilePath, diffResult.stdout.toString())

console.log(`Source: ${sourceDir}`)
console.log(`Target: ${targetDir}`)
console.log('\n========================================')
console.log('  PORT_REQUIRED — real Claude')
console.log('========================================\n')

// --- run pipeline ---

const result = await runPort({
	reader: createLocalReader(sourceChange),
	writer: createDryRunWriter(),
	agentProvider: new ClaudeAgentProvider({ apiKey }),
	sourceRepo: { owner: 'example', name: 'source-repo', defaultBranch: 'main' },
	commitSha: sourceChange.mergedCommitSha,
	targetWorkingDirectory: targetDir,
	sourceWorkingDirectory: sourceDir,
	diffFilePath,
	portBotJson: { target: 'example/target-repo', validation: ['true'] },
	logger: createConsoleLogger('debug'),
	stageOverrides: {
		decide: () => ({
			kind: 'PORT_REQUIRED',
			reason: 'Forced PORT_REQUIRED for local example.',
		}),
		deliverResult: options =>
			deliverResult({
				...options,
				runCommand: async ({ command, workingDirectory }) => {
					if (command[0] === 'git' && command[1] === 'push') {
						console.log(`--- [dry-run] Skipping: ${command.join(' ')}`)

						return { exitCode: 0, stdout: '', stderr: '' }
					}

					const proc = Bun.spawnSync(command, { cwd: workingDirectory })

					return {
						exitCode: proc.exitCode,
						stdout: proc.stdout.toString(),
						stderr: proc.stderr.toString(),
					}
				},
			}),
	},
})

// --- output ---

console.log('\n========================================')
console.log('  Result')
console.log('========================================')
console.log(JSON.stringify(result, null, 2))

console.log('\n========================================')
console.log('  Git diff in target')
console.log('========================================')

const diff = Bun.spawnSync(['git', 'diff'], { cwd: targetDir })

console.log(diff.stdout.toString() || '(no changes)')

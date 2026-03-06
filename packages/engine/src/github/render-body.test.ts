import { describe, expect, test } from 'bun:test'

import {
	renderNeedsHumanIssueBody,
	renderNeedsHumanIssueTitle,
	renderPortPullRequestBody,
	renderPortPullRequestTitle,
	renderSourceComment,
} from './render-body.ts'

import type { ExecutionResult, PortContext, PortDecision, RepoRef } from '../types.ts'

const SOURCE_REPO: RepoRef = {
	owner: 'acme',
	name: 'source-repo',
	defaultBranch: 'main',
}

const TARGET_REPO: RepoRef = {
	owner: 'acme',
	name: 'target-repo',
	defaultBranch: 'main',
}

/**
 * Build a synthetic context for render tests.
 *
 * @returns Port context fixture.
 */
function makeContext(): PortContext {
	return {
		runId: 'run-1',
		startedAt: '2026-03-03T00:00:00.000Z',
		sourceRepo: SOURCE_REPO,
		sourceChange: {
			mergedCommitSha: 'abc123456789',
			pullRequest: {
				number: 42,
				title: 'Add execution orchestration',
				body: 'Body',
				url: 'https://github.com/acme/source-repo/pull/42',
				labels: ['sdk'],
			},
			files: [{ path: 'src/app.ts', status: 'modified', additions: 5, deletions: 2 }],
		},
		pluginConfig: {
			targetRepo: TARGET_REPO,
			ignorePatterns: [],
			validationCommands: ['bun run check'],
			pathMappings: {},
		},
	}
}

/**
 * Build test context with validation commands disabled.
 *
 * @returns Port context fixture with empty validation command list.
 */
function makeContextWithoutValidationCommands(): PortContext {
	const context = makeContext()

	context.pluginConfig.validationCommands = []

	return context
}

/**
 * Build a decision fixture for render tests.
 *
 * @param kind - Decision kind.
 * @returns Decision fixture.
 */
function makeDecision(kind: PortDecision['kind']): PortDecision {
	return {
		kind,
		reason: 'Decision reason',
	}
}

/**
 * Build execution fixture for success/failure render paths.
 *
 * @param success - Whether execution succeeded.
 * @returns Execution fixture.
 */
function makeExecution(success: boolean): ExecutionResult {
	return {
		success,
		attempts: success ? 1 : 2,
		history: [
			{
				attempt: success ? 1 : 2,
				touchedFiles: ['src/app.ts'],
				validation: [
					{
						command: 'bun run check',
						ok: success,
						exitCode: success ? 0 : 1,
						stdout: success ? 'ok' : '',
						stderr: success ? '' : 'failed',
						durationMs: 123,
					},
				],
				notes: success ? 'Looks good.' : 'Still failing checks.',
				toolCallLog: [],
				events: [
					{
						kind: 'assistant_note',
						text: 'Starting out the port...',
					},
					{
						kind: 'tool_start',
						toolName: 'Read',
						toolUseId: 'read-1',
						toolInput: { file_path: 'src/app.ts' },
					},
					{
						kind: 'tool_end',
						toolName: 'Read',
						toolUseId: 'read-1',
						durationMs: 42,
					},
					{
						kind: 'tool_start',
						toolName: 'Edit',
						toolUseId: 'edit-1',
						toolInput: { file_path: 'src/app.ts' },
					},
					{
						kind: 'tool_end',
						toolName: 'Edit',
						toolUseId: 'edit-1',
						durationMs: 55,
					},
					{
						kind: 'tool_start',
						toolName: 'Bash',
						toolUseId: 'bash-1',
						toolInput: { command: 'bun run check' },
					},
					{
						kind: 'tool_end',
						toolName: 'Bash',
						toolUseId: 'bash-1',
						durationMs: 18_601,
					},
				],
			},
		],
		touchedFiles: ['src/app.ts'],
		failureReason: success ? undefined : 'Validation failed after retries.',
	}
}

describe('render-body', () => {
	test('renders canonical pull request title', () => {
		const title = renderPortPullRequestTitle(makeContext())

		expect(title).toBe('Port: Add execution orchestration')
	})

	test('renders compact PR body with cross-repo heading, blockquote reason, and collapsible diagnostics', () => {
		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			execution: makeExecution(true),
		})

		expect(body).toContain('## Cross-repo port')
		expect(body).toContain(
			'Ported from [Add execution orchestration](https://github.com/acme/source-repo/pull/42) in [`acme/source-repo`](https://github.com/acme/source-repo).',
		)
		expect(body).toContain('> Decision reason')
		expect(body).toContain('### What was ported')
		expect(body).toContain('Looks good.')
		expect(body).toContain('<details><summary>Agent Work Log</summary>')
		expect(body).toContain('Starting out the port...')
		expect(body).toContain('Read `src/app.ts`')
		expect(body).toContain('Edited `src/app.ts`')
		expect(body).toContain('Ran `bun run check` (18.6s)')
		expect(body).toContain('<details><summary>Validation & diagnostics</summary>')
		expect(body).toContain('[PASS] `bun run check`')
		expect(body).toContain('1 file changed · 1 attempt · 0 tool calls')
		expect(body).not.toContain('Final status')
		expect(body).not.toContain('### Attempt 1')
		expect(body).toContain(
			'Ported by: [Repo Port Bot](https://github.com/superbuilders/repo-port-bot)',
		)
	})

	test('renders draft/stalled PR with details open and failure info', () => {
		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			execution: makeExecution(false),
		})

		expect(body).toContain('<details open><summary>Validation & diagnostics</summary>')
		expect(body).toContain('[FAIL] `bun run check`')
		expect(body).toContain('Final status: validation failed after retries.')
		expect(body).toContain('Failure reason: Validation failed after retries.')
	})

	test('omits diagnostics block when no validation commands configured', () => {
		const body = renderPortPullRequestBody({
			context: makeContextWithoutValidationCommands(),
			decision: makeDecision('PORT_REQUIRED'),
			execution: makeExecution(true),
		})

		expect(body).not.toContain('Validation')
		expect(body).not.toContain('Validation & diagnostics')
	})

	test('renders per-attempt sections in Agent Work Log on retries', () => {
		const execution = makeExecution(false)

		execution.history = [
			{
				...execution.history[0]!,
				attempt: 1,
				notes: 'First attempt notes.',
				events: [
					{
						kind: 'assistant_note',
						text: 'First attempt.',
					},
				],
			},
			{
				...execution.history[0]!,
				attempt: 2,
				notes: 'Final attempt summary.',
				events: [
					{
						kind: 'assistant_note',
						text: 'Second attempt.',
					},
				],
			},
		]

		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			execution,
		})

		expect(body).toContain('### Attempt 1')
		expect(body).toContain('First attempt.')
		expect(body).toContain('### Attempt 2')
		expect(body).toContain('Second attempt.')

		const whatWasPortedIndex = body.indexOf('### What was ported')
		const workLogIndex = body.indexOf('Agent Work Log')
		const sectionBetween = body.slice(whatWasPortedIndex, workLogIndex)

		expect(sectionBetween).toContain('Final attempt summary.')
		expect(sectionBetween).not.toContain('### Attempt')
	})

	test('renders needs-human issue title and body with rationale and signals', () => {
		const context = makeContext()
		const decision = makeDecision('NEEDS_HUMAN')
		const title = renderNeedsHumanIssueTitle(context)
		const body = renderNeedsHumanIssueBody({ context, decision })

		expect(title).toBe('Needs review: Add execution orchestration')
		expect(body).toContain(
			'[Add execution orchestration](https://github.com/acme/source-repo/pull/42) was merged in `acme/source-repo`',
		)
		expect(body).toContain('**Why:** Decision reason')
		expect(body).toContain('**Changed files:** 1')
	})

	test('renders source comment for skipped outcome as narrative with reason', () => {
		const body = renderSourceComment({
			context: makeContext(),
			decision: makeDecision('PORT_NOT_REQUIRED'),
			outcome: 'skipped_not_required',
			runId: 'run-0',
		})

		expect(body).toContain('skipped this for `acme/target-repo`')
		expect(body).toContain('**Why:** Decision reason')
	})

	test('renders source comment for pr_opened as narrative with target link', () => {
		const body = renderSourceComment({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			outcome: 'pr_opened',
			targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/901',
			runId: 'run-1',
		})

		expect(body).toContain(
			'Ported to https://github.com/acme/target-repo/pull/901 (1 file, validation passed)',
		)
		expect(body).toContain('**Why:** Decision reason')
	})

	test('renders source comment for draft_pr_opened and needs_human as narratives', () => {
		const draftBody = renderSourceComment({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			outcome: 'draft_pr_opened',
			targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/333',
			runId: 'run-2',
		})
		const needsHumanBody = renderSourceComment({
			context: makeContext(),
			decision: makeDecision('NEEDS_HUMAN'),
			outcome: 'needs_human',
			followUpIssueUrl: 'https://github.com/acme/target-repo/issues/55',
			runId: 'run-3',
		})

		expect(draftBody).toContain('validation failed after retries')
		expect(draftBody).toContain('draft PR: https://github.com/acme/target-repo/pull/333')
		expect(draftBody).toContain('**Why:** Decision reason')
		expect(needsHumanBody).toContain('issue: https://github.com/acme/target-repo/issues/55')
		expect(needsHumanBody).toContain('manual review')
		expect(needsHumanBody).toContain('**Why:** Decision reason')
	})

	test('renders source comment for failed outcome with run ID', () => {
		const body = renderSourceComment({
			context: makeContext(),
			decision: makeDecision('NEEDS_HUMAN'),
			outcome: 'failed',
			runId: 'run-4',
		})

		expect(body).toContain('failed due to an engine error')
		expect(body).toContain('**Why:** Decision reason')
		expect(body).toContain('Run ID: `run-4`')
	})

	test('renders source comment supersede line when prior failed comment exists', () => {
		const body = renderSourceComment({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			outcome: 'pr_opened',
			targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/901',
			runId: 'run-5',
			supersededFailureCommentUrl:
				'https://github.com/acme/source-repo/pull/42#issuecomment-0',
			supersededFailureRunId: 'run-0',
		})

		expect(body).toContain(
			'Supersedes prior failed attempt: https://github.com/acme/source-repo/pull/42#issuecomment-0 (run `run-0`).',
		)
	})
})

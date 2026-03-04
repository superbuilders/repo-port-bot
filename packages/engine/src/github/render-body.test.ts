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
			},
		],
		touchedFiles: ['src/app.ts'],
		failureReason: success ? undefined : 'Validation failed after retries.',
	}
}

describe('render-body', () => {
	test('renders canonical pull request title', () => {
		const title = renderPortPullRequestTitle(makeContext())

		expect(title).toBe('Port: Add execution orchestration (#42)')
	})

	test('renders PR body with source link, validation summary, files, and footer', () => {
		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			execution: makeExecution(true),
		})

		expect(body).toContain('[#42](https://github.com/acme/source-repo/pull/42)')
		expect(body).toContain('## Files touched')
		expect(body).toContain('`src/app.ts`')
		expect(body).toContain('## Validation')
		expect(body).toContain('[PASS] `bun run check`')
		expect(body).toContain('Ported-By: repo-port-bot')
	})

	test('renders draft/stalled PR details for failed execution', () => {
		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			execution: makeExecution(false),
		})

		expect(body).toContain('[FAIL] `bun run check`')
		expect(body).toContain('Final status: validation failed after retries.')
		expect(body).toContain('Failure reason: Validation failed after retries.')
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
			'Ported to https://github.com/acme/target-repo/pull/901. Validation passed',
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
})

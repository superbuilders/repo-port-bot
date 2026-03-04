import { describe, expect, test } from 'bun:test'

import {
	renderNeedsHumanIssueBody,
	renderNeedsHumanIssueTitle,
	renderPortPullRequestBody,
	renderPortPullRequestTitle,
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
		signals: ['signal-a'],
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

		expect(title).toBe('Port needs human review: Add execution orchestration (#42)')
		expect(body).toContain('## Source')
		expect(body).toContain('Decision reason')
		expect(body).toContain('`signal-a`')
		expect(body).toContain('`src/app.ts`')
	})
})

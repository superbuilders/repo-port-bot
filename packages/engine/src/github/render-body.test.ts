import { describe, expect, test } from 'bun:test'

import {
	renderNeedsHumanIssueBody,
	renderNeedsHumanIssueTitle,
	renderPortPullRequestBody,
	renderPortPullRequestTitle,
	renderSourceComment,
} from './render-body.ts'

import type {
	DecisionTrace,
	ExecutePortResult,
	PortContext,
	PortDecision,
	RepoRef,
} from '../types.ts'

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
 * Build a heuristic decision trace fixture.
 *
 * @returns Decision trace fixture with no classifier events.
 */
function makeHeuristicTrace(): DecisionTrace {
	return {
		source: 'heuristic',
		heuristicName: 'checkDocsOnly',
		toolCallLog: [],
		events: [],
	}
}

/**
 * Build a classifier decision trace fixture with events.
 *
 * @returns Decision trace fixture with classifier events and model.
 */
function makeClassifierTrace(): DecisionTrace {
	return {
		source: 'classifier',
		model: 'claude-sonnet-4-6',
		durationMs: 1800,
		toolCallLog: [
			{ toolName: 'Read', input: { file_path: 'src/app.ts' }, output: { ok: true } },
		],
		events: [
			{
				kind: 'assistant_note',
				text: 'Checking for equivalent target files.',
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
				kind: 'assistant_note',
				text: 'Target file exists. Port required.',
			},
		],
	}
}

/**
 * Build execution fixture for success/failure render paths.
 *
 * @param success - Whether execution succeeded.
 * @returns Execution fixture.
 */
function makeExecution(success: boolean): ExecutePortResult {
	return {
		outcome: {
			status: success ? 'SUCCEEDED' : 'VALIDATION_FAILED',
			attempts: success ? 1 : 2,
			touchedFiles: ['src/app.ts'],
			reason: success ? undefined : 'Validation failed after retries.',
		},
		trace: {
			notes: success ? 'Looks good.' : 'Still failing checks.',
			toolCallLog: [],
			events: [],
			attempts: [
				{
					attempt: success ? 1 : 2,
					status: success ? 'VALIDATED' : 'VALIDATION_FAILED',
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
					trace: {
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
							{
								kind: 'assistant_note',
								text: success ? 'Looks good.' : 'Still failing checks.',
							},
						],
					},
				},
			],
		},
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
			decisionTrace: makeHeuristicTrace(),
			execution: makeExecution(true),
		})

		expect(body).toContain('## Cross-repo port')
		expect(body).toContain('> Decision reason')
		expect(body).toContain(
			'Ported from [Add execution orchestration](https://github.com/acme/source-repo/pull/42) in [`acme/source-repo`](https://github.com/acme/source-repo).',
		)
		expect(body).toContain('## What was ported')

		const blockquoteIndex = body.indexOf('> Decision reason')
		const sourceIndex = body.indexOf('Ported from')

		expect(blockquoteIndex).toBeLessThan(sourceIndex)
		expect(body).toContain('Looks good.')
		expect(body).toContain('<details><summary>Agent Work Log</summary>')
		expect(body).toContain('_Starting out the port..._')
		expect(body).toContain('Read `src/app.ts`')
		expect(body).toContain('Edited `src/app.ts`')
		expect(body).toContain('Ran `bun run check` (18.6s)')
		expect(body).toContain('```\nRead')

		const workLogSection = body.slice(
			body.indexOf('Agent Work Log'),
			body.indexOf('</details>'),
		)

		expect(workLogSection).not.toContain('Looks good.')
		expect(body).toContain('<details><summary>Validation & diagnostics</summary>')
		expect(body).toContain('[PASS] `bun run check`')
		expect(body).toContain('1 file changed · 1 attempt · 0 tool calls')
		expect(body).not.toContain('Final status')
		expect(body).not.toContain('### Attempt 1')
		expect(body).toContain(
			'Ported by: [Repo Port Bot](https://github.com/superbuilders/repo-port-bot)',
		)
	})

	test('renders Decision Log for classifier decisions', () => {
		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			decisionTrace: makeClassifierTrace(),
			execution: makeExecution(true),
		})

		expect(body).toContain('<details><summary>Decision Log</summary>')
		expect(body).toContain('_Checking for equivalent target files._')
		expect(body).toContain('Read `src/app.ts`')
		expect(body).toContain('_Target file exists. Port required._')
		expect(body).toContain('Classified by')
		expect(body).toContain('claude-sonnet-4-6')
		expect(body).toContain('1 tool call')
		expect(body).toContain('1.8s')

		const decisionLogIndex = body.indexOf('Decision Log')
		const sourceNarrativeIndex = body.indexOf('Ported from')
		const whatWasPortedIndex = body.indexOf('## What was ported')

		expect(decisionLogIndex).toBeLessThan(sourceNarrativeIndex)
		expect(sourceNarrativeIndex).toBeLessThan(whatWasPortedIndex)
	})

	test('omits Decision Log for heuristic decisions', () => {
		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			decisionTrace: makeHeuristicTrace(),
			execution: makeExecution(true),
		})

		expect(body).not.toContain('Decision Log')
		expect(body).not.toContain('Classified by')
	})

	test('renders draft/stalled PR with details open and failure info', () => {
		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			decisionTrace: makeHeuristicTrace(),
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
			decisionTrace: makeHeuristicTrace(),
			execution: makeExecution(true),
		})

		expect(body).not.toContain('Validation')
		expect(body).not.toContain('Validation & diagnostics')
	})

	test('renders per-attempt sections in Agent Work Log on retries', () => {
		const execution = makeExecution(false)

		execution.trace.attempts = [
			{
				...execution.trace.attempts[0]!,
				attempt: 1,
				trace: {
					...execution.trace.attempts[0]!.trace,
					notes: 'First attempt notes.',
					events: [
						{
							kind: 'assistant_note',
							text: 'First attempt.',
						},
					],
				},
			},
			{
				...execution.trace.attempts[0]!,
				attempt: 2,
				trace: {
					...execution.trace.attempts[0]!.trace,
					notes: 'Final attempt summary.',
					events: [
						{
							kind: 'assistant_note',
							text: 'Retrying the port...',
						},
						{
							kind: 'tool_start',
							toolName: 'Edit',
							toolUseId: 'edit-2',
							toolInput: { file_path: 'src/app.ts' },
						},
						{
							kind: 'tool_end',
							toolName: 'Edit',
							toolUseId: 'edit-2',
							durationMs: 10,
						},
						{
							kind: 'assistant_note',
							text: 'Final attempt summary.',
						},
					],
				},
			},
		]

		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			decisionTrace: makeHeuristicTrace(),
			execution,
		})

		expect(body).toContain('### Attempt 1')
		expect(body).toContain('First attempt.')
		expect(body).toContain('### Attempt 2')
		expect(body).toContain('Retrying the port...')

		const workLogSection = body.slice(
			body.indexOf('Agent Work Log'),
			body.indexOf('</details>'),
		)

		expect(workLogSection).not.toContain('Final attempt summary.')

		const whatWasPortedIndex = body.indexOf('## What was ported')
		const workLogIndex = body.indexOf('Agent Work Log')
		const sectionBetween = body.slice(whatWasPortedIndex, workLogIndex)

		expect(sectionBetween).toContain('Final attempt summary.')
		expect(sectionBetween).not.toContain('### Attempt')
	})

	test('renders needs-human issue title and body with rationale and signals', () => {
		const context = makeContext()
		const decision = makeDecision('NEEDS_HUMAN')
		const title = renderNeedsHumanIssueTitle(context)
		const body = renderNeedsHumanIssueBody({
			context,
			decision,
			decisionTrace: makeHeuristicTrace(),
		})

		expect(title).toBe('Needs review: Add execution orchestration')
		expect(body).toContain(
			'[Add execution orchestration](https://github.com/acme/source-repo/pull/42) was merged in `acme/source-repo`',
		)
		expect(body).toContain('**Why:** Decision reason')
		expect(body).toContain('**Changed files:** 1')
	})

	test('renders Decision Log in needs-human issue for classifier decisions', () => {
		const context = makeContext()
		const decision = makeDecision('NEEDS_HUMAN')
		const body = renderNeedsHumanIssueBody({
			context,
			decision,
			decisionTrace: makeClassifierTrace(),
		})

		expect(body).toContain('<details><summary>Decision Log</summary>')
		expect(body).toContain('Classified by')
		expect(body).toContain('claude-sonnet-4-6')
		expect(body).toContain('**Changed files:** 1')
	})

	test('renders source comment for skipped outcome with note admonition', () => {
		const body = renderSourceComment({
			context: makeContext(),
			decision: makeDecision('PORT_NOT_REQUIRED'),
			outcome: 'skipped_not_required',
			runId: 'run-0',
		})

		expect(body).toContain('[!NOTE]')
		expect(body).toContain('skipped this for `acme/target-repo`')
		expect(body).toContain('<details><summary>Why</summary>')
		expect(body).toContain('Decision reason')
	})

	test('renders source comment for pr_opened with tip admonition', () => {
		const body = renderSourceComment({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			outcome: 'pr_opened',
			targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/901',
			runId: 'run-1',
		})

		expect(body).toContain('[!TIP]')
		expect(body).toContain(
			'Ported to https://github.com/acme/target-repo/pull/901 (1 file, validation passed)',
		)
		expect(body).toContain('<details><summary>Why</summary>')
	})

	test('renders source comment for draft_pr_opened and needs_human with warning admonition', () => {
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

		expect(draftBody).toContain('[!WARNING]')
		expect(draftBody).toContain('validation failed after retries')
		expect(draftBody).toContain('draft PR: https://github.com/acme/target-repo/pull/333')
		expect(needsHumanBody).toContain('[!WARNING]')
		expect(needsHumanBody).toContain('issue: https://github.com/acme/target-repo/issues/55')
		expect(needsHumanBody).toContain('manual review')
	})

	test('renders source comment for failed outcome with caution admonition', () => {
		const body = renderSourceComment({
			context: makeContext(),
			decision: makeDecision('NEEDS_HUMAN'),
			outcome: 'failed',
			runId: 'run-4',
		})

		expect(body).toContain('[!CAUTION]')
		expect(body).toContain('failed due to an engine error')
		expect(body).toContain('Run ID: `run-4`')
	})

	test('renders source comment supersede as note admonition with link', () => {
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
			'Supersedes [prior attempt](https://github.com/acme/source-repo/pull/42#issuecomment-0) (run `run-0`).',
		)
		expect(body).toContain('[!NOTE]')
		expect(body).toContain('[!TIP]')
	})
})

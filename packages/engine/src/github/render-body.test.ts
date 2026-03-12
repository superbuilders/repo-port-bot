import { describe, expect, test } from 'bun:test'

import {
	renderNeedsHumanIssueBody,
	renderNeedsHumanIssueTitle,
	renderPortPullRequestBody,
	renderPortPullRequestTitle,
	renderSourceComment,
} from './render-body.ts'

import type { ExecutePortResult, PortContext, PortDecision, RepoRef } from '../types.ts'

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

const DECISION_COST_USD = 0.12

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
				author: 'jdoe',
			},
			files: [{ path: 'src/app.ts', status: 'modified', additions: 5, deletions: 2 }],
		},
		pluginConfig: {
			targetRepo: TARGET_REPO,
			ignorePatterns: [],
			validationCommands: ['bun run check'],
			deterministicOperations: [],
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
 * Build deterministic phase fixture for rendering scenarios.
 *
 * @returns Deterministic phase fixture.
 */
function makeDeterministicPhase() {
	return {
		changed: true,
		operations: [
			{
				kind: 'sync' as const,
				mode: 'mirror' as const,
				source: 'tests/fixtures/**',
				target: 'tests/fixtures/',
			},
			{
				kind: 'sync' as const,
				mode: 'copy' as const,
				source: 'tests/manifest.json',
				target: 'tests/manifest.json',
			},
		],
		touchedFiles: ['tests/fixtures/a.json', 'tests/manifest.json'],
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
 * Build a decision trace fixture with optional telemetry overrides.
 *
 * @param costUsd - Optional decision stage cost.
 * @param usage - Optional decision stage usage.
 * @param usage.inputTokens - Input token count.
 * @param usage.outputTokens - Output token count.
 * @param usage.cacheCreationInputTokens - Cache write token count.
 * @param usage.cacheReadInputTokens - Cache read token count.
 * @returns Decision trace fixture.
 */
function makeDecisionTrace(
	costUsd = DECISION_COST_USD,
	usage: {
		inputTokens: number
		outputTokens: number
		cacheCreationInputTokens: number
		cacheReadInputTokens: number
	} = {
		inputTokens: 1000,
		outputTokens: 200,
		cacheCreationInputTokens: 100,
		cacheReadInputTokens: 1200,
	},
) {
	return {
		source: 'classifier' as const,
		toolCallLog: [],
		events: [],
		costUsd,
		usage,
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
							{
								kind: 'tool_start',
								toolName: 'StructuredOutput',
								toolUseId: 'structured-output-1',
							},
							{
								kind: 'tool_end',
								toolName: 'StructuredOutput',
								toolUseId: 'structured-output-1',
								durationMs: 8,
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

	test('renders compact PR body with quoted rationale and expanded provenance sentence', () => {
		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			execution: makeExecution(true),
			framingMode: 'agent_success',
		})

		expect(body).toContain('## Port rationale')
		expect(body).toContain('> Decision reason')
		expect(body).toContain(
			'Ported from [Add execution orchestration](https://github.com/acme/source-repo/pull/42) (originally authored by @jdoe) in [`acme/source-repo`](https://github.com/acme/source-repo). This port updated 1 file',
		)
		expect(body).toContain('## What was ported')

		const reasonIndex = body.indexOf('> Decision reason')
		const sourceIndex = body.indexOf('Ported from')
		const whatWasPortedIndex = body.indexOf('## What was ported')

		expect(reasonIndex).toBeLessThan(sourceIndex)
		expect(sourceIndex).toBeLessThan(whatWasPortedIndex)
		expect(body).toContain('Looks good.')
		expect(body).not.toContain('> Looks good.')
		expect(body).toContain('<details><summary>Work Log</summary>')
		expect(body).toContain('_Starting out the port..._')
		expect(body).toContain('Read `src/app.ts`')
		expect(body).toContain('Edited `src/app.ts`')
		expect(body).toContain('Ran `bun run check` (18.6s)')
		expect(body).not.toContain('StructuredOutput')
		expect(body).toContain('```\nRead')

		const workLogSection = body.slice(body.indexOf('Work Log'), body.indexOf('</details>'))

		expect(workLogSection).not.toContain('Looks good.')
		expect(body).toContain('<details><summary>Validation & diagnostics</summary>')
		expect(body).toContain('[PASS] `bun run check`')
		expect(body).toContain(
			'This port updated 1 file and was completed in a single attempt, using 0 tool calls.',
		)
		expect(body).not.toContain('Final status')
		expect(body).not.toContain('### Attempt 1')
		expect(body).toContain(
			'Ported by: [Repo Port Bot](https://github.com/superbuilders/repo-port-bot)',
		)
	})

	test('renders deterministic-only framing without execution', () => {
		const context = makeContext()

		context.deterministic = makeDeterministicPhase()

		const body = renderPortPullRequestBody({
			context,
			decision: makeDecision('PORT_NOT_REQUIRED'),
			framingMode: 'deterministic_only',
		})

		expect(body).toContain('_This port was completed through deterministic operations only._')
		expect(body).toContain('## What changed')
		expect(body).toContain('Mirrored:')
		expect(body).toContain('- `tests/fixtures/**` -> `tests/fixtures/`')
		expect(body).toContain('Copied:')
		expect(body).toContain('- `tests/manifest.json` -> `tests/manifest.json`')
		expect(body).toContain('<details><summary>Work Log</summary>')
		expect(body).not.toContain('## What was ported')
	})

	test('renders residual-handoff framing without execution', () => {
		const context = makeContext()

		context.deterministic = makeDeterministicPhase()

		const body = renderPortPullRequestBody({
			context,
			decision: makeDecision('NEEDS_HUMAN'),
			framingMode: 'residual_handoff',
			validation: [
				{
					command: 'bun run check',
					ok: true,
					exitCode: 0,
					stdout: 'ok',
					stderr: '',
					durationMs: 20,
				},
			],
		})

		expect(body).toContain('## What is already done')
		expect(body).toContain('## What still needs human review')
		expect(body).toContain('residual behavior')
		expect(body).toContain('Validation & diagnostics')
	})

	test('omits author mention when author is absent', () => {
		const context = makeContext()

		context.sourceChange.pullRequest = {
			...context.sourceChange.pullRequest!,
			author: undefined,
		}

		const body = renderPortPullRequestBody({
			context,
			decision: makeDecision('PORT_REQUIRED'),
			execution: makeExecution(true),
			framingMode: 'agent_success',
		})

		expect(body).toContain(
			'Ported from [Add execution orchestration](https://github.com/acme/source-repo/pull/42) in [`acme/source-repo`]',
		)
		expect(body).not.toContain('(originally authored by @')
	})

	test('renders cost telemetry details in target PR body when enabled', () => {
		const execution = makeExecution(true)

		execution.outcome.attempts = 2
		execution.trace.attempts = [
			{
				...execution.trace.attempts[0]!,
				attempt: 1,
				trace: {
					...execution.trace.attempts[0]!.trace,
					costUsd: 1,
					usage: {
						inputTokens: 2000,
						outputTokens: 500,
						cacheCreationInputTokens: 200,
						cacheReadInputTokens: 1000,
					},
				},
			},
			{
				...execution.trace.attempts[0]!,
				attempt: 2,
				trace: {
					...execution.trace.attempts[0]!.trace,
					costUsd: 0.5,
					usage: {
						inputTokens: 1000,
						outputTokens: 200,
						cacheCreationInputTokens: 100,
						cacheReadInputTokens: 300,
					},
				},
			},
		]

		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			decisionTrace: makeDecisionTrace(),
			execution,
			framingMode: 'agent_success',
			includeCostTelemetry: true,
		})

		expect(body).toContain('<details><summary>Cost & Tokens</summary>')
		expect(body).toContain('- Decision: $0.12, 1.2K input/output tokens')
		expect(body).toContain('- Execution: $1.50, 3.7K input/output tokens across 2 attempts')
		expect(body).toContain('- Total: $1.62, 4.9K input/output tokens')
	})

	test('omits cost telemetry details in target PR body when disabled', () => {
		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			decisionTrace: makeDecisionTrace(),
			execution: makeExecution(true),
			framingMode: 'agent_success',
			includeCostTelemetry: false,
		})

		expect(body).not.toContain('Cost & Tokens')
	})

	test('omits author mention in needs-human issue when author is absent', () => {
		const context = makeContext()

		context.sourceChange.pullRequest = {
			...context.sourceChange.pullRequest!,
			author: undefined,
		}

		const body = renderNeedsHumanIssueBody({
			context,
			decision: makeDecision('NEEDS_HUMAN'),
		})

		expect(body).toContain(
			'[Add execution orchestration](https://github.com/acme/source-repo/pull/42) was merged in `acme/source-repo`',
		)
		expect(body).not.toContain('(originally authored by @')
	})

	test('renders draft/stalled PR with details open and failure info', () => {
		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			execution: makeExecution(false),
			framingMode: 'agent_stalled',
		})

		expect(body).toContain('<details open><summary>Validation & diagnostics</summary>')
		expect(body).toContain('[FAIL] `bun run check`')
		expect(body).toContain('Final status: validation failed after retries.')
		expect(body).toContain('Failure reason: Validation failed after retries.')
	})

	test('renders structured summary overview and per-file bullets when available', () => {
		const execution = makeExecution(true)

		execution.summary = {
			text: 'Ported scheduling behavior and synced related tests.',
			files: [
				{
					path: 'src/app.ts',
					description: 'Updated scheduling logic to mirror source changes.',
				},
				{
					path: 'src/app.test.ts',
					description: 'Adjusted assertions for new scheduling behavior.',
				},
			],
		}

		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			execution,
			framingMode: 'agent_success',
		})

		expect(body).toContain('Ported scheduling behavior and synced related tests.')
		expect(body).toContain('- `src/app.ts`: Updated scheduling logic to mirror source changes.')
		expect(body).toContain(
			'- `src/app.test.ts`: Adjusted assertions for new scheduling behavior.',
		)
		expect(body).not.toContain('_No notes recorded._')
	})

	test('falls back to last attempt notes when structured summary is unavailable', () => {
		const execution = makeExecution(true)

		execution.summary = undefined
		execution.trace.attempts[0]!.trace.notes = 'Fallback attempt summary from notes.'

		const body = renderPortPullRequestBody({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			execution,
			framingMode: 'agent_success',
		})

		expect(body).toContain('Fallback attempt summary from notes.')
	})

	test('omits diagnostics block when no validation commands configured', () => {
		const body = renderPortPullRequestBody({
			context: makeContextWithoutValidationCommands(),
			decision: makeDecision('PORT_REQUIRED'),
			execution: makeExecution(true),
			framingMode: 'agent_success',
		})

		expect(body).not.toContain('Validation')
		expect(body).not.toContain('Validation & diagnostics')
	})

	test('renders per-attempt sections in Work Log on retries', () => {
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
			execution,
			framingMode: 'agent_stalled',
		})

		expect(body).toContain('### Attempt 1')
		expect(body).toContain('First attempt.')
		expect(body).toContain('### Attempt 2')
		expect(body).toContain('Retrying the port...')

		const workLogSection = body.slice(body.indexOf('Work Log'), body.indexOf('</details>'))

		expect(workLogSection).not.toContain('Final attempt summary.')

		const whatWasPortedIndex = body.indexOf('## What was ported')
		const workLogIndex = body.indexOf('Work Log')
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
		})

		expect(title).toBe('Needs review: Add execution orchestration')
		expect(body).toContain(
			'[Add execution orchestration](https://github.com/acme/source-repo/pull/42) (originally authored by @jdoe) was merged in `acme/source-repo`',
		)
		expect(body).toContain('**Why:** Decision reason')
		expect(body).toContain('**Changed files:** 1')
		expect(body).toContain('Source-PR: https://github.com/acme/source-repo/pull/42')
		expect(body).toContain('Source-Commit: abc123456789')
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
		expect(body).toContain('> <details><summary>Why was this skipped?</summary>')
		expect(body).toContain('> Decision reason')
	})

	test('renders source comment for pr_opened without admonition', () => {
		const body = renderSourceComment({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			outcome: 'pr_opened',
			targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/901',
			runId: 'run-1',
		})

		expect(body).not.toContain('[!TIP]')
		expect(body).toContain(
			'Ported to https://github.com/acme/target-repo/pull/901 (1 file, validation passed)',
		)
		expect(body).toContain('<details><summary>Why was this ported?</summary>')
		expect(body).toContain('Decision reason')
	})

	test('renders source comment telemetry for decision-only outcomes', () => {
		const body = renderSourceComment({
			context: makeContext(),
			decision: makeDecision('PORT_NOT_REQUIRED'),
			decisionTrace: makeDecisionTrace(),
			outcome: 'skipped_not_required',
			includeCostTelemetry: true,
			runId: 'run-telemetry-1',
		})

		expect(body).toContain('<details><summary>Cost & Tokens</summary>')
		expect(body).toContain('- Decision: $0.12, 1.2K input/output tokens')
		expect(body).not.toContain('- Execution:')
		expect(body).not.toContain('- Total:')
	})

	test('omits source comment telemetry when disabled', () => {
		const body = renderSourceComment({
			context: makeContext(),
			decision: makeDecision('PORT_REQUIRED'),
			decisionTrace: makeDecisionTrace(),
			execution: makeExecution(true),
			outcome: 'pr_opened',
			includeCostTelemetry: false,
			targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/901',
			runId: 'run-telemetry-2',
		})

		expect(body).not.toContain('Cost & Tokens')
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
		expect(draftBody).toContain('> <details><summary>Why was this ported?</summary>')
		expect(needsHumanBody).toContain('[!WARNING]')
		expect(needsHumanBody).toContain('issue: https://github.com/acme/target-repo/issues/55')
		expect(needsHumanBody).toContain('manual review')
		expect(needsHumanBody).toContain('> <details><summary>Why does this need review?</summary>')
	})

	test('renders source comment residual handoff when decision is NEEDS_HUMAN but PR opens', () => {
		const body = renderSourceComment({
			context: makeContext(),
			decision: makeDecision('NEEDS_HUMAN'),
			outcome: 'pr_opened',
			targetPullRequestUrl: 'https://github.com/acme/target-repo/pull/444',
			runId: 'run-residual-1',
		})

		expect(body).toContain('[!WARNING]')
		expect(body).toContain('residual work still needs human review')
		expect(body).toContain('https://github.com/acme/target-repo/pull/444')
		expect(body).toContain('What still needs review?')
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
		expect(body).toContain('> <details><summary>What went wrong?</summary>')
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
		expect(body).not.toContain('[!TIP]')
		expect(body).toContain(
			'Ported to https://github.com/acme/target-repo/pull/901 (1 file, validation passed).',
		)
	})
})

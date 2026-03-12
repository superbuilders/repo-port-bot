/**
 * Scenario tests for NEEDS_HUMAN paths.
 *
 * State table rows:
 *   - NEEDS_HUMAN + no deterministic changes → issue
 *   - NEEDS_HUMAN + deterministic changes + pass → ready PR with [needs review]
 *   - NEEDS_HUMAN + deterministic changes + fail → draft PR
 */
import { describe, expect, test } from 'bun:test'

import {
	cleanupTempDirs,
	createRepos,
	createTrackingWriter,
	makeSourceChange,
	runScenario,
} from '../harness/index.ts'

import type { DecidePortResult } from '../../packages/engine/src/index.ts'

cleanupTempDirs()

/**
 * @returns NEEDS_HUMAN decision fixture.
 */
function makeNeedsHumanDecision(): DecidePortResult {
	return {
		outcome: { kind: 'NEEDS_HUMAN', reason: 'Complex refactoring detected.' },
		trace: {
			source: 'heuristic',
			notes: 'Complex refactoring detected.',
			toolCallLog: [],
			events: [],
		},
	}
}

describe('needs-human scenarios', () => {
	test('NEEDS_HUMAN with no deterministic changes creates an issue', async () => {
		const repos = await createRepos()
		const { writer, state } = createTrackingWriter()

		const result = await runScenario({
			sourceChange: makeSourceChange(),
			repos,
			writer,
			portBotJson: { target: 'acme/target-repo' },
			agentProvider: {
				async decidePort() {
					return makeNeedsHumanDecision()
				},
				async executePort() {
					throw new Error('Should not be called for NEEDS_HUMAN.')
				},
			},
		})

		expect(result.outcome).toBe('needs_human')
		expect(result.followUpIssueUrl).toContain('/issues/')
		expect(state.issues).toHaveLength(1)
		expect(state.issues[0]!.labels).toContain('needs-human')
		expect(state.pullRequests).toHaveLength(0)
	})

	test('NEEDS_HUMAN with deterministic changes produces ready PR with [needs review]', async () => {
		const repos = await createRepos(
			{ 'tests/manifest.json': '{"v":1}' },
			{ 'tests/manifest.json': '{"v":2}' },
		)
		const { writer, state } = createTrackingWriter()

		const result = await runScenario({
			sourceChange: makeSourceChange(),
			repos,
			writer,
			portBotJson: {
				target: 'acme/target-repo',
				sync: [
					{ source: 'tests/manifest.json', target: 'tests/manifest.json', mode: 'copy' },
				],
			},
			agentProvider: {
				async decidePort() {
					return makeNeedsHumanDecision()
				},
				async executePort() {
					throw new Error('Should not be called for NEEDS_HUMAN.')
				},
			},
		})

		expect(result.outcome).toBe('pr_opened')
		expect(state.pullRequests).toHaveLength(1)

		const pr = state.pullRequests[0]!

		expect(pr.draft).toBe(false)
		expect(pr.title).toContain('[needs review]')
		expect(pr.labels).toContain('auto-port')
		expect(state.issues).toHaveLength(0)
	})

	test('NEEDS_HUMAN with non-git-trackable deterministic changes falls through to issue', async () => {
		const repos = await createRepos(
			{ 'tests/manifest.json': '{"same":true}' },
			{ 'tests/manifest.json': '{"same":true}' },
		)
		const { writer, state } = createTrackingWriter()

		const result = await runScenario({
			sourceChange: makeSourceChange(),
			repos,
			writer,
			portBotJson: {
				target: 'acme/target-repo',
				sync: [
					{ source: 'tests/manifest.json', target: 'tests/manifest.json', mode: 'copy' },
				],
			},
			agentProvider: {
				async decidePort() {
					return makeNeedsHumanDecision()
				},
				async executePort() {
					throw new Error('Should not be called for NEEDS_HUMAN.')
				},
			},
		})

		expect(result.outcome).toBe('needs_human')
		expect(result.followUpIssueUrl).toContain('/issues/')
		expect(state.issues).toHaveLength(1)
		expect(state.issues[0]!.labels).toContain('needs-human')
		expect(state.pullRequests).toHaveLength(0)
	})

	test('NEEDS_HUMAN with deterministic changes + failed validation produces draft PR', async () => {
		const repos = await createRepos(
			{ 'tests/manifest.json': '{"v":1}' },
			{ 'tests/manifest.json': '{"v":2}' },
		)
		const { writer, state } = createTrackingWriter()

		const result = await runScenario({
			sourceChange: makeSourceChange(),
			repos,
			writer,
			portBotJson: {
				target: 'acme/target-repo',
				sync: [
					{ source: 'tests/manifest.json', target: 'tests/manifest.json', mode: 'copy' },
				],
				validation: ['false'],
			},
			agentProvider: {
				async decidePort() {
					return makeNeedsHumanDecision()
				},
				async executePort() {
					throw new Error('Should not be called for NEEDS_HUMAN.')
				},
			},
		})

		expect(result.outcome).toBe('draft_pr_opened')
		expect(state.pullRequests).toHaveLength(1)
		expect(state.pullRequests[0]!.draft).toBe(true)
		expect(state.pullRequests[0]!.labels).toContain('port-stalled')
	})
})

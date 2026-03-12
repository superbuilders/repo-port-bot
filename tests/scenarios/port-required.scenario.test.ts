/**
 * Scenario tests for PORT_REQUIRED paths — agent execution with real git.
 *
 * State table rows:
 *   - PORT_REQUIRED + agent succeeds + validation pass → ready PR
 *   - PORT_REQUIRED + agent fails validation → draft PR with [stalled]
 *   - PORT_REQUIRED + agent provider error → draft PR
 *   - PORT_REQUIRED + agent produces nothing → skip (no PR)
 */
import { describe, expect, test } from 'bun:test'

import {
	cleanupTempDirs,
	createCrashingAgent,
	createRepos,
	createScriptedAgent,
	createTrackingWriter,
	fileExists,
	listBranches,
	makeSourceChange,
	readTargetFile,
	runScenario,
} from '../harness/index.ts'

cleanupTempDirs()

describe('port-required scenarios', () => {
	test('agent edits produce a ready PR with correct branch and labels', async () => {
		const repos = await createRepos({ 'src/existing.ts': 'original' })
		const { writer, state } = createTrackingWriter()
		const agent = createScriptedAgent(repos.targetDir, {
			edits: [
				{
					path: 'src/ported-feature.ts',
					content: 'export function feature() { return true }',
				},
			],
		})

		const result = await runScenario({
			sourceChange: makeSourceChange(),
			repos,
			writer,
			agentProvider: agent,
		})

		expect(result.outcome).toBe('pr_opened')
		expect(state.pullRequests).toHaveLength(1)

		const pr = state.pullRequests[0]!

		expect(pr.draft).toBe(false)
		expect(pr.title).not.toContain('[')
		expect(pr.labels).toContain('auto-port')
		expect(pr.labels).not.toContain('port-stalled')

		const branches = listBranches(repos.targetDir)

		expect(branches.some(b => b.startsWith('port/'))).toBe(true)
		expect(await fileExists(repos.targetDir, 'src/ported-feature.ts')).toBe(true)
		expect(await readTargetFile(repos.targetDir, 'src/ported-feature.ts')).toBe(
			'export function feature() { return true }',
		)

		expect(state.comments).toHaveLength(1)
	})

	test('agent edits with failing validation produce a draft PR with [stalled]', async () => {
		const repos = await createRepos()
		const { writer, state } = createTrackingWriter()
		const agent = createScriptedAgent(repos.targetDir, {
			edits: [{ path: 'src/broken.ts', content: 'this will not validate' }],
		})

		const result = await runScenario({
			sourceChange: makeSourceChange(),
			repos,
			writer,
			agentProvider: agent,
			portBotJson: {
				target: 'acme/target-repo',
				validation: ['false'],
			},
			maxAttempts: 1,
		})

		expect(result.outcome).toBe('draft_pr_opened')
		expect(state.pullRequests).toHaveLength(1)

		const pr = state.pullRequests[0]!

		expect(pr.draft).toBe(true)
		expect(pr.title).toContain('[stalled]')
		expect(pr.labels).toContain('port-stalled')
	})

	test('agent provider crash with partial work produces a draft PR', async () => {
		const repos = await createRepos()
		const { writer, state } = createTrackingWriter()
		const agent = createCrashingAgent(repos.targetDir, [
			{ path: 'src/partial.ts', content: 'partial work before crash' },
		])

		const result = await runScenario({
			sourceChange: makeSourceChange(),
			repos,
			writer,
			agentProvider: agent,
			maxAttempts: 1,
		})

		expect(result.outcome).toBe('draft_pr_opened')
		expect(state.pullRequests).toHaveLength(1)

		const pr = state.pullRequests[0]!

		expect(pr.draft).toBe(true)
		expect(pr.labels).toContain('port-stalled')
		expect(await fileExists(repos.targetDir, 'src/partial.ts')).toBe(true)
	})

	test('agent that produces no changes results in skip', async () => {
		const repos = await createRepos({ 'src/existing.ts': 'untouched' })
		const { writer, state } = createTrackingWriter()
		const agent = createScriptedAgent(repos.targetDir, { edits: [] })

		const result = await runScenario({
			sourceChange: makeSourceChange(),
			repos,
			writer,
			agentProvider: agent,
		})

		expect(result.outcome).toBe('skipped_not_required')
		expect(state.pullRequests).toHaveLength(0)
	})

	test('deterministic sync + agent edits both appear in the final PR', async () => {
		const repos = await createRepos(
			{ 'tests/fixtures/a.json': '{"old":true}' },
			{ 'tests/fixtures/a.json': '{"new":true}' },
		)
		const { writer, state } = createTrackingWriter()
		const agent = createScriptedAgent(repos.targetDir, {
			edits: [{ path: 'src/ported.ts', content: 'ported code' }],
		})

		const result = await runScenario({
			sourceChange: makeSourceChange(),
			repos,
			writer,
			agentProvider: agent,
			portBotJson: {
				target: 'acme/target-repo',
				sync: [
					{
						source: 'tests/fixtures/a.json',
						target: 'tests/fixtures/a.json',
						mode: 'copy',
					},
				],
			},
		})

		expect(result.outcome).toBe('pr_opened')
		expect(state.pullRequests).toHaveLength(1)

		expect(await readTargetFile(repos.targetDir, 'tests/fixtures/a.json')).toBe('{"new":true}')
		expect(await readTargetFile(repos.targetDir, 'src/ported.ts')).toBe('ported code')
	})
})

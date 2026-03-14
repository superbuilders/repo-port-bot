/**
 * Scenario tests for deterministic-only delivery paths.
 *
 * State table rows:
 *   - deterministic_changed=yes + NO_AGENT_PORT_NEEDED + pass → ready PR
 *   - deterministic_changed=yes + NO_AGENT_PORT_NEEDED + fail → draft PR
 *   - deterministic_changed=yes + NO_AGENT_PORT_NEEDED + no diff → skip
 */
import { describe, expect, test } from 'bun:test'

import {
	cleanupTempDirs,
	createRepos,
	createTrackingWriter,
	failingValidation,
	fileExists,
	listBranches,
	makeDocsOnlyChange,
	parsePrBody,
	passingValidation,
	readTargetFile,
	runScenario,
} from '../harness/index.ts'

cleanupTempDirs()

describe('deterministic-only scenarios', () => {
	test('synced files produce a ready PR with [sync only] title tag', async () => {
		const repos = await createRepos(
			{ 'tests/fixtures/a.json': '{"old":true}' },
			{ 'tests/fixtures/a.json': '{"new":true}' },
		)
		const { writer, state } = createTrackingWriter()

		const result = await runScenario({
			sourceChange: makeDocsOnlyChange(),
			repos,
			writer,
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
		expect(result.targetPullRequestUrl).toContain('/pull/')
		expect(state.pullRequests).toHaveLength(1)

		const pr = state.pullRequests[0]!

		expect(pr.draft).toBe(false)
		expect(pr.title).toContain('[sync only]')
		expect(pr.labels).toContain('auto-port')
		expect(pr.labels).not.toContain('port-stalled')

		const branches = listBranches(repos.targetDir)

		expect(branches.some(b => b.startsWith('port/'))).toBe(true)
	})

	test('failing validation stderr appears in diagnostics section', async () => {
		const repos = await createRepos(
			{ 'tests/fixtures/a.json': '{"old":true}' },
			{ 'tests/fixtures/a.json': '{"new":true}' },
		)
		const { writer, state } = createTrackingWriter()
		const validation = await failingValidation(repos.targetDir, 'STDERR_VALIDATION_TOKEN')

		const result = await runScenario({
			sourceChange: makeDocsOnlyChange(),
			repos,
			writer,
			portBotJson: {
				target: 'acme/target-repo',
				sync: [
					{
						source: 'tests/fixtures/a.json',
						target: 'tests/fixtures/a.json',
						mode: 'copy',
					},
				],
				validation: [validation],
			},
		})

		expect(result.outcome).toBe('draft_pr_opened')

		const pr = state.pullRequests[0]!
		const parsed = parsePrBody(pr.body)

		expect(pr.draft).toBe(true)
		expect(pr.labels).toContain('port-stalled')
		expect(parsed.diagnostics).toContain('[FAIL]')
		expect(parsed.diagnostics).toContain('STDERR_VALIDATION_TOKEN')
	})

	test('passing validation stdout appears in diagnostics section', async () => {
		const repos = await createRepos(
			{ 'tests/fixtures/a.json': '{"old":true}' },
			{ 'tests/fixtures/a.json': '{"new":true}' },
		)
		const { writer, state } = createTrackingWriter()
		const validation = await passingValidation(repos.targetDir, 'STDOUT_VALIDATION_TOKEN')

		const result = await runScenario({
			sourceChange: makeDocsOnlyChange(),
			repos,
			writer,
			portBotJson: {
				target: 'acme/target-repo',
				sync: [
					{
						source: 'tests/fixtures/a.json',
						target: 'tests/fixtures/a.json',
						mode: 'copy',
					},
				],
				validation: [validation],
			},
		})

		expect(result.outcome).toBe('pr_opened')

		const pr = state.pullRequests[0]!
		const parsed = parsePrBody(pr.body)

		expect(parsed.diagnostics).toContain('[PASS]')
		expect(parsed.diagnostics).toContain('STDOUT_VALIDATION_TOKEN')
	})

	test('validation that reverts synced files produces skip, not phantom PR', async () => {
		const repos = await createRepos(
			{ 'tests/fixtures/a.json': '{"old":true}' },
			{ 'tests/fixtures/a.json': '{"new":true}' },
		)
		const { writer, state } = createTrackingWriter()

		const result = await runScenario({
			sourceChange: makeDocsOnlyChange(),
			repos,
			writer,
			portBotJson: {
				target: 'acme/target-repo',
				sync: [
					{
						source: 'tests/fixtures/a.json',
						target: 'tests/fixtures/a.json',
						mode: 'copy',
					},
				],
				validation: ['git checkout -- tests/fixtures/a.json'],
			},
		})

		expect(result.outcome).toBe('skipped_not_required')
		expect(state.pullRequests).toHaveLength(0)
		expect(result.targetPullRequestUrl).toBeUndefined()
	})

	test('deterministic sync with no actual diff skips without PR', async () => {
		const repos = await createRepos(
			{ 'tests/fixtures/a.json': '{"same":true}' },
			{ 'tests/fixtures/a.json': '{"same":true}' },
		)
		const { writer, state } = createTrackingWriter()

		const result = await runScenario({
			sourceChange: makeDocsOnlyChange(),
			repos,
			writer,
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

		expect(result.outcome).toBe('skipped_not_required')
		expect(state.pullRequests).toHaveLength(0)
	})

	test('mirror mode syncs directory tree and removes stale files', async () => {
		const repos = await createRepos(
			{
				'fixtures/a.json': '1',
				'fixtures/stale.json': 'should be removed',
			},
			{
				'fixtures/a.json': '1-updated',
				'fixtures/b.json': '2-new',
			},
		)
		const { writer, state } = createTrackingWriter()

		const result = await runScenario({
			sourceChange: makeDocsOnlyChange(),
			repos,
			writer,
			portBotJson: {
				target: 'acme/target-repo',
				sync: [{ source: 'fixtures/**', target: 'fixtures/', mode: 'mirror' }],
			},
		})

		expect(result.outcome).toBe('pr_opened')
		expect(state.pullRequests).toHaveLength(1)

		const branches = listBranches(repos.targetDir)
		const portBranch = branches.find(b => b.startsWith('port/'))

		expect(portBranch).toBeDefined()

		expect(await readTargetFile(repos.targetDir, 'fixtures/a.json')).toBe('1-updated')
		expect(await readTargetFile(repos.targetDir, 'fixtures/b.json')).toBe('2-new')
		expect(await fileExists(repos.targetDir, 'fixtures/stale.json')).toBe(false)
	})
})

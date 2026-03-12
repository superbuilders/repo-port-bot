/**
 * Scenario tests for skip paths — no artifact produced.
 *
 * State table rows:
 *   - NO_AGENT_PORT_NEEDED + no deterministic changes → skip
 *   - Pre-deterministic skip signals (no-port, auto-port, missing PR)
 */
import { describe, expect, test } from 'bun:test'

import {
	cleanupTempDirs,
	createRepos,
	createTrackingWriter,
	makeAutoPortChange,
	makeConfigOnlyChange,
	makeDocsOnlyChange,
	makeNoPortChange,
	makeSourceChange,
	runScenario,
} from '../harness/index.ts'

cleanupTempDirs()

describe('skip scenarios', () => {
	test('docs-only change is skipped with source notification', async () => {
		const repos = await createRepos()
		const { writer, state } = createTrackingWriter()

		const result = await runScenario({
			sourceChange: makeDocsOnlyChange(),
			repos,
			writer,
		})

		expect(result.outcome).toBe('skipped_not_required')
		expect(state.pullRequests).toHaveLength(0)
		expect(state.issues).toHaveLength(0)
		expect(state.comments).toHaveLength(1)
	})

	test('no-port label skips before deterministic operations', async () => {
		const repos = await createRepos(
			{ 'src/app.ts': 'target' },
			{ 'src/app.ts': 'source-updated' },
		)
		const { writer, state } = createTrackingWriter()

		const result = await runScenario({
			sourceChange: makeNoPortChange(),
			repos,
			writer,
			portBotJson: {
				target: 'acme/target-repo',
				sync: [{ source: 'src/app.ts', target: 'src/app.ts', mode: 'copy' }],
			},
		})

		expect(result.outcome).toBe('skipped_not_required')
		expect(state.pullRequests).toHaveLength(0)
		expect(state.issues).toHaveLength(0)
	})

	test('auto-port label skips (loop prevention)', async () => {
		const repos = await createRepos()
		const { writer, state } = createTrackingWriter()

		const result = await runScenario({
			sourceChange: makeAutoPortChange(),
			repos,
			writer,
		})

		expect(result.outcome).toBe('skipped_not_required')
		expect(state.pullRequests).toHaveLength(0)
	})

	test('config-only change is skipped after deterministic operations', async () => {
		const repos = await createRepos()
		const { writer, state } = createTrackingWriter()

		const result = await runScenario({
			sourceChange: makeConfigOnlyChange(),
			repos,
			writer,
		})

		expect(result.outcome).toBe('skipped_not_required')
		expect(state.pullRequests).toHaveLength(0)
		expect(state.issues).toHaveLength(0)
		expect(state.comments).toHaveLength(1)
	})

	test('missing pull request metadata skips', async () => {
		const repos = await createRepos()
		const { writer, state } = createTrackingWriter()

		const result = await runScenario({
			sourceChange: makeSourceChange({ pullRequest: undefined }),
			repos,
			writer,
		})

		expect(result.outcome).toBe('skipped_not_required')
		expect(state.pullRequests).toHaveLength(0)
	})
})

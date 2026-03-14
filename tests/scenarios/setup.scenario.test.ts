/**
 * Scenario tests for setup commands.
 *
 * Setup commands run once after clone, before deterministic ops.
 * Failure aborts the entire run (not a stalled PR — a hard failure).
 */
import { describe, expect, test } from 'bun:test'

import {
	cleanupTempDirs,
	createRepos,
	createTrackingWriter,
	failingValidation,
	fileExists,
	makeSourceChange,
	passingValidation,
	runScenario,
} from '../harness/index.ts'

cleanupTempDirs()

describe('setup command scenarios', () => {
	test('successful setup command runs before deterministic phase', async () => {
		const repos = await createRepos(
			{ 'tests/fixtures/a.json': '{"old":true}' },
			{ 'tests/fixtures/a.json': '{"new":true}' },
		)
		const { writer, state } = createTrackingWriter()
		const setup = await passingValidation(repos.targetDir, 'SETUP_OK')

		const result = await runScenario({
			sourceChange: makeSourceChange(),
			repos,
			writer,
			portBotJson: {
				target: 'acme/target-repo',
				setup: [`${setup} && touch .setup-ran`],
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
		expect(await fileExists(repos.targetDir, '.setup-ran')).toBe(true)
	})

	test('failing setup command aborts run with failure', async () => {
		const repos = await createRepos()
		const { writer, state } = createTrackingWriter()
		const setup = await failingValidation(repos.targetDir, 'SETUP_INSTALL_FAILED')

		const result = await runScenario({
			sourceChange: makeSourceChange(),
			repos,
			writer,
			portBotJson: {
				target: 'acme/target-repo',
				setup: [setup],
			},
		})

		expect(result.outcome).toBe('failed')
		expect(state.pullRequests).toHaveLength(0)
		expect(state.issues).toHaveLength(0)
	})

	test('setup commands do not run on pre-deterministic skips', async () => {
		const repos = await createRepos()
		const { writer } = createTrackingWriter()
		const setup = await failingValidation(repos.targetDir, 'SHOULD_NOT_RUN')

		const result = await runScenario({
			sourceChange: makeSourceChange({
				pullRequest: {
					number: 99,
					title: 'Skip',
					body: '',
					url: 'https://github.com/acme/source/pull/99',
					labels: ['no-port'],
				},
			}),
			repos,
			writer,
			portBotJson: {
				target: 'acme/target-repo',
				setup: [setup],
			},
		})

		expect(result.outcome).toBe('skipped_not_required')
	})
})

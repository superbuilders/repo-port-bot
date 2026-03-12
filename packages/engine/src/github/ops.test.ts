import { describe, expect, test } from 'bun:test'

import {
	buildCommitMessage,
	buildPortBranchName,
	checkTargetSideDiff,
	collectTouchedPaths,
	expectCommandSuccess,
	isValidationSuccessful,
	resolveFramingMode,
	stageAndCommit,
} from './ops.ts'

import type { CommandRunner } from '../types.ts'
import type { DeterministicPhaseResult, ExecutePortResult, PortContext, RepoRef } from '../types.ts'

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
 * Build a minimal port context for ops tests.
 *
 * @returns Port context fixture.
 */
function makeContext(): PortContext {
	return {
		runId: 'run-1',
		startedAt: '2026-03-03T00:00:00.000Z',
		sourceRepo: SOURCE_REPO,
		sourceChange: {
			mergedCommitSha: 'abc1234567',
			pullRequest: {
				number: 42,
				title: 'Ship feature',
				body: '',
				url: 'https://github.com/acme/source-repo/pull/42',
				labels: [],
			},
			files: [],
		},
		pluginConfig: {
			targetRepo: TARGET_REPO,
			ignorePatterns: [],
			validationCommands: [],
			deterministicOperations: [],
			pathMappings: {},
		},
	}
}

/**
 * Build a fake command runner that records calls and returns preset responses.
 *
 * @param responses - Map of command string to response.
 * @returns Runner and captured calls.
 */
function createFakeRunner(
	responses: Record<string, { exitCode: number; stdout: string; stderr: string }>,
): { runner: CommandRunner; calls: string[][] } {
	const calls: string[][] = []

	return {
		runner: async (input: { command: string[]; workingDirectory: string }) => {
			calls.push(input.command)

			const key = input.command.join(' ')

			return responses[key] ?? { exitCode: 0, stdout: '', stderr: '' }
		},
		calls,
	}
}

describe('buildPortBranchName', () => {
	test('builds branch name from source repo, PR number, and short SHA', () => {
		expect(buildPortBranchName(makeContext())).toBe('port/source-repo/42-abc1234')
	})

	test('uses 0 when PR number is absent', () => {
		const context = makeContext()

		context.sourceChange.pullRequest = undefined
		expect(buildPortBranchName(context)).toBe('port/source-repo/0-abc1234')
	})
})

describe('buildCommitMessage', () => {
	test('includes title, source PR trailer, commit trailer, and footer', () => {
		const message = buildCommitMessage(makeContext())

		expect(message).toContain('Port: Ship feature')
		expect(message).toContain('Source-PR: https://github.com/acme/source-repo/pull/42')
		expect(message).toContain('Source-Commit: abc1234567')
		expect(message).toContain('Ported-By: repo-port-bot')
	})

	test('includes model trailer when provided', () => {
		const message = buildCommitMessage(makeContext(), 'claude-sonnet-4-6')

		expect(message).toContain('Agent-Model: claude-sonnet-4-6')
	})

	test('omits model trailer when not provided', () => {
		const message = buildCommitMessage(makeContext())

		expect(message).not.toContain('Agent-Model')
	})
})

describe('expectCommandSuccess', () => {
	test('resolves when command exits 0', async () => {
		const { runner } = createFakeRunner({
			'echo hello': { exitCode: 0, stdout: 'hello', stderr: '' },
		})

		await expect(
			expectCommandSuccess(runner, ['echo', 'hello'], '/tmp'),
		).resolves.toBeUndefined()
	})

	test('throws when command exits non-zero', async () => {
		const { runner } = createFakeRunner({
			false: { exitCode: 1, stdout: '', stderr: 'fail' },
		})

		await expect(expectCommandSuccess(runner, ['false'], '/tmp')).rejects.toThrow(
			'Command failed (false): exit 1',
		)
	})
})

describe('checkTargetSideDiff', () => {
	test('returns false when no touched paths', async () => {
		const { runner, calls } = createFakeRunner({})

		expect(await checkTargetSideDiff(runner, '/tmp', [])).toBe(false)
		expect(calls).toEqual([])
	})

	test('returns true when git status reports changes', async () => {
		const { runner } = createFakeRunner({
			'git status --short -- src/file.ts': {
				exitCode: 0,
				stdout: ' M src/file.ts\n',
				stderr: '',
			},
		})

		expect(await checkTargetSideDiff(runner, '/tmp', ['src/file.ts'])).toBe(true)
	})

	test('returns false when git status is empty', async () => {
		const { runner } = createFakeRunner({
			'git status --short -- src/file.ts': {
				exitCode: 0,
				stdout: '',
				stderr: '',
			},
		})

		expect(await checkTargetSideDiff(runner, '/tmp', ['src/file.ts'])).toBe(false)
	})
})

describe('stageAndCommit', () => {
	test('uses unscoped git add when no touched paths (agent execution path)', async () => {
		const { runner, calls } = createFakeRunner({
			'git add -A': { exitCode: 0, stdout: '', stderr: '' },
			'git diff --cached --quiet': { exitCode: 0, stdout: '', stderr: '' },
		})

		await stageAndCommit(runner, '/tmp', 'message', [])
		expect(calls.map(c => c.join(' '))).toEqual(['git add -A', 'git diff --cached --quiet'])
	})

	test('stages and commits when diff exists', async () => {
		const { runner, calls } = createFakeRunner({
			'git add -A -- src/file.ts': { exitCode: 0, stdout: '', stderr: '' },
			'git diff --cached --quiet': { exitCode: 1, stdout: '', stderr: '' },
			'git commit -m test message': { exitCode: 0, stdout: '', stderr: '' },
		})

		await stageAndCommit(runner, '/tmp', 'test message', ['src/file.ts'])
		expect(calls.map(c => c.join(' '))).toEqual([
			'git add -A -- src/file.ts',
			'git diff --cached --quiet',
			'git commit -m test message',
		])
	})

	test('skips commit when no staged diff', async () => {
		const { runner, calls } = createFakeRunner({
			'git add -A -- src/file.ts': { exitCode: 0, stdout: '', stderr: '' },
			'git diff --cached --quiet': { exitCode: 0, stdout: '', stderr: '' },
		})

		await stageAndCommit(runner, '/tmp', 'test message', ['src/file.ts'])
		expect(calls.map(c => c.join(' '))).toEqual([
			'git add -A -- src/file.ts',
			'git diff --cached --quiet',
		])
	})
})

describe('isValidationSuccessful', () => {
	test('returns true when undefined', () => {
		expect(isValidationSuccessful(undefined)).toBe(true)
	})

	test('returns true when empty', () => {
		expect(isValidationSuccessful([])).toBe(true)
	})

	test('returns true when all pass', () => {
		expect(
			isValidationSuccessful([
				{ command: 'check', ok: true, exitCode: 0, stdout: '', stderr: '', durationMs: 1 },
			]),
		).toBe(true)
	})

	test('returns false when any fail', () => {
		expect(
			isValidationSuccessful([
				{ command: 'check', ok: false, exitCode: 1, stdout: '', stderr: '', durationMs: 1 },
			]),
		).toBe(false)
	})
})

describe('collectTouchedPaths', () => {
	test('collects from deterministic result', () => {
		const deterministic: DeterministicPhaseResult = {
			changed: true,
			operations: [],
			touchedFiles: ['a.json', 'b.json'],
		}

		expect(collectTouchedPaths(deterministic, undefined, undefined).sort()).toEqual([
			'a.json',
			'b.json',
		])
	})

	test('falls back to context deterministic', () => {
		const contextDeterministic: DeterministicPhaseResult = {
			changed: true,
			operations: [],
			touchedFiles: ['c.json'],
		}

		expect(collectTouchedPaths(undefined, contextDeterministic, undefined)).toEqual(['c.json'])
	})

	test('merges deterministic and execution paths', () => {
		const deterministic: DeterministicPhaseResult = {
			changed: true,
			operations: [],
			touchedFiles: ['a.json'],
		}
		const execution = {
			outcome: { status: 'SUCCEEDED', attempts: 1, touchedFiles: ['b.ts'] },
			trace: { toolCallLog: [], events: [], attempts: [] },
		} as unknown as ExecutePortResult

		expect(collectTouchedPaths(deterministic, undefined, execution).sort()).toEqual([
			'a.json',
			'b.ts',
		])
	})

	test('deduplicates overlapping paths', () => {
		const deterministic: DeterministicPhaseResult = {
			changed: true,
			operations: [],
			touchedFiles: ['shared.json'],
		}
		const execution = {
			outcome: { status: 'SUCCEEDED', attempts: 1, touchedFiles: ['shared.json'] },
			trace: { toolCallLog: [], events: [], attempts: [] },
		} as unknown as ExecutePortResult

		expect(collectTouchedPaths(deterministic, undefined, execution)).toEqual(['shared.json'])
	})
})

describe('resolveFramingMode', () => {
	test('returns explicit mode when provided', () => {
		expect(resolveFramingMode('deterministic_only', true, 'SUCCEEDED', 'PORT_REQUIRED')).toBe(
			'deterministic_only',
		)
	})

	test('returns agent_success for PORT_REQUIRED + SUCCEEDED', () => {
		expect(resolveFramingMode(undefined, true, 'SUCCEEDED', 'PORT_REQUIRED')).toBe(
			'agent_success',
		)
	})

	test('returns agent_stalled for PORT_REQUIRED + non-SUCCEEDED', () => {
		expect(resolveFramingMode(undefined, true, 'VALIDATION_FAILED', 'PORT_REQUIRED')).toBe(
			'agent_stalled',
		)
	})

	test('returns residual_handoff for NEEDS_HUMAN', () => {
		expect(resolveFramingMode(undefined, false, undefined, 'NEEDS_HUMAN')).toBe(
			'residual_handoff',
		)
	})

	test('returns deterministic_only for NO_AGENT_PORT_NEEDED', () => {
		expect(resolveFramingMode(undefined, false, undefined, 'NO_AGENT_PORT_NEEDED')).toBe(
			'deterministic_only',
		)
	})
})

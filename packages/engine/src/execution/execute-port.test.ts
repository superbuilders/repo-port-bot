import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { executePort } from './execute-port.ts'

import type { Logger } from '@repo-port-bot/logger'

import type { AgentInput, AgentProvider, PortContext, RepoRef } from '../types.ts'

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

const tempDirectories: string[] = []

/**
 * Create a temporary directory for one test case.
 *
 * @returns Absolute temp directory path.
 */
async function createTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'repo-port-bot-exec-'))

	tempDirectories.push(directory)

	return directory
}

afterEach(async () => {
	for (const directory of tempDirectories.splice(0, tempDirectories.length)) {
		await rm(directory, { recursive: true, force: true })
	}
})

/**
 * Build a minimal valid `PortContext` for execution tests.
 *
 * @param validationCommands - Ordered validation commands for this test.
 * @returns Synthetic context object.
 */
function makeContext(validationCommands: string[]): PortContext {
	return {
		runId: 'run-1',
		startedAt: '2026-03-03T00:00:00.000Z',
		sourceRepo: SOURCE_REPO,
		sourceChange: {
			mergedCommitSha: 'abc123',
			pullRequest: {
				number: 42,
				title: 'Test PR',
				body: '',
				url: 'https://github.com/acme/source-repo/pull/42',
				labels: [],
			},
			files: [{ path: 'src/example.ts', status: 'modified', additions: 3, deletions: 1 }],
		},
		pluginConfig: {
			targetRepo: TARGET_REPO,
			ignorePatterns: [],
			validationCommands,
			pathMappings: {},
		},
	}
}

describe('executePort', () => {
	test('returns success on first attempt when validation passes', async () => {
		const directory = await createTempDirectory()
		let receivedInput: AgentInput | undefined = undefined
		const provider: AgentProvider = {
			async executePort(
				input: AgentInput,
			): Promise<Awaited<ReturnType<AgentProvider['executePort']>>> {
				receivedInput = input

				return {
					touchedFiles: ['src/ported.ts'],
					complete: true,
					notes: 'Applied source changes.',
					toolCallLog: [],
				}
			},
		}

		const result = await executePort({
			agentProvider: provider,
			context: makeContext(['echo ok']),
			targetWorkingDirectory: directory,
			sourceWorkingDirectory: '/tmp/source-repo',
			diffFilePath: '/tmp/source-repo/port-diff.patch',
			maxAttempts: 3,
		})

		expect(result.success).toBe(true)
		expect(result.attempts).toBe(1)
		expect(result.history).toHaveLength(1)
		expect(result.history[0]?.validation[0]?.ok).toBe(true)
		expect(result.touchedFiles).toEqual(['src/ported.ts'])
		expect(receivedInput).toBeDefined()
		expect(receivedInput!.sourceWorkingDirectory).toBe('/tmp/source-repo')
		expect(receivedInput!.diffFilePath).toBe('/tmp/source-repo/port-diff.patch')
	})

	test('retries with previous attempt feedback, then succeeds', async () => {
		const directory = await createTempDirectory()
		const previousAttemptLengths: number[] = []
		let callCount = 0
		const provider: AgentProvider = {
			async executePort(
				input: AgentInput,
			): Promise<Awaited<ReturnType<AgentProvider['executePort']>>> {
				callCount += 1
				previousAttemptLengths.push(input.previousAttempts.length)

				if (callCount === 2) {
					await Bun.write(join(directory, 'fixed.txt'), 'fixed')
				}

				return {
					touchedFiles: callCount === 1 ? ['src/first-pass.ts'] : ['src/fix-pass.ts'],
					complete: callCount === 2,
					toolCallLog: [
						{
							toolName: 'write_file',
							input: { attempt: callCount },
							output: { ok: true },
						},
					],
				}
			},
		}

		const result = await executePort({
			agentProvider: provider,
			context: makeContext(['test -f fixed.txt']),
			targetWorkingDirectory: directory,
			maxAttempts: 3,
		})

		expect(result.success).toBe(true)
		expect(result.attempts).toBe(2)
		expect(result.history).toHaveLength(2)
		expect(result.history[0]?.validation[0]?.ok).toBe(false)
		expect(result.history[1]?.validation[0]?.ok).toBe(true)
		expect(previousAttemptLengths).toEqual([0, 1])
		expect(result.touchedFiles.sort()).toEqual(['src/first-pass.ts', 'src/fix-pass.ts'])
	})

	test('returns failure when validation keeps failing until retry exhaustion', async () => {
		const directory = await createTempDirectory()
		const provider: AgentProvider = {
			async executePort(): Promise<Awaited<ReturnType<AgentProvider['executePort']>>> {
				return {
					touchedFiles: ['src/failing.ts'],
					complete: true,
					toolCallLog: [],
				}
			},
		}

		const result = await executePort({
			agentProvider: provider,
			context: makeContext(['false']),
			targetWorkingDirectory: directory,
			maxAttempts: 2,
		})

		expect(result.success).toBe(false)
		expect(result.attempts).toBe(2)
		expect(result.history).toHaveLength(2)
		expect(result.failureReason).toContain('Validation failed after 2 attempts')
		expect(result.history[1]?.validation[0]?.ok).toBe(false)
	})

	test('returns failure when provider throws', async () => {
		const directory = await createTempDirectory()
		const provider: AgentProvider = {
			async executePort(): Promise<Awaited<ReturnType<AgentProvider['executePort']>>> {
				throw new Error('provider crashed')
			},
		}

		const result = await executePort({
			agentProvider: provider,
			context: makeContext(['echo should-not-run']),
			targetWorkingDirectory: directory,
			maxAttempts: 3,
		})

		expect(result.success).toBe(false)
		expect(result.attempts).toBe(1)
		expect(result.history).toHaveLength(1)
		expect(result.history[0]?.validation).toEqual([])
		expect(result.failureReason).toContain('Agent provider failed on attempt 1')
	})

	test('emits per-attempt logs when logger is provided', async () => {
		const directory = await createTempDirectory()
		const infoMessages: string[] = []
		const logger: Logger = {
			error: () => {},
			warn: () => {},
			info: message => infoMessages.push(message),
			debug: () => {},
			group: () => {},
			groupEnd: () => {},
		}
		const provider: AgentProvider = {
			async executePort(): Promise<Awaited<ReturnType<AgentProvider['executePort']>>> {
				return {
					touchedFiles: ['src/failing.ts'],
					complete: true,
					toolCallLog: [],
				}
			},
		}

		await executePort({
			agentProvider: provider,
			context: makeContext(['false']),
			targetWorkingDirectory: directory,
			maxAttempts: 1,
			logger,
		})

		expect(infoMessages.some(message => message.includes('stage=execute attempt=1/1'))).toBe(
			true,
		)
	})

	test('routes streamed agent messages to info/debug logs', async () => {
		const directory = await createTempDirectory()
		const infoMessages: string[] = []
		const debugMessages: string[] = []
		const logger: Logger = {
			error: () => {},
			warn: () => {},
			info: message => infoMessages.push(message),
			debug: message => debugMessages.push(message),
			group: () => {},
			groupEnd: () => {},
		}
		const provider: AgentProvider = {
			async executePort(
				input: AgentInput,
			): Promise<Awaited<ReturnType<AgentProvider['executePort']>>> {
				input.onMessage?.({
					kind: 'thinking',
					text: 'Inspecting source and target trees.',
				})
				input.onMessage?.({
					kind: 'tool_start',
					toolName: 'Read',
					toolInput: { file_path: '/tmp/target/src/example.ts' },
				})
				input.onMessage?.({
					kind: 'tool_end',
					toolName: 'Read',
					durationMs: 12,
				})
				input.onMessage?.({
					kind: 'text',
					text: 'Applied changes.',
				})

				return {
					touchedFiles: ['src/example.ts'],
					complete: true,
					toolCallLog: [],
				}
			},
		}

		await executePort({
			agentProvider: provider,
			context: makeContext(['echo ok']),
			targetWorkingDirectory: directory,
			maxAttempts: 1,
			logger,
		})

		expect(
			infoMessages.some(message =>
				message.includes('stage=execute tool=Read file=/tmp/target/src/example.ts'),
			),
		).toBe(true)
		expect(
			debugMessages.some(message =>
				message.includes('stage=execute thinking=Inspecting source'),
			),
		).toBe(true)
		expect(
			debugMessages.some(message =>
				message.includes('stage=execute tool=Read toolDurationMs=12'),
			),
		).toBe(true)
		expect(
			debugMessages.some(message => message.includes('stage=execute text=Applied changes.')),
		).toBe(true)
	})
})

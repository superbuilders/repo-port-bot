/**
 * Scripted agent provider for scenario tests.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type {
	AgentProvider,
	DecidePortResult,
	ExecutePortAttemptOutput,
} from '../../packages/engine/src/index.ts'
import type { ScriptedAgentOptions, ScriptedEdit } from './types.ts'

/**
 * Agent provider that writes predetermined files instead of calling an LLM.
 *
 * @param targetDir - Target repo working directory.
 * @param options - Scripted behavior.
 * @returns Agent provider.
 */
export function createScriptedAgent(
	targetDir: string,
	options: ScriptedAgentOptions = {},
): AgentProvider {
	return {
		async decidePort(): Promise<DecidePortResult> {
			return {
				outcome: { kind: 'PORT_REQUIRED', reason: 'Scripted agent: port required.' },
				trace: {
					source: 'fallback',
					notes: 'Scripted agent fallback.',
					toolCallLog: [],
					events: [],
				},
			}
		},
		async executePort(): Promise<ExecutePortAttemptOutput> {
			const touchedFiles: string[] = []

			for (const edit of options.edits ?? []) {
				const fullPath = join(targetDir, edit.path)

				await mkdir(join(fullPath, '..'), { recursive: true })
				await writeFile(fullPath, edit.content)
				touchedFiles.push(edit.path)
			}

			return {
				touchedFiles,
				complete: true,
				trace: {
					notes: 'Scripted agent applied predetermined edits.',
					model: 'scripted',
					durationMs: 1,
					toolCallLog: [],
					events: [],
				},
			}
		},
	}
}

/**
 * Agent provider that writes files then throws, simulating a provider crash.
 *
 * @param targetDir - Target repo working directory.
 * @param editsBeforeCrash - Files to write before throwing.
 * @returns Agent provider that crashes on executePort.
 */
export function createCrashingAgent(
	targetDir: string,
	editsBeforeCrash: ScriptedEdit[] = [],
): AgentProvider {
	return {
		async decidePort(): Promise<DecidePortResult> {
			return {
				outcome: { kind: 'PORT_REQUIRED', reason: 'Scripted agent: port required.' },
				trace: {
					source: 'fallback',
					notes: 'Scripted agent fallback.',
					toolCallLog: [],
					events: [],
				},
			}
		},
		async executePort(): Promise<ExecutePortAttemptOutput> {
			for (const edit of editsBeforeCrash) {
				const fullPath = join(targetDir, edit.path)

				await mkdir(join(fullPath, '..'), { recursive: true })
				await writeFile(fullPath, edit.content)
			}

			throw new Error('Provider crashed unexpectedly.')
		},
	}
}

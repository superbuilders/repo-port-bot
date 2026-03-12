import { applySyncOperation } from '../lib/sync.ts'

import type { DeterministicOperation, DeterministicPhaseResult } from '../types.ts'

interface ExecuteDeterministicOptions {
	deterministicOperations: DeterministicOperation[]
	sourceWorkingDirectory: string
	targetWorkingDirectory: string
}

/**
 * Apply deterministic operations to the target working tree.
 *
 * Dispatches each operation by its `kind` tag. New operation kinds are added
 * as cases in the switch statement.
 *
 * @param options - Deterministic execution options.
 * @returns Result describing whether the target tree changed.
 */
export async function executeDeterministic(
	options: ExecuteDeterministicOptions,
): Promise<DeterministicPhaseResult> {
	const touchedFiles = new Set<string>()

	for (const operation of options.deterministicOperations) {
		switch (operation.kind) {
			case 'sync': {
				await applySyncOperation({
					operation,
					sourceWorkingDirectory: options.sourceWorkingDirectory,
					targetWorkingDirectory: options.targetWorkingDirectory,
					touchedFiles,
				})
				break
			}
			default: {
				throw new Error(
					`Unknown deterministic operation kind: ${String((operation as DeterministicOperation).kind)}`,
				)
			}
		}
	}

	return {
		changed: touchedFiles.size > 0,
		operations: options.deterministicOperations,
		touchedFiles: [...touchedFiles],
	}
}

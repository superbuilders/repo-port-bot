import { DECISION_HEURISTICS } from './heuristics.ts'

import type { AgentMessage, AgentProvider, DecidePortResult, PortContext } from '../types.ts'

/**
 * Build a fallback decision when pipeline fails before decision output exists.
 *
 * @param message - Error message.
 * @returns Decision describing engine failure.
 */
export function buildEngineFailureDecision(message: string): DecidePortResult {
	return {
		outcome: {
			kind: 'NEEDS_HUMAN',
			reason: `Engine failure before decision completed: ${message}`,
		},
		trace: {
			source: 'fallback',
			notes: `Engine failure before decision completed: ${message}`,
			toolCallLog: [],
			events: [],
		},
	}
}

/**
 * Classifier fallback used when no fast heuristic can make a decision.
 *
 * @returns Conservative fallback.
 */
function classifyWithStub(): DecidePortResult {
	return {
		outcome: {
			kind: 'PORT_REQUIRED',
			reason: 'No heuristic matched and no classifier was configured; defaulting to port required.',
		},
		trace: {
			source: 'fallback',
			notes: 'No heuristic matched and no classifier was configured; defaulting to port required.',
			toolCallLog: [],
			events: [],
		},
	}
}

/**
 * Run the decision stage for a port run.
 *
 * @param context - Port run context.
 * @param options - Optional decision dependencies.
 * @param options.agentProvider - Optional agent provider for LLM-backed classification.
 * @param options.targetWorkingDirectory - Target repo working directory for classifier context.
 * @param options.sourceWorkingDirectory - Optional source repo checkout path for classifier context.
 * @param options.diffFilePath - Optional full source diff file path for classifier context.
 * @param options.onMessage - Optional callback for streamed classifier messages.
 * @returns Decision result from heuristics or classifier fallback.
 */
export async function decide(
	context: PortContext,
	options: {
		agentProvider?: AgentProvider
		targetWorkingDirectory?: string
		sourceWorkingDirectory?: string
		diffFilePath?: string
		onMessage?: (message: AgentMessage) => void
	} = {},
): Promise<DecidePortResult> {
	for (const heuristic of DECISION_HEURISTICS) {
		const decision = heuristic(context)

		if (decision) {
			return {
				outcome: decision,
				trace: {
					source: 'heuristic',
					heuristicName: heuristic.name,
					notes: decision.reason,
					toolCallLog: [],
					events: [],
				},
			}
		}
	}

	if (!options.agentProvider) {
		return classifyWithStub()
	}

	return options.agentProvider.decidePort({
		files: context.sourceChange.files,
		targetWorkingDirectory: options.targetWorkingDirectory ?? process.cwd(),
		sourceWorkingDirectory: options.sourceWorkingDirectory,
		diffFilePath: options.diffFilePath,
		pluginConfig: context.pluginConfig,
		onMessage: options.onMessage,
	})
}

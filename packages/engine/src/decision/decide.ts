import { DECISION_HEURISTICS } from './heuristics.ts'

import type { AgentProvider, PortContext, PortDecision } from '../types.ts'

/**
 * Build a fallback decision when pipeline fails before decision output exists.
 *
 * @param message - Error message.
 * @returns Decision describing engine failure.
 */
export function buildEngineFailureDecision(message: string): PortDecision {
	return {
		kind: 'NEEDS_HUMAN',
		reason: `Engine failure before decision completed: ${message}`,
	}
}

/**
 * Classifier fallback used when no fast heuristic can make a decision.
 *
 * @returns Conservative fallback.
 */
function classifyWithStub(): PortDecision {
	return {
		kind: 'PORT_REQUIRED',
		reason: 'No heuristic matched and no classifier was configured; defaulting to port required.',
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
 * @returns Decision result from heuristics or classifier fallback.
 */
export async function decide(
	context: PortContext,
	options: {
		agentProvider?: AgentProvider
		targetWorkingDirectory?: string
		sourceWorkingDirectory?: string
		diffFilePath?: string
	} = {},
): Promise<PortDecision> {
	for (const heuristic of DECISION_HEURISTICS) {
		const decision = heuristic(context)

		if (decision) {
			return decision
		}
	}

	if (!options.agentProvider) {
		return classifyWithStub()
	}

	const classifierDecision = await options.agentProvider.decidePort({
		files: context.sourceChange.files,
		targetWorkingDirectory: options.targetWorkingDirectory ?? process.cwd(),
		sourceWorkingDirectory: options.sourceWorkingDirectory,
		diffFilePath: options.diffFilePath,
		pluginConfig: context.pluginConfig,
	})

	return {
		kind: classifierDecision.required ? 'PORT_REQUIRED' : 'PORT_NOT_REQUIRED',
		reason: classifierDecision.reason,
	}
}

import { DECISION_HEURISTICS } from './heuristics.ts'

import type { PortContext, PortDecision } from '../types.ts'

/**
 * Classifier fallback used when no fast heuristic can make a decision.
 *
 * @param _context - Decision context.
 * @returns Safe default until classifier is implemented.
 */
function classifyWithStub(_context: PortContext): PortDecision {
	return {
		kind: 'NEEDS_HUMAN',
		reason: 'No heuristic matched; LLM classifier not yet implemented.',
		signals: ['classifier-stub'],
	}
}

/**
 * Run the decision stage for a port run.
 *
 * @param context - Port run context.
 * @returns Decision result from heuristics or classifier fallback.
 */
export function decide(context: PortContext): PortDecision {
	for (const heuristic of DECISION_HEURISTICS) {
		const decision = heuristic(context)

		if (decision) {
			return decision
		}
	}

	return classifyWithStub(context)
}

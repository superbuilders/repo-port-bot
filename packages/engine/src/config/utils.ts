import type { DeterministicOperation } from '../types.ts'
import type { PortBotJsonConfig } from './types.ts'

/**
 * Collect deterministic operations from all config sections.
 *
 * Each config key (for example `sync`) maps its entries into tagged union
 * variants. Future config keys add their own mapping logic here.
 *
 * @param config - Parsed `port-bot.json` config.
 * @returns Ordered deterministic operations.
 */
export function collectDeterministicOperations(
	config: PortBotJsonConfig,
): DeterministicOperation[] {
	const operations: DeterministicOperation[] = []

	for (const entry of config.sync ?? []) {
		operations.push({ kind: 'sync', ...entry })
	}

	return operations
}

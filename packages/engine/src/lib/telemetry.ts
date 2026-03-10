import type { AggregatedTelemetry, TokenUsage } from '../types.ts'

const TOKEN_SCALE = 1000
const TOKEN_DECIMAL_PLACES = 1
const USD_DECIMAL_PLACES = 2

/**
 * Build an aggregate telemetry object from one stage trace payload.
 *
 * @param costUsd - Stage cost.
 * @param usage - Stage token usage.
 * @returns Aggregated telemetry or undefined when empty.
 */
export function toAggregatedTelemetry(
	costUsd: number | undefined,
	usage: TokenUsage | undefined,
): AggregatedTelemetry | undefined {
	if (costUsd === undefined && !usage) {
		return undefined
	}

	return {
		costUsd: costUsd ?? 0,
		usage: usage ?? {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
		},
	}
}

/**
 * Sum telemetry across multiple stage traces.
 *
 * @param traces - Stage traces.
 * @returns Aggregate telemetry or undefined when all traces are empty.
 */
export function sumStageTelemetry(
	traces: { costUsd?: number; usage?: TokenUsage }[],
): AggregatedTelemetry | undefined {
	let hasValue = false
	const aggregated: AggregatedTelemetry = {
		costUsd: 0,
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
		},
	}

	for (const trace of traces) {
		if (trace.costUsd !== undefined) {
			hasValue = true
			aggregated.costUsd += trace.costUsd
		}

		if (trace.usage) {
			hasValue = true
			aggregated.usage.inputTokens += trace.usage.inputTokens
			aggregated.usage.outputTokens += trace.usage.outputTokens
			aggregated.usage.cacheCreationInputTokens += trace.usage.cacheCreationInputTokens
			aggregated.usage.cacheReadInputTokens += trace.usage.cacheReadInputTokens
		}
	}

	return hasValue ? aggregated : undefined
}

/**
 * Sum two optional aggregated telemetry payloads.
 *
 * @param first - First aggregate.
 * @param second - Second aggregate.
 * @returns Combined telemetry or undefined when both are missing.
 */
export function sumAggregatedTelemetry(
	first: AggregatedTelemetry | undefined,
	second: AggregatedTelemetry | undefined,
): AggregatedTelemetry | undefined {
	if (!first && !second) {
		return undefined
	}

	return {
		costUsd: (first?.costUsd ?? 0) + (second?.costUsd ?? 0),
		usage: {
			inputTokens: (first?.usage.inputTokens ?? 0) + (second?.usage.inputTokens ?? 0),
			outputTokens: (first?.usage.outputTokens ?? 0) + (second?.usage.outputTokens ?? 0),
			cacheCreationInputTokens:
				(first?.usage.cacheCreationInputTokens ?? 0) +
				(second?.usage.cacheCreationInputTokens ?? 0),
			cacheReadInputTokens:
				(first?.usage.cacheReadInputTokens ?? 0) +
				(second?.usage.cacheReadInputTokens ?? 0),
		},
	}
}

/**
 * Compute total token count across all usage buckets.
 *
 * @param usage - Aggregated usage counters.
 * @returns Total token count.
 */
export function totalTokens(usage: AggregatedTelemetry['usage']): number {
	return (
		usage.inputTokens +
		usage.outputTokens +
		usage.cacheCreationInputTokens +
		usage.cacheReadInputTokens
	)
}

/**
 * Format USD cost for compact markdown display.
 *
 * @param costUsd - Dollar amount.
 * @returns Formatted currency string.
 */
export function formatUsd(costUsd: number): string {
	return `$${costUsd.toFixed(USD_DECIMAL_PLACES)}`
}

/**
 * Format token totals, using `k` notation for large values.
 *
 * @param tokens - Total tokens.
 * @returns Compact token count.
 */
export function formatTokenCount(tokens: number): string {
	if (tokens < TOKEN_SCALE) {
		return String(tokens)
	}

	return `${(tokens / TOKEN_SCALE).toFixed(TOKEN_DECIMAL_PLACES)}k`
}

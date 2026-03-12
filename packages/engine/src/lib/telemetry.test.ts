import { describe, expect, test } from 'bun:test'

import {
	formatTokenCount,
	formatUsd,
	inputOutputTokens,
	sumAggregatedTelemetry,
	sumStageTelemetry,
	toAggregatedTelemetry,
	totalTokens,
} from './telemetry.ts'

import type { AggregatedTelemetry, TokenUsage } from '../types.ts'

const INPUT_TOKENS = 1000
const OUTPUT_TOKENS = 200
const CACHE_CREATION_TOKENS = 100
const CACHE_READ_TOKENS = 50

const COST_A = 0.5
const COST_B = 0.3
const COST_FULL = 1
const COST_SUM = 0.8

const TRACE_A_INPUT = 100
const TRACE_A_OUTPUT = 50
const TRACE_B_INPUT = 200
const TRACE_B_OUTPUT = 100
const SUM_INPUT = 300
const SUM_OUTPUT = 150

const TOTAL_ALL_BUCKETS = 1350
const TOTAL_IO_ONLY = 1200

const FORMAT_COMPACT_1200 = '1.2K'
const FORMAT_COMPACT_100 = '100'
const FORMAT_COMPACT_1_5M = '1.5M'
const TOKEN_COUNT_1200 = 1200
const TOKEN_COUNT_100 = 100
const TOKEN_COUNT_1_5M = 1_500_000

const FORMAT_USD_HALF = '$0.50'
const FORMAT_USD_ROUNDED = '$1.23'
const FORMAT_USD_ZERO = '$0.00'
const USD_HALF = 0.5
const USD_ROUNDED_INPUT = 1.234

/**
 * @param overrides - Partial usage overrides.
 * @returns Token usage fixture.
 */
function makeUsage(overrides?: Partial<TokenUsage>): TokenUsage {
	return {
		inputTokens: INPUT_TOKENS,
		outputTokens: OUTPUT_TOKENS,
		cacheCreationInputTokens: CACHE_CREATION_TOKENS,
		cacheReadInputTokens: CACHE_READ_TOKENS,
		...overrides,
	}
}

describe('toAggregatedTelemetry', () => {
	test('returns undefined when both cost and usage are absent', () => {
		expect(toAggregatedTelemetry(undefined, undefined)).toBeUndefined()
	})

	test('returns telemetry when cost is provided', () => {
		const result = toAggregatedTelemetry(COST_A, undefined)

		expect(result).toBeDefined()
		expect(result!.costUsd).toBe(COST_A)
		expect(result!.usage.inputTokens).toBe(0)
	})

	test('returns telemetry when usage is provided', () => {
		const result = toAggregatedTelemetry(undefined, makeUsage())

		expect(result).toBeDefined()
		expect(result!.costUsd).toBe(0)
		expect(result!.usage.inputTokens).toBe(INPUT_TOKENS)
	})

	test('returns telemetry when both are provided', () => {
		const result = toAggregatedTelemetry(COST_FULL, makeUsage())

		expect(result!.costUsd).toBe(COST_FULL)
		expect(result!.usage.inputTokens).toBe(INPUT_TOKENS)
	})
})

describe('sumStageTelemetry', () => {
	test('returns undefined for empty traces', () => {
		expect(sumStageTelemetry([])).toBeUndefined()
	})

	test('returns undefined when all traces lack cost and usage', () => {
		expect(sumStageTelemetry([{}, {}])).toBeUndefined()
	})

	test('sums cost and usage across traces', () => {
		const result = sumStageTelemetry([
			{
				costUsd: COST_A,
				usage: makeUsage({ inputTokens: TRACE_A_INPUT, outputTokens: TRACE_A_OUTPUT }),
			},
			{
				costUsd: COST_B,
				usage: makeUsage({ inputTokens: TRACE_B_INPUT, outputTokens: TRACE_B_OUTPUT }),
			},
		])

		expect(result!.costUsd).toBeCloseTo(COST_SUM)
		expect(result!.usage.inputTokens).toBe(SUM_INPUT)
		expect(result!.usage.outputTokens).toBe(SUM_OUTPUT)
	})
})

describe('sumAggregatedTelemetry', () => {
	test('returns undefined when both are undefined', () => {
		expect(sumAggregatedTelemetry(undefined, undefined)).toBeUndefined()
	})

	test('returns first when second is undefined', () => {
		const first: AggregatedTelemetry = { costUsd: COST_FULL, usage: makeUsage() }

		expect(sumAggregatedTelemetry(first, undefined)!.costUsd).toBe(COST_FULL)
	})

	test('sums two aggregates', () => {
		const first: AggregatedTelemetry = {
			costUsd: COST_A,
			usage: makeUsage({ inputTokens: TRACE_A_INPUT }),
		}
		const second: AggregatedTelemetry = {
			costUsd: COST_B,
			usage: makeUsage({ inputTokens: TRACE_B_INPUT }),
		}
		const result = sumAggregatedTelemetry(first, second)

		expect(result!.costUsd).toBeCloseTo(COST_SUM)
		expect(result!.usage.inputTokens).toBe(SUM_INPUT)
	})
})

describe('totalTokens', () => {
	test('sums all four token buckets', () => {
		expect(totalTokens(makeUsage())).toBe(TOTAL_ALL_BUCKETS)
	})
})

describe('inputOutputTokens', () => {
	test('sums only input and output buckets', () => {
		expect(inputOutputTokens(makeUsage())).toBe(TOTAL_IO_ONLY)
	})
})

describe('formatUsd', () => {
	test('formats with two decimal places', () => {
		expect(formatUsd(USD_HALF)).toBe(FORMAT_USD_HALF)
		expect(formatUsd(USD_ROUNDED_INPUT)).toBe(FORMAT_USD_ROUNDED)
		expect(formatUsd(0)).toBe(FORMAT_USD_ZERO)
	})
})

describe('formatTokenCount', () => {
	test('formats compact token counts', () => {
		expect(formatTokenCount(TOKEN_COUNT_1200)).toBe(FORMAT_COMPACT_1200)
		expect(formatTokenCount(TOKEN_COUNT_100)).toBe(FORMAT_COMPACT_100)
		expect(formatTokenCount(TOKEN_COUNT_1_5M)).toBe(FORMAT_COMPACT_1_5M)
	})
})

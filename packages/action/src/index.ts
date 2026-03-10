import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DefaultArtifactClient } from '@actions/artifact'
import * as core from '@actions/core'
import {
	type AggregatedTelemetry,
	formatDuration,
	renderDecisionLogSummary,
	renderExecutionLogSummary,
} from '@repo-port-bot/engine'

import { runAction } from './run-action.ts'

const TOKEN_SCALE = 1000
const TOKEN_DECIMAL_PLACES = 1
const USD_DECIMAL_PLACES = 2

/**
 * Action entrypoint that runs the pipeline and publishes outputs.
 */
async function main(): Promise<void> {
	try {
		const result = await runAction()
		const artifactDirectory = join(process.cwd(), `port-bot-run-${result.runId}`)
		const executionToolCalls =
			result.execution?.trace.attempts.flatMap(attempt => attempt.trace.toolCallLog) ?? []
		const decisionToolCalls = result.decision.trace.toolCallLog
		const runResultPath = join(artifactDirectory, 'run-result.json')
		const executionToolCallsPath = join(artifactDirectory, 'tool-calls.json')
		const decisionToolCallsPath = join(artifactDirectory, 'decision-tool-calls.json')
		const artifactClient = new DefaultArtifactClient()
		let artifactUploaded = false

		await mkdir(artifactDirectory, { recursive: true })
		await writeFile(runResultPath, JSON.stringify(result, null, 2))
		await writeFile(executionToolCallsPath, JSON.stringify(executionToolCalls, null, 2))
		await writeFile(decisionToolCallsPath, JSON.stringify(decisionToolCalls, null, 2))

		if (process.env.ACTIONS_RUNTIME_TOKEN) {
			try {
				await artifactClient.uploadArtifact(
					`port-bot-run-${result.runId}`,
					[runResultPath, executionToolCallsPath, decisionToolCallsPath],
					artifactDirectory,
					{ retentionDays: 14 },
				)
				artifactUploaded = true
			} catch (artifactError) {
				const message =
					artifactError instanceof Error ? artifactError.message : String(artifactError)

				core.warning(`Failed to upload observability artifact: ${message}`)
			}
		} else {
			core.info(
				'Skipping observability artifact upload because ACTIONS_RUNTIME_TOKEN is unavailable.',
			)
		}

		core.setOutput('run-id', result.runId)
		core.setOutput('outcome', result.outcome)
		core.setOutput('pr-url', result.targetPullRequestUrl ?? '')
		core.setOutput('issue-url', result.followUpIssueUrl ?? '')
		core.setOutput('summary', result.summary)

		await writeActionSummary({
			result,
			artifactUploaded,
			decisionToolCalls,
			executionToolCalls,
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)

		core.setFailed(message)
	}
}

/**
 * Render and write the GitHub Actions summary.
 *
 * @param input - Summary rendering input.
 * @param input.result - Port run result.
 * @param input.artifactUploaded - Whether artifact upload succeeded.
 * @param input.decisionToolCalls - Decision tool call entries.
 * @param input.executionToolCalls - Execution tool call entries.
 */
async function writeActionSummary(input: {
	result: Awaited<ReturnType<typeof runAction>>
	artifactUploaded: boolean
	decisionToolCalls: unknown[]
	executionToolCalls: unknown[]
}): Promise<void> {
	const heading = input.result.sourceTitle ? `Port: ${input.result.sourceTitle}` : 'Port run'
	const outcomeLine = buildOutcomeLine(input.result)
	const executionModel = input.result.execution?.trace.model
	const model = executionModel ?? input.result.decision.trace.model
	const includeCostTelemetry = input.result.includeCostTelemetry !== false
	const decisionTelemetry = includeCostTelemetry ? input.result.telemetry?.decision : undefined
	const executionTelemetry = includeCostTelemetry ? input.result.telemetry?.execution : undefined
	const totalTelemetry = includeCostTelemetry ? input.result.telemetry?.total : undefined

	core.summary.addRaw(`# ${heading}\n\n`)
	core.summary.addRaw(`${outcomeLine}\n\n`)
	core.summary.addTable([
		[
			{ data: 'context', header: true },
			{ data: 'config', header: true },
			{ data: 'decision', header: true },
			{ data: 'execute', header: true },
			{ data: 'deliver', header: true },
			{ data: 'notify', header: true },
			{ data: '<b>total</b>', header: true },
		],
		[
			formatMs(input.result.stageTimings?.contextMs),
			formatMs(input.result.stageTimings?.configMs),
			formatMs(input.result.stageTimings?.decisionMs),
			formatMs(input.result.stageTimings?.executeMs),
			formatMs(input.result.stageTimings?.deliverMs),
			formatMs(input.result.stageTimings?.notifyMs),
			`<b>${formatMs(input.result.durationMs)}</b>`,
		],
	])

	const decisionTrace = input.result.decision.trace
	const decisionDuration =
		decisionTrace.durationMs !== undefined
			? ` · ${formatDuration(decisionTrace.durationMs)}`
			: ''
	const decisionTelemetryLabel = decisionTelemetry
		? ` · ${formatUsd(decisionTelemetry.costUsd)} · ${formatTokenCount(totalTokens(decisionTelemetry.usage))} tokens`
		: ''
	const decisionLabel = `Decision (${String(input.decisionToolCalls.length)} tool call${input.decisionToolCalls.length === 1 ? '' : 's'}${decisionDuration}${decisionTelemetryLabel})`
	const decisionLog = renderDecisionLogSummary(decisionTrace)

	core.summary.addRaw(
		[
			'',
			`<details><summary>${decisionLabel}</summary>`,
			'',
			`- Kind: \`${decisionTrace.source === 'classifier' ? input.result.decision.outcome.kind : `${input.result.decision.outcome.kind} (${decisionTrace.source})`}\``,
			`- Reason: ${input.result.decision.outcome.reason}`,
			decisionTrace.heuristicName
				? `- Heuristic: \`${decisionTrace.heuristicName}\``
				: undefined,
			decisionLog ? '' : undefined,
			decisionLog ? '<details><summary>Log</summary>' : undefined,
			decisionLog ? '' : undefined,
			decisionLog,
			decisionLog ? '' : undefined,
			decisionLog ? '</details>' : undefined,
			'',
			'</details>',
			'',
		]
			.filter(line => line !== undefined)
			.join('\n'),
	)

	if (input.result.execution) {
		const executionLog = renderExecutionLogSummary(input.result.execution)
		const execDuration =
			input.result.execution.trace.durationMs !== undefined
				? ` · ${formatDuration(input.result.execution.trace.durationMs)}`
				: ''
		const executionTelemetryLabel = executionTelemetry
			? ` · ${formatUsd(executionTelemetry.costUsd)} · ${formatTokenCount(totalTokens(executionTelemetry.usage))} tokens`
			: ''
		const executionLabel = `Execution (${String(input.executionToolCalls.length)} tool call${input.executionToolCalls.length === 1 ? '' : 's'}${execDuration}${executionTelemetryLabel})`

		core.summary.addRaw(
			[
				`<details><summary>${executionLabel}</summary>`,
				'',
				model ? `- Model: \`${model}\`` : undefined,
				input.artifactUploaded
					? `- Artifact: \`port-bot-run-${input.result.runId}\``
					: undefined,
				`- Run ID: \`${input.result.runId}\``,
				executionLog ? '' : undefined,
				executionLog ? '<details><summary>Log</summary>' : undefined,
				executionLog ? '' : undefined,
				executionLog,
				executionLog ? '' : undefined,
				executionLog ? '</details>' : undefined,
				'',
				'</details>',
				'',
			]
				.filter(line => line !== undefined)
				.join('\n'),
		)
	} else {
		core.summary.addRaw(
			[
				`<details><summary>Execution</summary>`,
				'',
				input.artifactUploaded
					? `- Artifact: \`port-bot-run-${input.result.runId}\``
					: undefined,
				`- Run ID: \`${input.result.runId}\``,
				'- _No execution (skipped or needs-human)_',
				'',
				'</details>',
				'',
			]
				.filter(line => line !== undefined)
				.join('\n'),
		)
	}

	if (totalTelemetry) {
		core.summary.addRaw(
			[
				'',
				`**Totals:** ${formatUsd(totalTelemetry.costUsd)} · ${formatTokenCount(totalTokens(totalTelemetry.usage))} tokens`,
				'',
			].join('\n'),
		)
	}

	await core.summary.write()
}

void main()

/**
 * Build a one-liner with short linked ref.
 *
 * @param result - Pipeline result.
 * @returns Markdown one-liner.
 */
function buildOutcomeLine(result: Awaited<ReturnType<typeof runAction>>): string {
	switch (result.outcome) {
		case 'pr_opened': {
			const link = result.targetPullRequestUrl
				? `[${shortRef(result.targetPullRequestUrl, 'pull')}](${result.targetPullRequestUrl})`
				: 'target PR'

			return `Ported to ${link}`
		}
		case 'draft_pr_opened': {
			const link = result.targetPullRequestUrl
				? `[${shortRef(result.targetPullRequestUrl, 'pull')}](${result.targetPullRequestUrl})`
				: 'target PR (draft)'

			return `Draft PR: ${link} — validation failed`
		}
		case 'needs_human': {
			const link = result.followUpIssueUrl
				? `[${shortRef(result.followUpIssueUrl, 'issues')}](${result.followUpIssueUrl})`
				: 'follow-up issue'

			return `Opened ${link} for manual review`
		}
		case 'skipped_not_required': {
			return 'Skipped — port not required'
		}
		case 'failed': {
			return 'Failed'
		}
		default: {
			return result.summary
		}
	}
}

/**
 * Extract a short `repo#N` reference from a GitHub URL.
 *
 * @param url - Full GitHub PR or issue URL.
 * @param kind - URL path segment (`pull` or `issues`).
 * @returns Short reference like `target-repo#6`.
 */
function shortRef(url: string, kind: 'pull' | 'issues'): string {
	const pattern = new RegExp(`github\\.com/[^/]+/([^/]+)/${kind}/(\\d+)`)
	const match = url.match(pattern)

	if (!match) {
		return url
	}

	return `${match[1]}#${match[2]}`
}

/**
 * Format milliseconds for display, returning 'N/A' when undefined.
 *
 * @param ms - Duration in milliseconds.
 * @returns Formatted string.
 */
function formatMs(ms: number | undefined): string {
	if (ms === undefined) {
		return 'N/A'
	}

	return formatDuration(ms)
}

/**
 * Sum token counters for compact summary rendering.
 *
 * @param usage - Aggregated usage counters.
 * @returns Total token count.
 */
function totalTokens(usage: AggregatedTelemetry['usage']): number {
	return (
		usage.inputTokens +
		usage.outputTokens +
		usage.cacheCreationInputTokens +
		usage.cacheReadInputTokens
	)
}

/**
 * Format USD value for summary labels.
 *
 * @param costUsd - Dollar amount.
 * @returns Formatted value.
 */
function formatUsd(costUsd: number): string {
	return `$${costUsd.toFixed(USD_DECIMAL_PLACES)}`
}

/**
 * Format token count using `k` notation for large values.
 *
 * @param tokens - Token count.
 * @returns Compact token string.
 */
function formatTokenCount(tokens: number): string {
	if (tokens < TOKEN_SCALE) {
		return String(tokens)
	}

	return `${(tokens / TOKEN_SCALE).toFixed(TOKEN_DECIMAL_PLACES)}k`
}

export { runAction } from './run-action.ts'

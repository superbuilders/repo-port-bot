import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DefaultArtifactClient } from '@actions/artifact'
import * as core from '@actions/core'
import {
	formatDuration,
	renderDecisionLogSummary,
	renderExecutionLogSummary,
} from '@repo-port-bot/engine'

import { runAction } from './run-action.ts'

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

		const heading = result.sourceTitle ? `Port: ${result.sourceTitle}` : 'Port run'
		const outcomeLine = buildOutcomeLine(result)
		const model = result.execution?.trace.model ?? result.decision.trace.model

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
				formatMs(result.stageTimings?.contextMs),
				formatMs(result.stageTimings?.configMs),
				formatMs(result.stageTimings?.decisionMs),
				formatMs(result.stageTimings?.executeMs),
				formatMs(result.stageTimings?.deliverMs),
				formatMs(result.stageTimings?.notifyMs),
				`<b>${formatMs(result.durationMs)}</b>`,
			],
		])

		const decisionTrace = result.decision.trace
		const decisionDuration =
			decisionTrace.durationMs !== undefined
				? ` · ${formatDuration(decisionTrace.durationMs)}`
				: ''
		const decisionLabel = `Decision (${String(decisionToolCalls.length)} tool call${decisionToolCalls.length === 1 ? '' : 's'}${decisionDuration})`
		const decisionLog = renderDecisionLogSummary(decisionTrace)

		core.summary.addRaw(
			[
				'',
				`<details><summary>${decisionLabel}</summary>`,
				'',
				`- Kind: \`${decisionTrace.source === 'classifier' ? result.decision.outcome.kind : `${result.decision.outcome.kind} (${decisionTrace.source})`}\``,
				`- Reason: ${result.decision.outcome.reason}`,
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

		if (result.execution) {
			const executionLog = renderExecutionLogSummary(result.execution)
			const execDuration =
				result.execution.trace.durationMs !== undefined
					? ` · ${formatDuration(result.execution.trace.durationMs)}`
					: ''
			const executionLabel = `Execution (${String(executionToolCalls.length)} tool call${executionToolCalls.length === 1 ? '' : 's'}${execDuration})`

			core.summary.addRaw(
				[
					`<details><summary>${executionLabel}</summary>`,
					'',
					model ? `- Model: \`${model}\`` : undefined,
					artifactUploaded ? `- Artifact: \`port-bot-run-${result.runId}\`` : undefined,
					`- Run ID: \`${result.runId}\``,
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
					model ? `- Model: \`${model}\`` : undefined,
					artifactUploaded ? `- Artifact: \`port-bot-run-${result.runId}\`` : undefined,
					`- Run ID: \`${result.runId}\``,
					'- _No execution (skipped or needs-human)_',
					'',
					'</details>',
					'',
				]
					.filter(line => line !== undefined)
					.join('\n'),
			)
		}

		core.summary.addRaw(`\n<sub>Job summary generated at run-time</sub>\n`)
		await core.summary.write()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)

		core.setFailed(message)
	}
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

export { runAction } from './run-action.ts'

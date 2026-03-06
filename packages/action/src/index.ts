import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { DefaultArtifactClient } from '@actions/artifact'
import * as core from '@actions/core'
import { formatDuration } from '@repo-port-bot/engine'

import { runAction } from './run-action.ts'

/**
 * Action entrypoint that runs the pipeline and publishes outputs.
 */
async function main(): Promise<void> {
	try {
		const result = await runAction()
		const artifactDirectory = join(process.cwd(), `port-bot-run-${result.runId}`)
		const toolCalls =
			result.execution?.trace.attempts.flatMap(attempt => attempt.trace.toolCallLog) ?? []
		const decisionToolCalls = result.decision.trace.toolCallLog
		const runResultPath = join(artifactDirectory, 'run-result.json')
		const toolCallsPath = join(artifactDirectory, 'tool-calls.json')
		const decisionToolCallsPath = join(artifactDirectory, 'decision-tool-calls.json')
		const artifactClient = new DefaultArtifactClient()
		let artifactUploaded = false

		await mkdir(artifactDirectory, { recursive: true })
		await writeFile(runResultPath, JSON.stringify(result, null, 2))
		await writeFile(toolCallsPath, JSON.stringify(toolCalls, null, 2))
		await writeFile(decisionToolCallsPath, JSON.stringify(decisionToolCalls, null, 2))

		if (process.env.ACTIONS_RUNTIME_TOKEN) {
			try {
				await artifactClient.uploadArtifact(
					`port-bot-run-${result.runId}`,
					[runResultPath, toolCallsPath, decisionToolCallsPath],
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
		core.summary.addRaw(
			[
				'',
				'<details><summary>Decision & diagnostics</summary>',
				'',
				`- Kind: \`${result.decision.outcome.kind}\``,
				`- Reason: ${result.decision.outcome.reason}`,
				`- Decision source: \`${result.decision.trace.source}\``,
				result.decision.trace.heuristicName
					? `- Heuristic: \`${result.decision.trace.heuristicName}\``
					: undefined,
				result.decision.trace.model
					? `- Decision model: \`${result.decision.trace.model}\``
					: undefined,
				result.execution?.trace.model
					? `- Model: ${result.execution.trace.model}`
					: undefined,
				artifactUploaded
					? `- Artifact: \`port-bot-run-${result.runId}\``
					: '- Artifact: skipped (runtime token unavailable)',
				`- Tool calls: ${String(toolCalls.length)}`,
				`- Decision tool calls: ${String(decisionToolCalls.length)}`,
				`- Run ID: \`${result.runId}\``,
				'',
				'</details>',
				'',
			]
				.filter(line => line !== undefined)
				.join('\n'),
		)
		await core.summary.write()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)

		core.setFailed(message)
	}
}

void main()

/**
 * Build a one-liner with short linked ref and duration.
 *
 * @param result - Pipeline result.
 * @returns Markdown one-liner.
 */
function buildOutcomeLine(result: Awaited<ReturnType<typeof runAction>>): string {
	const duration = formatMs(result.durationMs)

	switch (result.outcome) {
		case 'pr_opened': {
			const link = result.targetPullRequestUrl
				? `[${shortRef(result.targetPullRequestUrl, 'pull')}](${result.targetPullRequestUrl})`
				: 'target PR'

			return `Ported to ${link} (${duration})`
		}
		case 'draft_pr_opened': {
			const link = result.targetPullRequestUrl
				? `[${shortRef(result.targetPullRequestUrl, 'pull')}](${result.targetPullRequestUrl})`
				: 'target PR (draft)'

			return `Draft PR: ${link} — validation failed (${duration})`
		}
		case 'needs_human': {
			const link = result.followUpIssueUrl
				? `[${shortRef(result.followUpIssueUrl, 'issues')}](${result.followUpIssueUrl})`
				: 'follow-up issue'

			return `Opened ${link} for manual review (${duration})`
		}
		case 'skipped_not_required': {
			return `Skipped (${duration})`
		}
		case 'failed': {
			return `Failed (${duration})`
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

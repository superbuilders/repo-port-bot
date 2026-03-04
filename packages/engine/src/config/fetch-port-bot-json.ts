import { decodePortBotJson } from './port-bot-json.decoder.ts'

import type { Octokit } from '@octokit/rest'

import type { PortBotJsonConfig } from './types.ts'

interface FetchPortBotJsonOptions {
	octokit: Octokit
	owner: string
	repo: string
	ref: string
}

const NOT_FOUND_STATUS = 404

/**
 * Check whether an error has a given HTTP status code.
 *
 * @param error - Unknown thrown value.
 * @param status - HTTP status to match.
 * @returns True when status matches.
 */
function isHttpStatusError(error: unknown, status: number): boolean {
	if (!error || typeof error !== 'object') {
		return false
	}

	return (error as { status?: unknown }).status === status
}

/**
 * Fetch and decode optional `port-bot.json` from source repo at a commit ref.
 *
 * @param options - Fetch options.
 * @returns Decoded config or undefined when file does not exist / cannot be read.
 */
export async function fetchPortBotJson(
	options: FetchPortBotJsonOptions,
): Promise<PortBotJsonConfig | undefined> {
	try {
		const response = await options.octokit.rest.repos.getContent({
			owner: options.owner,
			repo: options.repo,
			path: 'port-bot.json',
			ref: options.ref,
		})
		const payload = response.data

		if (Array.isArray(payload) || payload.type !== 'file' || !payload.content) {
			console.warn(
				'repo-port-bot: `port-bot.json` exists but is not a normal file; skipping.',
			)

			return undefined
		}

		const decodedText = Buffer.from(payload.content, 'base64').toString('utf8')
		const parsed = JSON.parse(decodedText) as unknown

		return decodePortBotJson(parsed)
	} catch (error) {
		if (isHttpStatusError(error, NOT_FOUND_STATUS)) {
			return undefined
		}

		const message = error instanceof Error ? error.message : String(error)

		console.warn(
			`repo-port-bot: failed to fetch \`port-bot.json\` at ${options.owner}/${options.repo}@${options.ref}: ${message}`,
		)

		return undefined
	}
}

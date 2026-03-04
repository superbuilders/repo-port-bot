import { createConsoleLogger } from '@repo-port-bot/logger'

import { decodePortBotJson } from './port-bot-json.decoder.ts'
import { PORT_BOT_JSON_FILENAME } from './types.ts'

import type { Logger } from '@repo-port-bot/logger'

import type { GitHubReader } from '../types.ts'
import type { PortBotJsonConfig } from './types.ts'

interface FetchPortBotJsonOptions {
	reader: GitHubReader
	owner: string
	repo: string
	ref: string
	logger?: Logger
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
	const logger = options.logger ?? createConsoleLogger('info')

	try {
		const content = await options.reader.getFileContent(
			options.owner,
			options.repo,
			PORT_BOT_JSON_FILENAME,
			options.ref,
		)

		if (content === undefined) {
			return undefined
		}

		const parsed = JSON.parse(content) as unknown

		return decodePortBotJson(parsed)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)

		logger.warn(
			`repo-port-bot: failed to fetch \`port-bot.json\` at ${options.owner}/${options.repo}@${options.ref}: ${message}`,
		)

		return undefined
	}
}

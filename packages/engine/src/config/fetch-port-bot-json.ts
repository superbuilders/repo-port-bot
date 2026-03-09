import { createConsoleLogger } from '@repo-port-bot/logger'

import { decodePortBotJson } from './port-bot-json.decoder.ts'
import { PORT_BOT_JSON_FILENAMES } from './types.ts'

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
 * Fetch and decode optional port-bot config from source repo at a commit ref.
 *
 * @param options - Fetch options.
 * @returns Decoded config or undefined when file does not exist / cannot be read.
 */
export async function fetchPortBotJson(
	options: FetchPortBotJsonOptions,
): Promise<PortBotJsonConfig | undefined> {
	const logger = options.logger ?? createConsoleLogger('info')

	for (const path of PORT_BOT_JSON_FILENAMES) {
		try {
			const content = await options.reader.getFileContent(
				options.owner,
				options.repo,
				path,
				options.ref,
			)

			if (content !== undefined) {
				const parsed = JSON.parse(content) as unknown

				return decodePortBotJson(parsed)
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)

			logger.warn(
				`repo-port-bot: failed to fetch \`${path}\` at ${options.owner}/${options.repo}@${options.ref}: ${message}`,
			)

			return undefined
		}
	}

	return undefined
}

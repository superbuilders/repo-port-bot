import * as core from '@actions/core'
import { shouldLog } from '@repo-port-bot/logger'

import type { LogLevel, Logger } from '@repo-port-bot/logger'

/**
 * Create a logger backed by GitHub Actions core logging methods.
 *
 * @param level - Minimum enabled level.
 * @returns Actions-aware logger.
 */
export function createActionsLogger(level: LogLevel): Logger {
	return {
		error(message, ...args) {
			if (!shouldLog(level, 'error')) {
				return
			}

			core.error([message, ...args.map(String)].join(' '))
		},
		warn(message, ...args) {
			if (!shouldLog(level, 'warn')) {
				return
			}

			core.warning([message, ...args.map(String)].join(' '))
		},
		info(message, ...args) {
			if (!shouldLog(level, 'info')) {
				return
			}

			core.info([message, ...args.map(String)].join(' '))
		},
		debug(message, ...args) {
			if (!shouldLog(level, 'debug')) {
				return
			}

			core.debug([message, ...args.map(String)].join(' '))
		},
		group(label) {
			if (!shouldLog(level, 'info')) {
				return
			}

			core.startGroup(label)
		},
		groupEnd() {
			if (!shouldLog(level, 'info')) {
				return
			}

			core.endGroup()
		},
	}
}

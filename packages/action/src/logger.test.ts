import { describe, expect, test } from 'bun:test'

import { createActionsLogger } from './logger.ts'

describe('createActionsLogger', () => {
	test('returns a logger that can be invoked without throwing', () => {
		const logger = createActionsLogger('info')

		expect(() => {
			logger.error('error')
			logger.warn('warn')
			logger.info('info')
			logger.debug('debug')
			logger.group('group')
			logger.groupEnd()
		}).not.toThrow()
	})
})

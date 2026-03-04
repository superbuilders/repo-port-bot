import { afterEach, describe, expect, mock, test } from 'bun:test'

import {
	createConsoleLogger,
	formatPortBotExecuteAttemptLine,
	formatPortBotLine,
	formatPortBotStageLine,
	shouldLog,
} from './index.ts'

afterEach(() => {
	mock.restore()
})

describe('shouldLog', () => {
	test('allows entries at or above configured severity', () => {
		expect(shouldLog('info', 'error')).toBe(true)
		expect(shouldLog('info', 'warn')).toBe(true)
		expect(shouldLog('info', 'info')).toBe(true)
		expect(shouldLog('info', 'debug')).toBe(false)
	})

	test('enforces strict level ordering for all levels', () => {
		expect(shouldLog('error', 'error')).toBe(true)
		expect(shouldLog('error', 'warn')).toBe(false)
		expect(shouldLog('warn', 'error')).toBe(true)
		expect(shouldLog('warn', 'info')).toBe(false)
		expect(shouldLog('debug', 'debug')).toBe(true)
	})
})

describe('createConsoleLogger', () => {
	test('suppresses debug entries when level is info', () => {
		const infoSpy = mock(() => {})
		const debugSpy = mock(() => {})

		console.info = infoSpy as never
		console.debug = debugSpy as never

		const logger = createConsoleLogger('info')

		logger.info('info message')
		logger.debug('debug message')

		expect(infoSpy).toHaveBeenCalledTimes(1)
		expect(debugSpy).toHaveBeenCalledTimes(0)
	})

	test('routes log methods to matching console methods', () => {
		const errorSpy = mock(() => {})
		const warnSpy = mock(() => {})
		const infoSpy = mock(() => {})
		const debugSpy = mock(() => {})

		console.error = errorSpy as never
		console.warn = warnSpy as never
		console.info = infoSpy as never
		console.debug = debugSpy as never

		const logger = createConsoleLogger('debug')

		logger.error('error', 'x')
		logger.warn('warn', 'y')
		logger.info('info', 'z')
		logger.debug('debug', 'w')

		expect(errorSpy).toHaveBeenCalledWith('error', 'x')
		expect(warnSpy).toHaveBeenCalledWith('warn', 'y')
		expect(infoSpy).toHaveBeenCalledWith('info', 'z')
		expect(debugSpy).toHaveBeenCalledWith('debug', 'w')
	})

	test('always emits error regardless of minimum level', () => {
		const errorSpy = mock(() => {})
		const warnSpy = mock(() => {})

		console.error = errorSpy as never
		console.warn = warnSpy as never

		const logger = createConsoleLogger('error')

		logger.error('fatal')
		logger.warn('muted')

		expect(errorSpy).toHaveBeenCalledTimes(1)
		expect(warnSpy).toHaveBeenCalledTimes(0)
	})

	test('emits groups only at debug level', () => {
		const groupSpy = mock(() => {})
		const groupEndSpy = mock(() => {})

		console.group = groupSpy as never
		console.groupEnd = groupEndSpy as never

		const infoLogger = createConsoleLogger('info')
		const debugLogger = createConsoleLogger('debug')

		infoLogger.group('hidden')
		infoLogger.groupEnd()
		debugLogger.group('visible')
		debugLogger.groupEnd()

		expect(groupSpy).toHaveBeenCalledTimes(1)
		expect(groupEndSpy).toHaveBeenCalledTimes(1)
	})
})

describe('port-bot line formatters', () => {
	test('formats generic lines and omits undefined fields', () => {
		const line = formatPortBotLine({
			runId: 'run-xyz',
			fields: {
				stage: 'decision',
				kind: 'PORT_REQUIRED',
				note: undefined,
				attempts: 3,
			},
		})

		expect(line).toBe('[port-bot] run=run-xyz stage=decision kind=PORT_REQUIRED attempts=3')
	})

	test('formats generic line with no fields', () => {
		const line = formatPortBotLine({
			runId: 'run-empty',
			fields: {},
		})

		expect(line).toBe('[port-bot] run=run-empty')
	})

	test('formats stage lines with run id and fields', () => {
		const line = formatPortBotStageLine({
			runId: 'run-123',
			stage: 'deliver',
			fields: {
				outcome: 'pr_opened',
				deliverMs: 42,
			},
		})

		expect(line).toBe('[port-bot] run=run-123 stage=deliver outcome=pr_opened deliverMs=42')
	})

	test('formats execute attempt lines consistently', () => {
		const line = formatPortBotExecuteAttemptLine({
			runId: 'run-456',
			attempt: 2,
			maxAttempts: 3,
			touched: 7,
			validation: 'fail',
			durationMs: 150,
		})

		expect(line).toBe(
			'[port-bot] run=run-456 stage=execute attempt=2/3 touched=7 validation=fail durationMs=150',
		)
	})

	test('formats execute attempt line for error validation', () => {
		const line = formatPortBotExecuteAttemptLine({
			runId: 'run-err',
			attempt: 1,
			maxAttempts: 3,
			touched: 0,
			validation: 'error',
			durationMs: 1,
		})

		expect(line).toBe(
			'[port-bot] run=run-err stage=execute attempt=1/3 touched=0 validation=error durationMs=1',
		)
	})
})

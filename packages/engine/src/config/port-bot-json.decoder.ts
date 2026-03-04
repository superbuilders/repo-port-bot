import { array, object, optional, record, string } from 'decoders'

import type { PortBotJsonConfig } from './types.ts'

const portBotJsonConventionsDecoder = object({
	naming: optional(string),
})

const portBotJsonConfigDecoder = object({
	target: optional(string),
	ignore: optional(array(string)),
	validation: optional(array(string)),
	mapping: optional(record(string)),
	conventions: optional(portBotJsonConventionsDecoder),
	prompt: optional(string),
})

/**
 * Decode untrusted `port-bot.json` input into a validated config object.
 *
 * @param input - Unknown input from JSON parsing or external source.
 * @returns Decoded config with validated field types.
 */
export function decodePortBotJson(input: unknown): PortBotJsonConfig {
	return portBotJsonConfigDecoder.verify(input)
}

/**
 * Parse and decode optional `port-bot.json` input from object or JSON string.
 *
 * @param portBotJson - Raw object, raw JSON string, or undefined.
 * @returns Decoded config object. Empty object when input is undefined.
 */
export function parseAndDecodePortBotJson(
	portBotJson?: PortBotJsonConfig | string,
): PortBotJsonConfig {
	if (!portBotJson) {
		return {}
	}

	if (typeof portBotJson === 'string') {
		try {
			const parsed = JSON.parse(portBotJson) as unknown

			return decodePortBotJson(parsed)
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new Error('Invalid port-bot.json content. Expected valid JSON.')
			}

			throw error
		}
	}

	return decodePortBotJson(portBotJson)
}

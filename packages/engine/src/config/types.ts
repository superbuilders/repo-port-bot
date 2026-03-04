/**
 * Filename expected at the root of a source repository.
 */
export const PORT_BOT_JSON_FILENAME = 'port-bot.json'

export interface PortBotJsonConventions {
	naming?: string
}

export interface PortBotJsonConfig {
	target?: string
	ignore?: string[]
	validation?: string[]
	mapping?: Record<string, string>
	conventions?: PortBotJsonConventions
	prompt?: string
}

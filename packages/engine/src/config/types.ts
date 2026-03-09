/**
 * Supported config filenames searched in precedence order.
 */
export const PORT_BOT_JSON_FILENAMES = [
	'port-bot.json',
	'.port-bot.json',
	'repo-port-bot.json',
	'.repo-port-bot.json',
	'.github/port-bot.json',
	'.github/repo-port-bot.json',
] as const

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

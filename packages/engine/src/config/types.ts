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

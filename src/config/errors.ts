import { z } from 'zod'

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export const toConfigError = (error: unknown, configPath: string): ConfigError => {
  if (error instanceof ConfigError) return error
  if (error instanceof z.ZodError) {
    return new ConfigError(`Invalid config: ${configPath}\n${z.prettifyError(error)}`)
  }
  if (error instanceof Error) return new ConfigError(error.message)
  return new ConfigError(String(error))
}

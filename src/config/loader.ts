import type { RouterOptions } from '../types'
import { interpolateEnvVars } from './env'
import { ConfigError, toConfigError } from './errors'
import { parseConfig } from './schema'
import { readRuntimeState } from './state'

const isENOENT = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'

export const loadConfig = async (configPath: string, authDir: string) => {
  let text: string
  try {
    text = await Bun.file(configPath).text()
  } catch (error) {
    if (isENOENT(error)) {
      throw new ConfigError(`Config file not found: ${configPath}\nCreate it or pass -c <path>.`)
    }
    throw error
  }

  let parsedYaml: unknown
  try {
    parsedYaml = Bun.YAML.parse(text)
  } catch (error) {
    throw new ConfigError(
      `Invalid YAML in ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const interpolated = interpolateEnvVars(parsedYaml)

  let options: RouterOptions
  try {
    options = parseConfig(interpolated)
  } catch (error) {
    throw toConfigError(error, configPath)
  }

  const state = await readRuntimeState(authDir)
  return { options, state }
}

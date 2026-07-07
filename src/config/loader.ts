import { interpolateEnvVars } from './env'
import { parseConfig } from './schema'
import { readRuntimeState } from './state'

export const loadConfig = async (configPath: string, authDir: string) => {
  let text: string
  try {
    text = await Bun.file(configPath).text()
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Config file not found: ${configPath}\nCreate it or pass -c <path>.`)
    }
    throw error
  }
  const parsed = Bun.YAML.parse(text)
  const interpolated = interpolateEnvVars(parsed)
  const options = parseConfig(interpolated)
  const state = await readRuntimeState(authDir)
  return { options, state }
}

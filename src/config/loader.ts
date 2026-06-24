import { interpolateEnvVars } from './env'
import { parseConfig } from './schema'
import { readRuntimeState } from './state'

export const loadConfig = async (configPath: string, authDir: string) => {
  const text = await Bun.file(configPath).text()
  const parsed = Bun.YAML.parse(text)
  const interpolated = interpolateEnvVars(parsed)
  const options = parseConfig(interpolated)
  const state = await readRuntimeState(authDir)
  return { options, state }
}

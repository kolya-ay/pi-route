import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// XDG Base Directory spec: use the env var only when set to an *absolute* path;
// otherwise fall back to the $HOME-relative default.
const xdgDir = (envVar: string, fallback: string): string => {
  const value = process.env[envVar]
  if (value !== undefined && value !== '' && isAbsolute(value)) return value
  return join(homedir(), fallback)
}

export const xdgConfigHome = (): string => xdgDir('XDG_CONFIG_HOME', '.config')
export const xdgDataHome = (): string => xdgDir('XDG_DATA_HOME', '.local/share')

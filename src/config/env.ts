import { homedir } from 'node:os'
import { join } from 'node:path'

export type EnvConfig = {
  port: number
  host: string
  tokens: string[]
  configPath: string
  authDir: string
}

const parsePort = (raw: string | undefined): number => {
  if (raw === undefined) return 3000
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`PI_ROUTE_PORT must be a valid port (1-65535), got "${raw}"`)
  }
  return n
}

export const readEnvConfig = (): EnvConfig => {
  const rawAuth = process.env.PI_ROUTE_AUTH ?? '~/.config/pi-route/auth'
  const authDir = rawAuth.startsWith('~/') ? join(homedir(), rawAuth.slice(2)) : rawAuth
  return {
    port: parsePort(process.env.PI_ROUTE_PORT),
    host: process.env.PI_ROUTE_HOST ?? '127.0.0.1',
    tokens: (process.env.PI_ROUTE_TOKEN ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    configPath: process.env.PI_ROUTE_CONFIG ?? './router.yaml',
    authDir
  }
}

export const interpolateEnvVars = (obj: unknown): unknown => {
  if (typeof obj === 'string') {
    if (!obj.startsWith('$')) return obj
    const name = obj.slice(1)
    const value = process.env[name]
    if (value === undefined) throw new Error(`Environment variable "${name}" is not set`)
    return value
  }
  if (Array.isArray(obj)) return obj.map(interpolateEnvVars)
  if (obj !== null && typeof obj === 'object') {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, interpolateEnvVars(v)])
    )
  }
  return obj
}

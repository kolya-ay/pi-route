import { homedir } from 'node:os'
import { join } from 'node:path'

export type EnvConfig = {
  port: number
  host: string
  tokens: string[]
  configPath: string
  authDir: string
  // Bun.serve idle timeout in seconds. Default 120 (Bun's default of 10 kills
  // slow upstreams + multi-request keep-alive clients like Claude Code).
  // 0 disables Bun's idle timeout (HTTP/1.1 only). Cap is 255 per Bun's API.
  idleTimeout: number
  otlpUrl: string
  capturePrompts: boolean
  captureMaxBytes: number
  serviceName: string
}

const parsePort = (raw: string | undefined): number => {
  if (raw === undefined) return 3000
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) {
    throw new Error(`PI_ROUTE_PORT must be a valid port (1-65535), got "${raw}"`)
  }
  return n
}

const parseIdleTimeout = (raw: string | undefined): number => {
  if (raw === undefined) return 120
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new Error(`PI_ROUTE_IDLE_TIMEOUT must be an integer 0-255 seconds, got "${raw}"`)
  }
  return n
}

const parseCaptureMaxBytes = (raw: string | undefined): number => {
  if (raw === undefined) return 65536
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1024) {
    throw new Error(`PI_ROUTE_CAPTURE_MAX_BYTES must be an integer >= 1024, got "${raw}"`)
  }
  return n
}

const resolveOtlpUrl = (): string => {
  if (process.env.PI_ROUTE_OTLP_URL) return process.env.PI_ROUTE_OTLP_URL
  const port = process.env.PI_ROUTE_OTLP_PORT
  if (port) return `http://localhost:${port}`
  return ''
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
    authDir,
    idleTimeout: parseIdleTimeout(process.env.PI_ROUTE_IDLE_TIMEOUT),
    otlpUrl: resolveOtlpUrl(),
    capturePrompts: process.env.PI_ROUTE_CAPTURE_PROMPTS === '1',
    captureMaxBytes: parseCaptureMaxBytes(process.env.PI_ROUTE_CAPTURE_MAX_BYTES),
    serviceName: process.env.PI_ROUTE_SERVICE_NAME ?? 'pi-route'
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

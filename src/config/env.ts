import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { xdgConfigHome, xdgStateHome } from './xdg'

export type EnvConfig = {
  port: number
  host: string
  authToken?: string
  configPath: string
  stateDir: string
  // Bun.serve idle timeout in seconds. Default 120 (Bun's default of 10 kills
  // slow upstreams + multi-request keep-alive clients like Claude Code).
  // 0 disables Bun's idle timeout (HTTP/1.1 only). Cap is 255 per Bun's API.
  idleTimeout: number
  otlpUrl: string
  capturePrompts: boolean
  captureMaxBytes: number
  serviceName: string
  maxBodyBytes: number
}

export type EnvPathOverrides = {
  configPath?: string
  stateDir?: string
  port?: number
  host?: string
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

const parseMaxBodyBytes = (raw: string | undefined): number => {
  if (raw === undefined) return 50 * 1024 * 1024
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1024) {
    throw new Error(`PI_ROUTE_MAX_BODY_BYTES must be an integer >= 1024, got "${raw}"`)
  }
  return n
}

const resolveOtlpUrl = (): string => {
  if (process.env.PI_ROUTE_OTLP_URL) return process.env.PI_ROUTE_OTLP_URL
  const port = process.env.PI_ROUTE_OTLP_PORT
  if (port) return `http://localhost:${port}`
  return ''
}

const expandHomeDir = (path: string): string =>
  path.startsWith('~/') ? join(homedir(), path.slice(2)) : path

const resolveAuthToken = (): string | undefined => {
  const fromEnv = process.env.PI_ROUTE_AUTH_TOKEN
  if (fromEnv) return fromEnv
  const credDir = process.env.CREDENTIALS_DIRECTORY
  if (credDir) {
    const path = join(credDir, 'pi_route_token')
    if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  }
  return undefined
}

// euid 0 = a bare `sudo pi-route serve` with no systemd. The shipped system unit
// runs as a non-root user and sets paths explicitly, so this only catches the
// hand-run-as-root case.
const isSystemMode = (): boolean => typeof process.getuid === 'function' && process.getuid() === 0

const resolveConfigPath = (override: string | undefined): string => {
  const explicit = override ?? process.env.PI_ROUTE_CONFIG
  if (explicit) return expandHomeDir(explicit)
  if (isSystemMode()) return '/etc/pi-route.yml'
  return join(xdgConfigHome(), 'pi-route.yml')
}

const resolveStateDir = (override: string | undefined): string => {
  const explicit = override ?? process.env.PI_ROUTE_STATE
  if (explicit) return expandHomeDir(explicit)
  const systemd = process.env.STATE_DIRECTORY
  if (systemd) return systemd.split(':')[0] as string
  if (isSystemMode()) return '/var/lib/pi-route'
  return join(xdgStateHome(), 'pi-route')
}

export const readEnvConfig = (overrides: EnvPathOverrides = {}): EnvConfig => {
  const configPath = resolveConfigPath(overrides.configPath)
  const stateDir = resolveStateDir(overrides.stateDir)
  const authToken = resolveAuthToken()
  return {
    port: overrides.port ?? parsePort(process.env.PI_ROUTE_PORT),
    host: overrides.host ?? process.env.PI_ROUTE_HOST ?? '127.0.0.1',
    ...(authToken !== undefined && { authToken }),
    configPath,
    stateDir,
    idleTimeout: parseIdleTimeout(process.env.PI_ROUTE_IDLE_TIMEOUT),
    otlpUrl: resolveOtlpUrl(),
    capturePrompts: process.env.PI_ROUTE_CAPTURE_PROMPTS === '1',
    captureMaxBytes: parseCaptureMaxBytes(process.env.PI_ROUTE_CAPTURE_MAX_BYTES),
    serviceName: process.env.PI_ROUTE_SERVICE_NAME ?? 'pi-route',
    maxBodyBytes: parseMaxBodyBytes(process.env.PI_ROUTE_MAX_BODY_BYTES)
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

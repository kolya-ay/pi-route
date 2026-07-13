import { afterEach, beforeEach, describe, expect, it, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { interpolateEnvVars, readEnvConfig } from './env'

describe('interpolateEnvVars', () => {
  afterEach(() => {
    delete process.env.FOO
    delete process.env.X
  })
  test('substitutes $VAR in strings', () => {
    process.env.FOO = 'bar'
    expect(interpolateEnvVars({ key: '$FOO' })).toEqual({ key: 'bar' })
  })
  test('throws on missing env var', () => {
    delete process.env.MISSING_XYZ
    expect(() => interpolateEnvVars('$MISSING_XYZ')).toThrow(/MISSING_XYZ/)
  })
  test('leaves non-$ strings alone', () => {
    expect(interpolateEnvVars('plain text')).toBe('plain text')
  })
  test('recurses into objects and arrays', () => {
    process.env.X = '1'
    expect(interpolateEnvVars({ a: ['$X', { b: '$X' }] })).toEqual({ a: ['1', { b: '1' }] })
  })
})

describe('readEnvConfig', () => {
  afterEach(() => {
    delete process.env.PI_ROUTE_PORT
    delete process.env.PI_ROUTE_HOST
    delete process.env.PI_ROUTE_AUTH_TOKEN
    delete process.env.CREDENTIALS_DIRECTORY
    delete process.env.PI_ROUTE_CONFIG
    delete process.env.PI_ROUTE_STATE
    delete process.env.STATE_DIRECTORY
    delete process.env.PI_ROUTE_IDLE_TIMEOUT
  })
  test('defaults', () => {
    delete process.env.PI_ROUTE_PORT
    delete process.env.PI_ROUTE_HOST
    delete process.env.PI_ROUTE_AUTH_TOKEN
    delete process.env.CREDENTIALS_DIRECTORY
    delete process.env.PI_ROUTE_CONFIG
    delete process.env.PI_ROUTE_STATE
    delete process.env.STATE_DIRECTORY
    delete process.env.PI_ROUTE_IDLE_TIMEOUT
    delete process.env.XDG_CONFIG_HOME
    delete process.env.XDG_STATE_HOME
    const e = readEnvConfig()
    expect(e.port).toBe(3000)
    expect(e.host).toBe('127.0.0.1')
    expect(e.authToken).toBeUndefined()
    expect(e.configPath).toBe(join(homedir(), '.config/pi-route.yml'))
    expect(e.stateDir).toBe(join(homedir(), '.local/state/pi-route'))
    expect(e.idleTimeout).toBe(120)
  })
  test('overrides via env', () => {
    process.env.PI_ROUTE_PORT = '3030'
    process.env.PI_ROUTE_HOST = '0.0.0.0'
    process.env.PI_ROUTE_AUTH_TOKEN = 'sk-secret'
    process.env.PI_ROUTE_CONFIG = '/tmp/r.yaml'
    process.env.PI_ROUTE_STATE = '/tmp/state'
    process.env.PI_ROUTE_IDLE_TIMEOUT = '30'
    const e = readEnvConfig()
    expect(e.port).toBe(3030)
    expect(e.host).toBe('0.0.0.0')
    expect(e.authToken).toBe('sk-secret')
    expect(e.configPath).toBe('/tmp/r.yaml')
    expect(e.stateDir).toBe('/tmp/state')
    expect(e.idleTimeout).toBe(30)
  })
  test('reads the auth token from a systemd credential file when the env var is unset', () => {
    delete process.env.PI_ROUTE_AUTH_TOKEN
    const dir = mkdtempSync(join(tmpdir(), 'pi-route-cred-'))
    writeFileSync(join(dir, 'pi_route_token'), 'sk-from-file\n')
    process.env.CREDENTIALS_DIRECTORY = dir
    expect(readEnvConfig().authToken).toBe('sk-from-file')
  })
  test('expands tildes in env paths', () => {
    process.env.PI_ROUTE_CONFIG = '~/router.yaml'
    process.env.PI_ROUTE_STATE = '~/.state/pi-route'
    const e = readEnvConfig()
    expect(e.configPath).toBe(join(homedir(), 'router.yaml'))
    expect(e.stateDir).toBe(join(homedir(), '.state/pi-route'))
  })
  test('cli-style overrides win over env vars', () => {
    process.env.PI_ROUTE_CONFIG = '/tmp/env.yaml'
    process.env.PI_ROUTE_STATE = '/tmp/env-state'
    const e = readEnvConfig({ configPath: '/tmp/flag.yaml', stateDir: '/tmp/flag-state' })
    expect(e.configPath).toBe('/tmp/flag.yaml')
    expect(e.stateDir).toBe('/tmp/flag-state')
  })
  test('port/host overrides win over env and default', () => {
    process.env.PI_ROUTE_PORT = '3030'
    process.env.PI_ROUTE_HOST = '10.0.0.1'
    const e = readEnvConfig({ port: 8080, host: '0.0.0.0' })
    expect(e.port).toBe(8080)
    expect(e.host).toBe('0.0.0.0')
  })
  test('honors systemd $STATE_DIRECTORY, taking the first colon-separated dir', () => {
    process.env.STATE_DIRECTORY = '/var/lib/pi-route:/var/lib/other'
    const e = readEnvConfig()
    expect(e.stateDir).toBe('/var/lib/pi-route')
  })
  test('throws on invalid port', () => {
    process.env.PI_ROUTE_PORT = 'abc'
    expect(() => readEnvConfig()).toThrow(/PI_ROUTE_PORT/)
  })
  test('throws on idleTimeout over Bun cap', () => {
    process.env.PI_ROUTE_IDLE_TIMEOUT = '999'
    expect(() => readEnvConfig()).toThrow(/PI_ROUTE_IDLE_TIMEOUT/)
  })
  test('throws on non-numeric idleTimeout', () => {
    process.env.PI_ROUTE_IDLE_TIMEOUT = 'abc'
    expect(() => readEnvConfig()).toThrow(/PI_ROUTE_IDLE_TIMEOUT/)
  })
})

const KEYS = [
  'PI_ROUTE_OTLP_URL',
  'PI_ROUTE_OTLP_PORT',
  'PI_ROUTE_CAPTURE_PROMPTS',
  'PI_ROUTE_CAPTURE_MAX_BYTES',
  'PI_ROUTE_SERVICE_NAME'
] as const

describe('readEnvConfig telemetry fields', () => {
  const saved: Record<string, string | undefined> = {}
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('defaults: otlpUrl empty, capture off, cap 65536, service pi-route', () => {
    const env = readEnvConfig()
    expect(env.otlpUrl).toBe('')
    expect(env.capturePrompts).toBe(false)
    expect(env.captureMaxBytes).toBe(65536)
    expect(env.serviceName).toBe('pi-route')
  })

  it('reads PI_ROUTE_OTLP_URL when set', () => {
    process.env.PI_ROUTE_OTLP_URL = 'http://localhost:4318'
    expect(readEnvConfig().otlpUrl).toBe('http://localhost:4318')
  })

  it('PI_ROUTE_OTLP_PORT derives otlpUrl when PI_ROUTE_OTLP_URL is unset', () => {
    delete process.env.PI_ROUTE_OTLP_URL
    process.env.PI_ROUTE_OTLP_PORT = '2010'
    expect(readEnvConfig().otlpUrl).toBe('http://localhost:2010')
  })

  it('PI_ROUTE_OTLP_URL wins over PI_ROUTE_OTLP_PORT when both are set', () => {
    process.env.PI_ROUTE_OTLP_URL = 'http://otel.internal:9999'
    process.env.PI_ROUTE_OTLP_PORT = '2010'
    expect(readEnvConfig().otlpUrl).toBe('http://otel.internal:9999')
  })

  it('neither PI_ROUTE_OTLP_URL nor PI_ROUTE_OTLP_PORT → empty otlpUrl', () => {
    delete process.env.PI_ROUTE_OTLP_URL
    delete process.env.PI_ROUTE_OTLP_PORT
    expect(readEnvConfig().otlpUrl).toBe('')
  })

  it('PI_ROUTE_CAPTURE_PROMPTS=1 toggles capture on', () => {
    process.env.PI_ROUTE_CAPTURE_PROMPTS = '1'
    expect(readEnvConfig().capturePrompts).toBe(true)
  })

  it('PI_ROUTE_CAPTURE_MAX_BYTES is an integer >= 1024; rejects junk', () => {
    process.env.PI_ROUTE_CAPTURE_MAX_BYTES = '1024'
    expect(readEnvConfig().captureMaxBytes).toBe(1024)
    process.env.PI_ROUTE_CAPTURE_MAX_BYTES = 'oops'
    expect(() => readEnvConfig()).toThrow(/PI_ROUTE_CAPTURE_MAX_BYTES/)
  })
})

describe('readEnvConfig — maxBodyBytes', () => {
  const originalEnv = { ...process.env }
  beforeEach(() => {
    delete process.env.PI_ROUTE_MAX_BODY_BYTES
  })
  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('defaults to 50 MB when PI_ROUTE_MAX_BODY_BYTES is unset', () => {
    const env = readEnvConfig()
    expect(env.maxBodyBytes).toBe(50 * 1024 * 1024)
  })

  test('honors PI_ROUTE_MAX_BODY_BYTES when set to a valid integer', () => {
    process.env.PI_ROUTE_MAX_BODY_BYTES = '1048576'
    const env = readEnvConfig()
    expect(env.maxBodyBytes).toBe(1_048_576)
  })

  test('throws when PI_ROUTE_MAX_BODY_BYTES is below minimum (1024)', () => {
    process.env.PI_ROUTE_MAX_BODY_BYTES = '512'
    expect(() => readEnvConfig()).toThrow(/PI_ROUTE_MAX_BODY_BYTES/)
  })

  test('throws when PI_ROUTE_MAX_BODY_BYTES is not an integer', () => {
    process.env.PI_ROUTE_MAX_BODY_BYTES = 'abc'
    expect(() => readEnvConfig()).toThrow(/PI_ROUTE_MAX_BODY_BYTES/)
  })
})

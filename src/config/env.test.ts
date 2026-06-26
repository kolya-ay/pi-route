import { afterEach, describe, expect, test } from 'bun:test'
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
    delete process.env.PI_ROUTE_TOKEN
    delete process.env.PI_ROUTE_CONFIG
    delete process.env.PI_ROUTE_AUTH
    delete process.env.PI_ROUTE_IDLE_TIMEOUT
  })
  test('defaults', () => {
    delete process.env.PI_ROUTE_PORT
    delete process.env.PI_ROUTE_HOST
    delete process.env.PI_ROUTE_TOKEN
    delete process.env.PI_ROUTE_CONFIG
    delete process.env.PI_ROUTE_AUTH
    delete process.env.PI_ROUTE_IDLE_TIMEOUT
    const e = readEnvConfig()
    expect(e.port).toBe(3000)
    expect(e.host).toBe('127.0.0.1')
    expect(e.tokens).toEqual([])
    expect(e.configPath).toBe('./router.yaml')
    expect(e.authDir.endsWith('/pi-route/auth')).toBe(true)
    expect(e.idleTimeout).toBe(120)
  })
  test('overrides via env', () => {
    process.env.PI_ROUTE_PORT = '3030'
    process.env.PI_ROUTE_HOST = '0.0.0.0'
    process.env.PI_ROUTE_TOKEN = 'a,b,c'
    process.env.PI_ROUTE_CONFIG = '/tmp/r.yaml'
    process.env.PI_ROUTE_AUTH = '/tmp/auth'
    process.env.PI_ROUTE_IDLE_TIMEOUT = '30'
    const e = readEnvConfig()
    expect(e.port).toBe(3030)
    expect(e.host).toBe('0.0.0.0')
    expect(e.tokens).toEqual(['a', 'b', 'c'])
    expect(e.configPath).toBe('/tmp/r.yaml')
    expect(e.authDir).toBe('/tmp/auth')
    expect(e.idleTimeout).toBe(30)
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

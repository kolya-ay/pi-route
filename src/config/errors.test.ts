import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { ConfigError, toConfigError } from './errors'

describe('toConfigError', () => {
  test('wraps a ZodError with a prettified, path-attributed message', () => {
    const schema = z.object({ port: z.number() })
    const result = schema.safeParse({ port: 'nope' })
    const err = toConfigError(result.error, '/tmp/router.yaml')
    expect(err).toBeInstanceOf(ConfigError)
    expect(err.message).toContain('Invalid config: /tmp/router.yaml')
    expect(err.message).toContain('port')
  })

  test('wraps a plain Error preserving its message (e.g. name collision)', () => {
    const err = toConfigError(new Error('name collision: pipeline entry "x"'), '/tmp/router.yaml')
    expect(err).toBeInstanceOf(ConfigError)
    expect(err.message).toContain('name collision')
  })

  test('passes an existing ConfigError through unchanged', () => {
    const original = new ConfigError('already a config error')
    expect(toConfigError(original, '/tmp/x')).toBe(original)
  })
})

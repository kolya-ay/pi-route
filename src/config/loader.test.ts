import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError } from './errors'
import { loadConfig } from './loader'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'pi-route-'))

test('missing config file throws ConfigError', async () => {
  const dir = tmp()
  const err = await loadConfig(join(dir, 'nope.yaml'), dir).catch((e) => e)
  expect(err).toBeInstanceOf(ConfigError)
  expect(err.message).toContain('Config file not found')
})

test('malformed YAML throws ConfigError', async () => {
  const dir = tmp()
  const path = join(dir, 'router.yaml')
  writeFileSync(path, 'providers: [unclosed')
  const err = await loadConfig(path, dir).catch((e) => e)
  expect(err).toBeInstanceOf(ConfigError)
})

test('schema violation throws ConfigError mentioning the config path', async () => {
  const dir = tmp()
  const path = join(dir, 'router.yaml')
  writeFileSync(path, 'providers:\n  bad:\n    type: 123\n')
  const err = await loadConfig(path, dir).catch((e) => e)
  expect(err).toBeInstanceOf(ConfigError)
  expect(err.message).toContain('Invalid config')
})

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-route-loader-'))
})
afterEach(async () => {
  delete process.env.MY_TEST_KEY
  await rm(dir, { recursive: true, force: true })
})

const writeYaml = async (s: string): Promise<string> => {
  const p = join(dir, 'router.yaml')
  await writeFile(p, s)
  return p
}

describe('loadConfig', () => {
  test('parses minimal config', async () => {
    const p = await writeYaml(`
providers:
  cerebras:
    type: cerebras
    apiKey: sk-test
`)
    const { options } = await loadConfig(p, dir)
    expect(options.providers.cerebras?.type).toBe('cerebras')
  })

  test('interpolates env vars', async () => {
    process.env.MY_TEST_KEY = 'real-key'
    const p = await writeYaml(`
providers:
  c:
    type: cerebras
    apiKey: $MY_TEST_KEY
`)
    const { options } = await loadConfig(p, dir)
    const a = options.providers.c?.account
    if (!a) throw new Error('provider c missing')
    if (a.credential === 'key') expect(a.key).toBe('real-key')
  })

  test('parses pipeline value shapes', async () => {
    const p = await writeYaml(`
pipeline:
  opus: claude-pool/claude-opus-4-7
  claude-pool: [claude-personal/$1, claude-work/$1]
  fancy:
    to: [a/$1, b/$1]
    strategy: sticky
`)
    const { options } = await loadConfig(p, dir)
    expect(options.pipeline.map((e) => e.name)).toEqual(['opus', 'claude-pool', 'fancy'])
    expect(options.pipeline[0]?.kind).toBe('alias')
    expect(options.pipeline[1]?.kind).toBe('pool')
    const fancy = options.pipeline[2]
    if (!fancy) throw new Error('fancy pipeline entry missing')
    if (fancy.kind === 'pool') expect(fancy.strategy).toBe('sticky')
  })

  test('returns initial runtime state', async () => {
    const p = await writeYaml(`providers: {}`)
    const { state } = await loadConfig(p, dir)
    expect(state.accounts).toEqual({})
  })

  test('throws a meaningful message when the config file is missing', async () => {
    const missingPath = join(dir, 'missing.yaml')

    await expect(loadConfig(missingPath, dir)).rejects.toThrow(
      `Config file not found: ${missingPath}\nCreate it or pass -c <path>.`
    )
  })
})

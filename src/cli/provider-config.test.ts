import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouterOptions } from '../types'
import { formatProviderList, removeCredential, upsertProviderBlock } from './provider-config'

const tmp = () => mkdtempSync(join(tmpdir(), 'pc-'))

describe('upsertProviderBlock', () => {
  test('adds a provider block, preserving existing block comments', async () => {
    const dir = tmp()
    const cfg = join(dir, 'config.yaml')
    writeFileSync(
      cfg,
      '# top comment\nproviders:\n  cerebras:\n    type: cerebras\n    apiKey: $CEREBRAS_API_KEY\n'
    )
    await upsertProviderBlock(cfg, 'chutes', {
      type: 'openai-compatible',
      baseUrl: 'https://llm.chutes.ai/v1',
      apiKey: '$CHUTES_API_KEY'
    })
    const text = await Bun.file(cfg).text()
    expect(text).toContain('# top comment')
    expect(text).toContain('chutes:')
    expect(text).toContain('baseUrl: https://llm.chutes.ai/v1')
    expect(text).toContain('apiKey: $CHUTES_API_KEY')
  })

  test('creates the file when absent', async () => {
    const dir = tmp()
    const cfg = join(dir, 'config.yaml')
    await upsertProviderBlock(cfg, 'anthropic-main', {
      type: 'anthropic',
      account: 'anthropic-main'
    })
    const text = await Bun.file(cfg).text()
    expect(text).toContain('anthropic-main:')
    expect(text).toContain('account: anthropic-main')
  })
})

describe('removeCredential', () => {
  test('deletes an existing credential file, reports false when absent', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'foo.json'), '{}')
    expect(removeCredential(dir, 'foo')).toBe(true)
    expect(removeCredential(dir, 'foo')).toBe(false)
  })
})

describe('formatProviderList', () => {
  test('renders name, type, credential kind, status', () => {
    const options = {
      providers: {
        chutes: { type: 'openai-compatible', account: { credential: 'key', key: 'x' } },
        anthropic: { type: 'anthropic', account: { credential: 'oauth', name: 'anthropic' } }
      },
      pipeline: [],
      expose: []
    } as unknown as RouterOptions
    const out = formatProviderList(options, new Set(['anthropic']))
    expect(out).toContain('chutes')
    expect(out).toContain('openai-compatible')
    expect(out).toContain('key')
    expect(out).toContain('ok')
    expect(out).toContain('invalid') // anthropic flagged invalid
  })
})

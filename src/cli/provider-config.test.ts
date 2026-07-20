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
  const options = {
    providers: {
      cerebras: { type: 'openai-compatible', account: { credential: 'apiKey', name: 'cerebras' } },
      cc: { type: 'anthropic', account: { credential: 'oauth', name: 'anthropic-cc' } }
    },
    pipeline: [],
    expose: []
  } as unknown as RouterOptions

  const withDisabled = {
    providers: {
      cerebras: { type: 'openai-compatible', account: { credential: 'apiKey', name: 'cerebras' } },
      off: {
        type: 'openai-compatible',
        account: { credential: 'apiKey', name: 'off', disabled: true }
      }
    },
    pipeline: [],
    expose: []
  } as unknown as RouterOptions

  const noFlags = { invalid: new Set<string>(), loggedOut: new Set<string>(), all: false }

  test('table with header and one row per provider; status column present', () => {
    const out = formatProviderList(options, { ...noFlags, invalid: new Set(['cc']) })
    const lines = out.split('\n')
    expect(lines[0]).toContain('PROVIDER')
    expect(lines[0]).toContain('STATUS')
    expect(out).toContain('cerebras')
    expect(out).toContain('ok')
    expect(out).toContain('invalid') // cc is in the invalid set
  })

  test('empty providers message', () => {
    expect(
      formatProviderList(
        { providers: {}, pipeline: [], expose: [] } as unknown as RouterOptions,
        noFlags
      )
    ).toBe('(no providers)')
  })

  test('an oauth provider with no credential file reports logged-out', () => {
    const out = formatProviderList(options, { ...noFlags, loggedOut: new Set(['cc']) })
    expect(out).toContain('logged-out')
  })

  test('disabled providers are hidden unless all is set', () => {
    expect(formatProviderList(withDisabled, noFlags)).not.toContain('off')
    expect(formatProviderList(withDisabled, { ...noFlags, all: true })).toContain('off')
  })
})

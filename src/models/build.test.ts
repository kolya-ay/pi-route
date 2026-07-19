import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouterOptions } from '../types'
import { buildModels } from './build'

const dirs = () => mkdtempSync(join(tmpdir(), 'pi-route-build-'))

const options = {
  providers: {
    cc: { type: 'anthropic', account: { credential: 'oauth', name: 'cc' } },
    codex: { type: 'openai-codex', account: { credential: 'oauth', name: 'codex' } },
    ag: { type: 'antigravity', account: { credential: 'oauth', name: 'antigravity' } },
    chutes: {
      type: 'openai-compatible',
      baseUrl: 'https://llm.chutes.ai/v1',
      account: { credential: 'key', key: 'k' }
    }
  },
  pipeline: [],
  expose: []
} as unknown as RouterOptions

describe('buildModels', () => {
  test('one provider per config entry, id = config name', () => {
    const models = buildModels(options, { stateDir: dirs(), authDir: dirs() })
    expect(
      models
        .getProviders()
        .map((p) => p.id)
        .sort()
    ).toEqual(['ag', 'cc', 'chutes', 'codex'])
  })

  test('static catalogs are re-stamped with config ids', () => {
    const models = buildModels(options, { stateDir: dirs(), authDir: dirs() })
    const cc = models.getModels('cc')
    expect(cc.length).toBeGreaterThan(0)
    expect(cc.every((m) => m.provider === 'cc')).toBe(true)
    expect(cc.some((m) => m.id === 'claude-opus-4-8')).toBe(true)
    expect(models.getModels('codex').some((m) => m.id.startsWith('gpt-5.6'))).toBe(true)
  })

  test('openai-compatible providers get baseUrl-stamped empty catalogs', () => {
    const models = buildModels(options, { stateDir: dirs(), authDir: dirs() })
    expect(models.getProvider('chutes')?.baseUrl).toBe('https://llm.chutes.ai/v1')
    expect(models.getModels('chutes')).toEqual([])
  })
})

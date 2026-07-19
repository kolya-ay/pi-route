import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelsStoreEntry } from '@earendil-works/pi-ai'
import { fileModelsStore } from './store'

const model = {
  id: 'm1',
  name: 'M1',
  api: 'anthropic-messages',
  provider: 'cc',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 64000
} as const

describe('fileModelsStore', () => {
  test('round-trips an entry per provider id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-route-ms-'))
    const store = fileModelsStore(dir)
    expect(await store.read('cc')).toBeUndefined()
    await store.write('cc', { models: [model], checkedAt: 123 } as unknown as ModelsStoreEntry)
    const entry = await store.read('cc')
    expect(entry?.checkedAt).toBe(123)
    expect(entry?.models[0]?.id).toBe('m1')
    await store.delete('cc')
    expect(await store.read('cc')).toBeUndefined()
  })

  test('tolerates corrupt files as undefined', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-route-ms-'))
    await Bun.write(join(dir, 'bad.json'), '{nope')
    expect(await fileModelsStore(dir).read('bad')).toBeUndefined()
  })
})

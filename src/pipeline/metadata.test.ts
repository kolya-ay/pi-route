import { describe, expect, test } from 'bun:test'
import { getModel } from '@mariozechner/pi-ai'
import { toModelMeta } from './metadata'

describe('toModelMeta', () => {
  test('maps a pi-ai model into ModelMeta with the projection fields', () => {
    const m = getModel('cerebras', 'gpt-oss-120b')
    const meta = toModelMeta(m)
    expect(meta.name).toBe(m.name)
    expect(meta.contextWindow).toBe(m.contextWindow)
    expect(meta.reasoning).toBe(Boolean(m.reasoning))
  })
})

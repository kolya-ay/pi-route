import { describe, expect, test } from 'bun:test'
import type { ModelMeta } from '../pipeline/catalog'
import type { PlannedWrite } from './agent'
import { completeness, type ModelRow, renderModelList, renderPlannedWrites } from './models'

describe('completeness', () => {
  const full: ModelMeta = { name: 'X', contextWindow: 1000, maxTokens: 100, cost: { input: 1 } }
  test('full when ctx + max + a cost side are present', () => {
    expect(completeness(full)).toBe('full')
  })
  test('partial when a required field is missing', () => {
    const noMax: ModelMeta = { name: 'X', contextWindow: 1000, cost: { input: 1 } }
    expect(completeness(noMax)).toBe('partial')
    expect(completeness({ name: 'X', contextWindow: 1000, maxTokens: 100 })).toBe('partial')
  })
  test('stub when model is null', () => {
    expect(completeness(null)).toBe('stub')
  })
})

describe('renderModelList', () => {
  const rows: ModelRow[] = [
    {
      id: 'cerebras/gpt-oss-120b',
      ctx: '131k',
      max: '41k',
      cost: '.35/.75',
      caps: 'reason',
      tier: 'full'
    },
    { id: 'nvidia/x/deepseek-v4', ctx: '—', max: '—', cost: '—/—', caps: '·', tier: 'stub' }
  ]
  test('plain ids, one per line, when not a TTY', () => {
    expect(renderModelList(rows, false)).toBe('cerebras/gpt-oss-120b\nnvidia/x/deepseek-v4')
  })
  test('empty rows render empty string off-TTY', () => {
    expect(renderModelList([], false)).toBe('')
  })
  test('TTY output is a table with a header and both ids present', () => {
    const out = renderModelList(rows, true)
    expect(out).toContain('MODEL')
    expect(out).toContain('CTX')
    expect(out).toContain('cerebras/gpt-oss-120b')
    expect(out).toContain('nvidia/x/deepseek-v4')
    expect(out).toContain('full · partial · stub') // legend
  })
})

describe('renderPlannedWrites', () => {
  test('renders action+path header and a diff body per write (plain off-TTY)', () => {
    const writes: PlannedWrite[] = [
      { action: 'update', path: '/tmp/a.json', before: 'one\ntwo\n', content: 'one\nTWO\n' }
    ]
    const out = renderPlannedWrites(writes)
    expect(out).toContain('update  /tmp/a.json')
    expect(out).toContain('- two')
    expect(out).toContain('+ TWO')
  })
})

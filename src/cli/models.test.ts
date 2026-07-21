import { describe, expect, test } from 'bun:test'
import type { Api, Model, Models } from '@earendil-works/pi-ai'
import type { ModelMeta } from '../pipeline/catalog'
import { toModelMeta } from '../pipeline/metadata'
import type { RouterOptions } from '../types'
import type { PlannedWrite } from './agent'
import {
  completeness,
  type ModelRow,
  renderModelDetail,
  renderModelList,
  renderPlannedWrites
} from './models'

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
  // An endpoint (e.g. NVIDIA) that didn't describe a model reports contextWindow/
  // maxTokens as 0 (Model requires non-optional numbers) — toModelMeta normalizes
  // that to real absence, so this must grade partial, not full.
  test('partial for an endpoint model whose limits are the "unknown" 0 sentinel', () => {
    const endpointModel = {
      id: 'some-model',
      name: 'some-model',
      api: 'openai-completions',
      provider: 'nvidia',
      baseUrl: 'https://example.test/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 0,
      maxTokens: 0
    } as unknown as Model<Api>
    expect(completeness(toModelMeta(endpointModel))).toBe('partial')
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

describe('renderModelDetail', () => {
  // A vLLM/chutes-style endpoint reporting a real contextWindow but no
  // output-token limit — maxTokens 0 must render as "unknown" (em dash), not
  // "0 tokens", and the block must grade partial, not full.
  test('an endpoint model with unknown maxTokens renders — , not "0 tokens"', () => {
    const endpointModel = {
      id: 'some-model',
      name: 'some-model',
      api: 'openai-completions',
      provider: 'nvidia',
      baseUrl: 'https://example.test/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 0
    } as unknown as Model<Api>
    const models = {
      getModels: (name?: string) => (!name || name === 'nvidia' ? [endpointModel] : []),
      getModel: (provider: string, id: string) =>
        provider === 'nvidia' && id === 'some-model' ? endpointModel : undefined
    } as unknown as Models
    const options: RouterOptions = {
      providers: {
        nvidia: {
          type: 'openai-compatible',
          baseUrl: 'https://example.test/v1',
          account: { credential: 'key', key: 'k' },
          discover: []
        }
      },
      pipeline: [],
      expose: ['nvidia/**']
    } as unknown as RouterOptions
    const detail = renderModelDetail(options, models, '/tmp', 'nvidia/some-model')
    expect(detail).toContain('partial')
    expect(detail).not.toMatch(/max out\s+0 tokens/)
    expect(detail).toMatch(/max out\s+—/)
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

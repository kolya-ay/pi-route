// src/routing/pipeline.test.ts

import { describe, expect, it } from 'vitest'
import type { RouterOptions, RoutingContext } from '../types.js'
import { createRoutingPipeline } from './pipeline.js'

const baseOptions: RouterOptions = {
  server: { port: 4000, host: '127.0.0.1' },
  auth: { apiKeys: [] },
  backends: {
    'claude-cli': {
      type: 'passthrough-anthropic',
      baseUrl: 'http://localhost:3000',
      accounts: [],
      balancing: { strategy: 'round-robin' },
    },
    chutes: {
      type: 'passthrough-openai',
      baseUrl: 'http://chutes.example.com',
      accounts: [],
      balancing: { strategy: 'round-robin' },
    },
  },
  routing: {
    rules: [
      { match: 'claude-*', backend: 'claude-cli' },
      { match: 'deepseek-*', backend: 'chutes' },
    ],
    scenarios: {
      thinking: { backend: 'claude-cli' },
    },
    default: { backend: 'chutes' },
  },
  telemetry: { level: 'info' },
}

const makeContext = (overrides: Partial<RoutingContext> = {}): RoutingContext => ({
  model: 'gpt-4',
  format: 'openai',
  headers: new Headers(),
  body: {},
  options: baseOptions,
  ...overrides,
})

describe('createRoutingPipeline', () => {
  it('matches claude-* model to claude-cli via rule', () => {
    const pipeline = createRoutingPipeline()
    const decision = pipeline.resolve(makeContext({ model: 'claude-opus-4-5' }))!
    expect(decision.backend).toBe('claude-cli')
    expect(decision.reason).toBe('rule: claude-*')
  })

  it('matches deepseek-* model to chutes via rule', () => {
    const pipeline = createRoutingPipeline()
    const decision = pipeline.resolve(makeContext({ model: 'deepseek-chat' }))!
    expect(decision.backend).toBe('chutes')
    expect(decision.reason).toBe('rule: deepseek-*')
  })

  it('detects Anthropic thinking scenario via body.thinking field', () => {
    const pipeline = createRoutingPipeline()
    const decision = pipeline.resolve(
      makeContext({
        model: 'some-unknown-model',
        format: 'anthropic',
        body: { thinking: { type: 'enabled', budget_tokens: 1000 } },
      }),
    )!
    expect(decision.backend).toBe('claude-cli')
    expect(decision.reason).toBe('scenario: thinking')
  })

  it('detects OpenAI reasoning_effort as thinking scenario', () => {
    const pipeline = createRoutingPipeline()
    const decision = pipeline.resolve(
      makeContext({
        model: 'some-unknown-model',
        format: 'openai',
        body: { reasoning_effort: 'high' },
      }),
    )!
    expect(decision.backend).toBe('claude-cli')
    expect(decision.reason).toBe('scenario: thinking')
  })

  it('falls through to default for unknown model', () => {
    const pipeline = createRoutingPipeline()
    const decision = pipeline.resolve(makeContext({ model: 'gpt-4o' }))!
    expect(decision.backend).toBe('chutes')
    expect(decision.reason).toBe('default')
  })

  it('rule-match takes priority over scenario', () => {
    const pipeline = createRoutingPipeline()
    // claude-* matches a rule, even with thinking body it should use rule
    const decision = pipeline.resolve(
      makeContext({
        model: 'claude-haiku-3-5',
        format: 'anthropic',
        body: { thinking: { type: 'enabled', budget_tokens: 500 } },
      }),
    )!
    expect(decision.backend).toBe('claude-cli')
    expect(decision.reason).toBe('rule: claude-*')
  })
})

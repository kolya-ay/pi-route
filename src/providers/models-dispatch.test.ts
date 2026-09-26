// src/providers/models-dispatch.test.ts

import { describe, expect, it } from 'bun:test'
import type { Api, AssistantMessage, Context, Model, Models, ToolCall } from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream, ModelsError } from '@earendil-works/pi-ai'

import { STRUCTURED_OUTPUT_TOOL } from '../structured-output'
import { createTel } from '../telemetry/tel'
import { useTestExporter } from '../telemetry/test-fixture'
import type { FormatTranslationMode, IncomingRequest } from '../types'
import { createModelsDispatch, DispatchAuthError, mapAuthError } from './models-dispatch'

const mkRequest = (overrides: Partial<IncomingRequest> = {}): IncomingRequest => ({
  id: 'req-1',
  format: 'anthropic',
  model: 'm',
  stream: false,
  rawRequest: new Request('http://x', {
    method: 'POST',
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] })
  }),
  ...overrides
})

const mkModel = (): Model<Api> => ({
  id: 'm',
  name: 'Model M',
  api: 'anthropic-messages',
  provider: 'prov',
  baseUrl: 'http://x',
  reasoning: false,
  input: ['text'],
  cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 500
})

const mkMessage = (input = 1, output = 1): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'hello' }],
  api: 'anthropic-messages',
  provider: 'prov',
  model: 'm',
  usage: {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: 'stop',
  timestamp: Date.now()
})

// Duck-typed Models: dispatch only reads .getModel and .stream.
const mkModels = (over: Partial<Pick<Models, 'getModel' | 'stream'>>): Models =>
  ({ getModel: () => mkModel(), stream: () => cannedStream(), ...over }) as unknown as Models

const cannedStream = (input = 1, output = 1) => {
  const stream = createAssistantMessageEventStream()
  const message = mkMessage(input, output)
  stream.push({ type: 'done', reason: 'stop', message })
  stream.end(message)
  return stream
}

describe('createModelsDispatch', () => {
  it('throws "model not found" for an unknown model', async () => {
    const provider = createModelsDispatch(mkModels({ getModel: () => undefined }), 'prov')
    await expect(
      provider.dispatch(mkRequest(), { credential: 'key', key: 'k' }, 'k')
    ).rejects.toThrow(/model not found/)
  })

  it('returns a 200 JSON ProviderResponse on the happy non-streaming path', async () => {
    const provider = createModelsDispatch(mkModels({ stream: () => cannedStream() }), 'prov')
    const res = await provider.dispatch(
      mkRequest({ stream: false }),
      { credential: 'key', key: 'k' },
      'k'
    )
    expect(res.status).toBe(200)
    expect(res.metadata.provider).toBe('prov')
    expect(res.metadata.model).toBe('m')
  })

  it('passes the capped model.maxTokens to models.stream', async () => {
    let captured: { maxTokens?: number } | undefined
    const stream = ((_model: Model<Api>, _context: unknown, options?: { maxTokens?: number }) => {
      captured = options
      return cannedStream()
    }) as unknown as Models['stream']
    const provider = createModelsDispatch(mkModels({ stream }), 'prov')
    // mkModel().maxTokens === 500; a body max_tokens of 16 must cap the value
    // handed to stream (openai-completions sets upstream max_tokens only from this).
    const rawRequest = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({
        model: 'm',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }]
      })
    })
    await provider.dispatch(
      mkRequest({ stream: false, rawRequest }),
      { credential: 'key', key: 'k' },
      'k'
    )
    expect(captured?.maxTokens).toBe(16)
  })

  it('fills a catalog model with unknown limits (0) with defaults before streaming', async () => {
    let captured: { contextWindow: number; maxTokens: number } | undefined
    const bareModel: Model<Api> = { ...mkModel(), contextWindow: 0, maxTokens: 0 }
    const stream = ((model: Model<Api>) => {
      captured = { contextWindow: model.contextWindow, maxTokens: model.maxTokens }
      return cannedStream()
    }) as unknown as Models['stream']
    const provider = createModelsDispatch(mkModels({ getModel: () => bareModel, stream }), 'prov')
    await provider.dispatch(mkRequest({ stream: false }), { credential: 'key', key: 'k' }, 'k')
    expect(captured).toEqual({ contextWindow: 128_000, maxTokens: 4096 })
  })

  it('caps a body max_tokens against the defaulted limit, not against 0', async () => {
    let captured: { maxTokens?: number } | undefined
    const bareModel: Model<Api> = { ...mkModel(), contextWindow: 0, maxTokens: 0 }
    const stream = ((_model: Model<Api>, _context: unknown, options?: { maxTokens?: number }) => {
      captured = options
      return cannedStream()
    }) as unknown as Models['stream']
    const provider = createModelsDispatch(mkModels({ getModel: () => bareModel, stream }), 'prov')
    const rawRequest = new Request('http://x', {
      method: 'POST',
      body: JSON.stringify({
        model: 'm',
        max_tokens: 1000,
        messages: [{ role: 'user', content: 'hi' }]
      })
    })
    await provider.dispatch(
      mkRequest({ stream: false, rawRequest }),
      { credential: 'key', key: 'k' },
      'k'
    )
    expect(captured?.maxTokens).toBe(1000)
  })

  it('leaves a catalog model with real limits untouched', async () => {
    let captured: { contextWindow: number; maxTokens: number } | undefined
    const stream = ((model: Model<Api>) => {
      captured = { contextWindow: model.contextWindow, maxTokens: model.maxTokens }
      return cannedStream()
    }) as unknown as Models['stream']
    const provider = createModelsDispatch(mkModels({ stream }), 'prov')
    await provider.dispatch(mkRequest({ stream: false }), { credential: 'key', key: 'k' }, 'k')
    // mkModel() carries real, non-zero limits (1000/500) — the fill-in must not touch them.
    expect(captured).toEqual({ contextWindow: 1000, maxTokens: 500 })
  })
})

describe('createModelsDispatch structured output', () => {
  const constraint = {
    name: 'capital',
    schema: {
      type: 'object',
      properties: { capital: { type: 'string' } },
      required: ['capital'],
      additionalProperties: false
    }
  }

  const capture = (api: Model<Api>['api']) => {
    const seen: { context?: Context; options?: Record<string, unknown> | undefined } = {}
    const stream = ((_model: Model<Api>, context: Context, options?: Record<string, unknown>) => {
      seen.context = context
      seen.options = options
      return structuredStream()
    }) as unknown as Models['stream']
    return {
      seen,
      models: mkModels({ getModel: () => ({ ...mkModel(), api }), stream })
    }
  }

  const structuredStream = () => {
    const stream = createAssistantMessageEventStream()
    const message: AssistantMessage = {
      ...mkMessage(),
      content: [
        {
          type: 'toolCall',
          id: 'call-1',
          name: STRUCTURED_OUTPUT_TOOL,
          arguments: { capital: 'Paris' }
        }
      ],
      stopReason: 'toolUse'
    }
    stream.push({ type: 'start', partial: message })
    stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message })
    stream.push({
      type: 'toolcall_delta',
      contentIndex: 0,
      delta: '{"capital":"Paris"}',
      partial: message
    })
    stream.push({
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: message.content[0] as ToolCall,
      partial: message
    })
    stream.push({ type: 'done', reason: 'toolUse', message })
    stream.end(message)
    return stream
  }

  const dispatchWith = async (
    api: Model<Api>['api'],
    mode: FormatTranslationMode,
    format: IncomingRequest['format'] = 'openai'
  ) => {
    const { seen, models } = capture(api)
    const provider = createModelsDispatch(models, 'prov', false, mode)
    const response = await provider.dispatch(
      mkRequest({ format, structuredOutput: constraint }),
      { credential: 'key', key: 'k' },
      'k'
    )
    return { seen, response }
  }

  it('puts the native chat wire shape on the stream options', async () => {
    const { seen } = await dispatchWith('openai-completions', 'native')
    expect(seen.options?.samplingParams).toEqual({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'capital', strict: true, schema: constraint.schema }
      }
    })
    expect(seen.context?.tools).toBeUndefined()
  })

  it('forces a private strict tool for backends without a native mapping', async () => {
    const { seen } = await dispatchWith('anthropic-messages', 'auto')
    expect(seen.context?.tools).toEqual([
      {
        name: STRUCTURED_OUTPUT_TOOL,
        description: 'Return capital',
        parameters: constraint.schema,
        constrainedSampling: { type: 'json_schema', strict: 'require' }
      }
    ])
    expect(seen.options?.toolChoice).toEqual({ type: 'tool', name: STRUCTURED_OUTPUT_TOOL })
  })

  it('returns the schema document as assistant content, never a tool call', async () => {
    const { response } = await dispatchWith('anthropic-messages', 'constrained-tool')
    const body = response.body as {
      choices: [{ message: { content: string; tool_calls?: unknown }; finish_reason: string }]
    }
    expect(body.choices[0].message.content).toBe('{"capital":"Paris"}')
    expect(body.choices[0].message.tool_calls).toBeUndefined()
    expect(body.choices[0].finish_reason).toBe('stop')
  })

  it('fails before streaming when the backend cannot enforce the mode', async () => {
    const { seen, models } = capture('openai-codex-responses')
    const provider = createModelsDispatch(models, 'prov', false, 'native')
    await expect(
      provider.dispatch(
        mkRequest({ format: 'openai', structuredOutput: constraint }),
        { credential: 'key', key: 'k' },
        'k'
      )
    ).rejects.toThrow(/openai-codex-responses/)
    expect(seen.options).toBeUndefined()
  })

  it('leaves ordinary requests untouched', async () => {
    const { seen, models } = capture('openai-completions')
    const provider = createModelsDispatch(models, 'prov', false, 'constrained-tool')
    await provider.dispatch(mkRequest(), { credential: 'key', key: 'k' }, 'k')
    expect(seen.context?.tools).toBeUndefined()
    expect(seen.options?.samplingParams).toBeUndefined()
    expect(seen.options?.toolChoice).toBeUndefined()
  })
})

// The unit boundary this suite exists to guard: Model.cost is USD per MILLION
// tokens (see model-projection.ts perTokenString, metadata.ts parseLitellmModelInfo),
// but wrapStreamForMetrics multiplies raw token counts by its `costs`. Dispatch
// owns the conversion; without it every priced provider reports 1e6x too much.
describe('createModelsDispatch cost units', () => {
  const exporter = useTestExporter()

  it('records $0.001 for 10k input tokens at $0.10 per million, not $1000', async () => {
    const priced: Model<Api> = {
      ...mkModel(),
      cost: { input: 0.1, output: 0.4, cacheRead: 0, cacheWrite: 0 }
    }
    const models = mkModels({
      getModel: () => priced,
      stream: () => cannedStream(10_000, 1_000)
    })
    const tel = createTel()
    await tel.withSpan('outer', {}, async (span) => {
      const provider = createModelsDispatch(models, 'prov')
      await provider.dispatch(
        mkRequest({
          stream: false,
          telHooks: { tel, span, capture: { capturePrompts: false, maxBytes: 0 } }
        }),
        { credential: 'key', key: 'k' },
        'k'
      )
    })
    const attrs = exporter.getFinishedSpans()[0]?.attributes
    if (!attrs) throw new Error('missing finished span attributes')
    // 10_000 * $0.10/1e6 + 1_000 * $0.40/1e6 = 0.001 + 0.0004
    expect(attrs['gen_ai.usage.cost_usd']).toBeCloseTo(0.0014, 10)
  })
})

describe('mapAuthError', () => {
  it('maps a ModelsError("oauth") to a DispatchAuthError with a login hint', () => {
    const mapped = mapAuthError(new ModelsError('oauth', 'boom'), 'prov')
    expect(mapped).toBeInstanceOf(DispatchAuthError)
    expect((mapped as DispatchAuthError).message).toContain('pi-route login prov')
  })

  it('returns a plain Error unchanged', () => {
    const err = new Error('nope')
    expect(mapAuthError(err, 'prov')).toBe(err)
  })

  it('returns a ModelsError("auth") unchanged (only "oauth" maps)', () => {
    const err = new ModelsError('auth', 'nope')
    expect(mapAuthError(err, 'prov')).toBe(err)
  })
})

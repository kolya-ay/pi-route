// src/providers/models-dispatch.test.ts

import { describe, expect, it } from 'bun:test'
import type {
  Api,
  AssistantMessage,
  Context,
  JsonObject,
  Model,
  Models,
  ToolCall
} from '@earendil-works/pi-ai'
import { createAssistantMessageEventStream, ModelsError } from '@earendil-works/pi-ai'

import { STRUCTURED_OUTPUT_TOOL, type StructuredOutput } from '../structured-output'
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

// Duck-typed Models: dispatch reads .getModel, .getProvider and .stream.
const mkModels = (over: Partial<Pick<Models, 'getModel' | 'getProvider' | 'stream'>>): Models =>
  ({
    getModel: () => mkModel(),
    getProvider: () => ({ baseUrl: 'http://provider/v1' }),
    stream: () => cannedStream(),
    ...over
  }) as unknown as Models

const cannedStream = (input = 1, output = 1) => {
  const stream = createAssistantMessageEventStream()
  const message = mkMessage(input, output)
  stream.push({ type: 'done', reason: 'stop', message })
  stream.end(message)
  return stream
}

// One private-tool-call stream, shared by every structured-output dispatch test.
const toolCallStream = (args: JsonObject) => {
  const stream = createAssistantMessageEventStream()
  const message: AssistantMessage = {
    ...mkMessage(),
    content: [{ type: 'toolCall', id: 'call-1', name: STRUCTURED_OUTPUT_TOOL, arguments: args }],
    stopReason: 'toolUse'
  }
  stream.push({ type: 'start', partial: message })
  stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message })
  stream.push({
    type: 'toolcall_delta',
    contentIndex: 0,
    delta: JSON.stringify(args),
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
      return toolCallStream({ capital: 'Paris' })
    }) as unknown as Models['stream']
    return {
      seen,
      models: mkModels({ getModel: () => ({ ...mkModel(), api }), stream })
    }
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

describe('createModelsDispatch structured output dropped-keyword telemetry', () => {
  const exporter = useTestExporter()

  const rangedConstraint = {
    name: 'ranged',
    schema: {
      type: 'object',
      properties: { n: { type: 'integer', minimum: 0 } },
      required: ['n'],
      additionalProperties: false
    }
  }

  const cleanConstraint = {
    name: 'clean',
    schema: {
      type: 'object',
      properties: { n: { type: 'integer' } },
      required: ['n'],
      additionalProperties: false
    }
  }

  const dispatchUnderSpan = async (structuredOutput: StructuredOutput) => {
    const models = mkModels({
      getModel: () => ({ ...mkModel(), api: 'anthropic-messages' }),
      stream: () => toolCallStream({ n: 3 })
    })
    const tel = createTel()
    await tel.withSpan('outer', {}, async (span) => {
      const provider = createModelsDispatch(models, 'prov', false, 'constrained-tool')
      await provider.dispatch(
        mkRequest({
          format: 'openai',
          structuredOutput,
          telHooks: { tel, span, capture: { capturePrompts: false, maxBytes: 0 } }
        }),
        { credential: 'key', key: 'k' },
        'k'
      )
    })
  }

  it('records the dropped keywords on the active span for the constrained-tool route', async () => {
    await dispatchUnderSpan(rangedConstraint)
    const attrs = exporter.getFinishedSpans()[0]?.attributes
    expect(attrs?.['pi.structured_output.dropped_keywords']).toEqual(['minimum'])
  })

  it('sets no attribute when nothing is dropped', async () => {
    await dispatchUnderSpan(cleanConstraint)
    const attrs = exporter.getFinishedSpans()[0]?.attributes
    expect(attrs?.['pi.structured_output.dropped_keywords']).toBeUndefined()
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

describe('structuredOutputApi swap', () => {
  const schemaRequest = () =>
    mkRequest({
      format: 'openai',
      structuredOutput: {
        name: 'cap',
        schema: {
          type: 'object',
          properties: { capital: { type: 'string' } },
          required: ['capital'],
          additionalProperties: false
        }
      }
    })

  // The stream must satisfy whichever route ends up taken: if the swap does NOT
  // happen, the model keeps anthropic-messages, which has no native mapping, so
  // 'auto' falls back to the constrained-tool route and expects a private
  // schema tool call in the response (see the `structured output` describe
  // block above) — a plain-text cannedStream() would throw during normalization
  // before the test ever reaches its `seen[0]` assertion.

  const captureModel = () => {
    const seen: Model<Api>[] = []
    const models = mkModels({
      stream: ((model: Model<Api>) => {
        seen.push(model)
        return toolCallStream({ capital: 'Paris' })
      }) as unknown as Models['stream']
    })
    return { models, seen }
  }

  it('swaps api and baseUrl when a schema is present and the key is set', async () => {
    const { models, seen } = captureModel()
    const provider = createModelsDispatch(models, 'openrouter', false, 'auto', 'openai-completions')
    await provider.dispatch(schemaRequest(), { credential: 'key', key: 'k' }, 'k')
    expect(seen[0]?.api).toBe('openai-completions')
    expect(seen[0]?.baseUrl).toBe('http://provider/v1')
  })

  it('keeps catalog metadata across the swap', async () => {
    const { models, seen } = captureModel()
    const provider = createModelsDispatch(models, 'openrouter', false, 'auto', 'openai-completions')
    await provider.dispatch(schemaRequest(), { credential: 'key', key: 'k' }, 'k')
    expect(seen[0]?.cost).toEqual({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0 })
    expect(seen[0]?.contextWindow).toBe(1000)
  })

  it('does not swap when no schema is present', async () => {
    const { models, seen } = captureModel()
    const provider = createModelsDispatch(models, 'openrouter', false, 'auto', 'openai-completions')
    await provider.dispatch(mkRequest(), { credential: 'key', key: 'k' }, 'k')
    expect(seen[0]?.api).toBe('anthropic-messages')
  })

  it('does not swap when the key is unset', async () => {
    const { models, seen } = captureModel()
    const provider = createModelsDispatch(models, 'openrouter', false, 'auto')
    await provider.dispatch(schemaRequest(), { credential: 'key', key: 'k' }, 'k')
    expect(seen[0]?.api).toBe('anthropic-messages')
  })
})

describe('structuredOutputApi without a provider baseUrl', () => {
  it('refuses rather than posting to the catalog entry’s path', async () => {
    const models = mkModels({ getProvider: (() => undefined) as unknown as Models['getProvider'] })
    const provider = createModelsDispatch(models, 'openrouter', false, 'auto', 'openai-completions')
    await expect(
      provider.dispatch(
        mkRequest({
          format: 'openai',
          structuredOutput: {
            name: 'cap',
            schema: {
              type: 'object',
              properties: { capital: { type: 'string' } },
              required: ['capital'],
              additionalProperties: false
            }
          }
        }),
        { credential: 'key', key: 'k' },
        'k'
      )
    ).rejects.toThrow(/no baseUrl to route structured output/)
  })
})

describe('structuredOutputApi swap drops api-specific metadata', () => {
  it('leaves compat and thinkingLevelMap behind with the old api', async () => {
    // compat is a conditional type on the api: OpenRouter's anthropic/* entries carry
    // supportsTemperature:false, which only the anthropic adapter reads. Carried across,
    // the openai adapter ignores it and sends a temperature the model rejects.
    const seen: Model<Api>[] = []
    const withCompat = {
      ...mkModel(),
      compat: { supportsTemperature: false },
      thinkingLevelMap: { low: 'low' }
    } as unknown as Model<Api>
    const models = mkModels({
      getModel: () => withCompat,
      stream: ((model: Model<Api>) => {
        seen.push(model)
        return toolCallStream({ capital: 'Paris' })
      }) as unknown as Models['stream']
    })
    const provider = createModelsDispatch(models, 'openrouter', false, 'auto', 'openai-completions')
    await provider.dispatch(
      mkRequest({
        format: 'openai',
        structuredOutput: {
          name: 'cap',
          schema: {
            type: 'object',
            properties: { capital: { type: 'string' } },
            required: ['capital'],
            additionalProperties: false
          }
        }
      }),
      { credential: 'key', key: 'k' },
      'k'
    )
    expect(seen[0]?.api).toBe('openai-completions')
    expect(seen[0]).not.toHaveProperty('compat')
    expect(seen[0]).not.toHaveProperty('thinkingLevelMap')
  })
})

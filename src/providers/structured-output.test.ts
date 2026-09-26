// src/providers/structured-output.test.ts

import { describe, expect, it } from 'bun:test'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  JsonObject,
  Model
} from '@earendil-works/pi-ai'

import { STRUCTURED_OUTPUT_TOOL, type StructuredOutput } from '../structured-output'

import { normalizeStructuredOutputEvents, prepareStructuredOutput } from './structured-output'

const constraint: StructuredOutput = {
  name: 'capital',
  description: 'Capital response',
  schema: {
    type: 'object',
    properties: { capital: { type: 'string' } },
    required: ['capital'],
    additionalProperties: false
  }
}

const mkModel = (api: string): Model<Api> =>
  ({
    id: 'm',
    name: 'M',
    api,
    provider: 'p',
    baseUrl: 'http://x',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 500
  }) as Model<Api>

const context: Context = { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }

const mkMessage = (content: AssistantMessage['content']): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'openai-completions',
  provider: 'p',
  model: 'm',
  usage: {
    input: 3,
    output: 5,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 8,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  },
  stopReason: 'toolUse',
  timestamp: 7
})

const privateCall = (args: JsonObject = { capital: 'Paris' }) => ({
  type: 'toolCall' as const,
  id: 'call-1',
  name: STRUCTURED_OUTPUT_TOOL,
  arguments: args
})

const iterate = async function* (
  events: AssistantMessageEvent[]
): AsyncIterable<AssistantMessageEvent> {
  for (const event of events) yield event
}

const collect = async (events: AssistantMessageEvent[]): Promise<AssistantMessageEvent[]> => {
  const out: AssistantMessageEvent[] = []
  for await (const event of normalizeStructuredOutputEvents(iterate(events))) out.push(event)
  return out
}

describe('prepareStructuredOutput native translation', () => {
  it('sends the chat wire shape to openai-completions backends', () => {
    const prepared = prepareStructuredOutput(
      mkModel('openai-completions'),
      context,
      constraint,
      'native'
    )
    expect(prepared.options).toEqual({
      samplingParams: {
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'capital',
            description: 'Capital response',
            strict: true,
            schema: constraint.schema
          }
        }
      }
    })
    expect(prepared.context).toBe(context)
    expect(prepared.normalizeEvents).toBe(false)
  })

  it('sends the responses wire shape to openai-responses backends', () => {
    const prepared = prepareStructuredOutput(
      mkModel('openai-responses'),
      context,
      constraint,
      'native'
    )
    expect(prepared.options).toEqual({
      samplingParams: {
        text: {
          format: {
            type: 'json_schema',
            name: 'capital',
            description: 'Capital response',
            strict: true,
            schema: constraint.schema
          }
        }
      }
    })
  })

  it('omits an absent description from the wire shape', () => {
    const prepared = prepareStructuredOutput(
      mkModel('openai-completions'),
      context,
      { name: 'capital', schema: constraint.schema },
      'native'
    )
    const params = prepared.options.samplingParams as Record<string, Record<string, unknown>>
    expect(params.response_format?.json_schema).toEqual({
      name: 'capital',
      strict: true,
      schema: constraint.schema
    })
  })

  it('fails closed for backends that never receive samplingParams', () => {
    expect(() =>
      prepareStructuredOutput(mkModel('openai-codex-responses'), context, constraint, 'native')
    ).toThrow(/native/)
    expect(() =>
      prepareStructuredOutput(mkModel('anthropic-messages'), context, constraint, 'native')
    ).toThrow(/anthropic-messages/)
  })
})

describe('prepareStructuredOutput constrained-tool translation', () => {
  it('forces one strict private tool with the adapter-specific choice', () => {
    const cases: [string, unknown][] = [
      ['anthropic-messages', { type: 'tool', name: STRUCTURED_OUTPUT_TOOL }],
      ['openai-completions', { type: 'function', function: { name: STRUCTURED_OUTPUT_TOOL } }],
      ['openai-responses', { type: 'function', name: STRUCTURED_OUTPUT_TOOL }],
      ['openai-codex-responses', 'required']
    ]
    for (const [api, toolChoice] of cases) {
      const prepared = prepareStructuredOutput(
        mkModel(api),
        context,
        constraint,
        'constrained-tool'
      )
      expect(prepared.context.tools).toEqual([
        {
          name: STRUCTURED_OUTPUT_TOOL,
          description: 'Capital response',
          parameters: constraint.schema,
          constrainedSampling: { type: 'json_schema', strict: 'require' }
        }
      ])
      expect(prepared.context.messages).toBe(context.messages)
      expect(prepared.options.toolChoice).toEqual(toolChoice)
      expect(prepared.normalizeEvents).toBe(true)
    }
  })

  it('describes the tool by schema name when the request omits a description', () => {
    const prepared = prepareStructuredOutput(
      mkModel('anthropic-messages'),
      context,
      { name: 'capital', schema: constraint.schema },
      'constrained-tool'
    )
    expect(prepared.context.tools?.[0]?.description).toBe('Return capital')
  })

  it('refuses to displace client tools', () => {
    expect(() =>
      prepareStructuredOutput(
        mkModel('anthropic-messages'),
        { ...context, tools: [{ name: 'lookup', description: '', parameters: {} }] },
        constraint,
        'constrained-tool'
      )
    ).toThrow(/tools/)
  })

  it('fails closed for an unknown backend api', () => {
    expect(() =>
      prepareStructuredOutput(
        mkModel('google-generative-ai'),
        context,
        constraint,
        'constrained-tool'
      )
    ).toThrow(/google-generative-ai/)
  })
})

describe('prepareStructuredOutput auto translation', () => {
  it('prefers native enforcement where the wire shape is known', () => {
    for (const api of ['openai-completions', 'openai-responses']) {
      const prepared = prepareStructuredOutput(mkModel(api), context, constraint, 'auto')
      expect(prepared.normalizeEvents).toBe(false)
      expect(prepared.options.samplingParams).toBeDefined()
    }
  })

  it('falls back to constrained tools for backends without a native mapping', () => {
    for (const api of ['anthropic-messages', 'openai-codex-responses']) {
      const prepared = prepareStructuredOutput(mkModel(api), context, constraint, 'auto')
      expect(prepared.normalizeEvents).toBe(true)
      expect(prepared.context.tools).toHaveLength(1)
    }
  })

  it('fails closed when neither path can enforce the schema', () => {
    expect(() =>
      prepareStructuredOutput(mkModel('google-generative-ai'), context, constraint, 'auto')
    ).toThrow(/auto/)
  })
})

describe('normalizeStructuredOutputEvents', () => {
  const partial = mkMessage([])

  it('republishes streamed tool arguments as text', async () => {
    const events = await collect([
      { type: 'start', partial },
      { type: 'toolcall_start', contentIndex: 0, partial },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"capital":', partial },
      { type: 'toolcall_delta', contentIndex: 0, delta: '"Paris"}', partial },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: privateCall(),
        partial
      },
      { type: 'done', reason: 'toolUse', message: mkMessage([privateCall()]) }
    ])

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'text_start',
      'text_delta',
      'text_delta',
      'text_end',
      'done'
    ])
    const deltas = events.filter((e) => e.type === 'text_delta').map((e) => e.delta)
    expect(deltas.join('')).toBe('{"capital":"Paris"}')
    const end = events.find((e) => e.type === 'text_end')
    expect(end?.content).toBe('{"capital":"Paris"}')
    expect(end?.contentIndex).toBe(0)

    const done = events.at(-1)
    if (done?.type !== 'done') throw new Error('missing done event')
    expect(done.reason).toBe('stop')
    expect(done.message.content).toEqual([{ type: 'text', text: '{"capital":"Paris"}' }])
    expect(done.message.stopReason).toBe('stop')
    expect(done.message.usage).toEqual(partial.usage)
    expect(done.message.model).toBe('m')
  })

  it('passes a reasoning backend through, keeping thinking outside the answer', async () => {
    const thinking = { type: 'thinking' as const, thinking: 'weighing options', signature: 'sig' }
    const events = await collect([
      { type: 'start', partial },
      { type: 'thinking_start', contentIndex: 0, partial },
      { type: 'thinking_delta', contentIndex: 0, delta: 'weighing options', partial },
      { type: 'thinking_end', contentIndex: 0, content: 'weighing options', partial },
      { type: 'toolcall_start', contentIndex: 1, partial },
      { type: 'toolcall_delta', contentIndex: 1, delta: '{"capital":"Paris"}', partial },
      { type: 'toolcall_end', contentIndex: 1, toolCall: privateCall(), partial },
      { type: 'done', reason: 'toolUse', message: mkMessage([thinking, privateCall()]) }
    ])

    expect(events.map((e) => e.type)).toEqual([
      'start',
      'thinking_start',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta',
      'text_end',
      'done'
    ])
    const done = events.at(-1)
    if (done?.type !== 'done') throw new Error('missing done event')
    expect(done.message.content).toEqual([{ type: 'text', text: '{"capital":"Paris"}' }])
  })

  it('keeps streamed bytes verbatim rather than reserializing the final arguments', async () => {
    const events = await collect([
      { type: 'start', partial },
      { type: 'toolcall_start', contentIndex: 0, partial },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{\n  "capital": "Paris"\n}', partial },
      { type: 'toolcall_end', contentIndex: 0, toolCall: privateCall(), partial },
      { type: 'done', reason: 'toolUse', message: mkMessage([privateCall()]) }
    ])
    const done = events.at(-1)
    if (done?.type !== 'done') throw new Error('missing done event')
    expect(done.message.content).toEqual([{ type: 'text', text: '{\n  "capital": "Paris"\n}' }])
  })

  it('serializes the final arguments when the backend streamed no deltas', async () => {
    const events = await collect([
      { type: 'start', partial },
      { type: 'toolcall_start', contentIndex: 0, partial },
      { type: 'toolcall_end', contentIndex: 0, toolCall: privateCall(), partial },
      { type: 'done', reason: 'toolUse', message: mkMessage([privateCall()]) }
    ])
    const end = events.find((e) => e.type === 'text_end')
    expect(end?.content).toBe('{"capital":"Paris"}')
  })

  it('forwards an upstream error untouched', async () => {
    const failure = { ...mkMessage([]), stopReason: 'error' as const, errorMessage: 'boom' }
    const events = await collect([
      { type: 'start', partial },
      { type: 'error', reason: 'error', error: failure }
    ])
    expect(events.map((e) => e.type)).toEqual(['start', 'error'])
    const err = events.at(-1)
    if (err?.type !== 'error') throw new Error('missing error event')
    expect(err.error.errorMessage).toBe('boom')
  })

  it('fails closed when the backend emits unconstrained text', async () => {
    await expect(
      collect([
        { type: 'start', partial },
        { type: 'text_start', contentIndex: 0, partial },
        { type: 'text_delta', contentIndex: 0, delta: 'Paris.', partial }
      ])
    ).rejects.toThrow(/structured output/)
  })

  it('fails closed on a tool call that is not the private schema tool', async () => {
    await expect(
      collect([
        { type: 'start', partial },
        { type: 'toolcall_start', contentIndex: 0, partial },
        {
          type: 'toolcall_end',
          contentIndex: 0,
          toolCall: { type: 'toolCall', id: 'c', name: 'lookup', arguments: {} },
          partial
        }
      ])
    ).rejects.toThrow(/lookup/)
  })

  it('fails closed when the final message is not exactly one schema tool call', async () => {
    await expect(
      collect([
        { type: 'start', partial },
        { type: 'toolcall_start', contentIndex: 0, partial },
        { type: 'toolcall_end', contentIndex: 0, toolCall: privateCall(), partial },
        {
          type: 'done',
          reason: 'toolUse',
          message: mkMessage([privateCall(), { type: 'text', text: 'extra' }])
        }
      ])
    ).rejects.toThrow(/structured output/)
  })

  it('fails closed when the emitted arguments are not valid JSON', async () => {
    await expect(
      collect([
        { type: 'start', partial },
        { type: 'toolcall_start', contentIndex: 0, partial },
        { type: 'toolcall_delta', contentIndex: 0, delta: '{"capital":', partial },
        { type: 'toolcall_end', contentIndex: 0, toolCall: privateCall(), partial },
        { type: 'done', reason: 'toolUse', message: mkMessage([privateCall()]) }
      ])
    ).rejects.toThrow(/JSON/)
  })
})

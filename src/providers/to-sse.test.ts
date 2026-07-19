// src/providers/to-sse.test.ts

import { describe, expect, it } from 'bun:test'
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai'

import {
  anthropicMessageToJson,
  createAnthropicSseStream,
  createOpenAiSseStream,
  createResponsesSseStream,
  openaiMessageToJson,
  responsesMessageToJson
} from './to-sse'

const makeUsage = (input = 100, output = 50) => ({
  input,
  output,
  cacheRead: 10,
  cacheWrite: 5,
  totalTokens: input + output + 10 + 5,
  cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.00005, total: 0.00315 }
})

const makePartial = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-sonnet-4-20250514',
  usage: makeUsage(),
  stopReason: 'stop',
  timestamp: Date.now(),
  ...overrides
})

const collectSseLines = async (stream: ReadableStream<Uint8Array>): Promise<string[]> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(decoder.decode(value, { stream: true }))
  }
  return chunks
    .join('')
    .split('\n')
    .filter((line) => line.length > 0)
}

const parseDataLines = (lines: string[]): unknown[] =>
  lines
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice(6))
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as unknown)

const requireLine = (line: string | undefined): string => {
  if (line === undefined) throw new Error('missing SSE data line')
  return line
}

const toAsyncIterable = async function* (
  events: AssistantMessageEvent[]
): AsyncIterable<AssistantMessageEvent> {
  for (const event of events) {
    yield event
  }
}

/** Parse raw SSE text into ordered list of {event, data} pairs. */
const parseSseEvents = (raw: string): { event: string; data: unknown }[] => {
  const results: { event: string; data: unknown }[] = []
  for (const block of raw.split('\n\n')) {
    const trimmed = block.trim()
    if (!trimmed) continue
    const eventLine = trimmed.split('\n').find((l) => l.startsWith('event: '))
    const dataLine = trimmed.split('\n').find((l) => l.startsWith('data: '))
    if (eventLine && dataLine) {
      results.push({
        event: eventLine.slice(7),
        data: JSON.parse(dataLine.slice(6))
      })
    }
  }
  return results
}

const drainStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(decoder.decode(value, { stream: true }))
  }
  return chunks.join('')
}

// --- Anthropic SSE contentIndex bug-fix tests ---

describe('createAnthropicSseStream - contentIndex state machine', () => {
  it('thinking-then-text WITHOUT thinking_end: auto-closes thinking block at index 0', async () => {
    const partial = makePartial()
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial },
      { type: 'thinking_start', contentIndex: 0, partial },
      { type: 'thinking_delta', contentIndex: 0, delta: 'hmm', partial },
      // No thinking_end — text_start arrives with new contentIndex
      { type: 'text_start', contentIndex: 1, partial },
      { type: 'text_delta', contentIndex: 1, delta: 'answer', partial },
      { type: 'text_end', contentIndex: 1, content: 'answer', partial },
      { type: 'done', reason: 'stop', message: makePartial() }
    ]
    const raw = await drainStream(createAnthropicSseStream(toAsyncIterable(events), 'r4', 'model'))
    const evts = parseSseEvents(raw)
    const types = evts.map((e) => e.event)
    // thinking_start → thinking_delta → auto content_block_stop[0] → text content_block_start[1] → text_delta → text content_block_stop[1]
    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop', // auto-emitted for thinking block
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect((evts[1]?.data as Record<string, unknown>).index).toBe(0)
    expect((evts[1]?.data as Record<string, unknown>).content_block).toMatchObject({
      type: 'thinking'
    })
    expect((evts[3]?.data as Record<string, unknown>).index).toBe(0) // auto-close for thinking
    expect((evts[4]?.data as Record<string, unknown>).index).toBe(1)
    expect((evts[4]?.data as Record<string, unknown>).content_block).toMatchObject({ type: 'text' })
    expect((evts[6]?.data as Record<string, unknown>).index).toBe(1)
  })

  it('done while block open: emits content_block_stop before message_delta', async () => {
    const partial = makePartial()
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial },
      { type: 'text_start', contentIndex: 0, partial },
      { type: 'text_delta', contentIndex: 0, delta: 'incomplete', partial },
      // No text_end
      { type: 'done', reason: 'stop', message: makePartial() }
    ]
    const raw = await drainStream(createAnthropicSseStream(toAsyncIterable(events), 'r5', 'model'))
    const evts = parseSseEvents(raw)
    const types = evts.map((e) => e.event)
    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop', // auto-emitted before done
      'message_delta',
      'message_stop'
    ])
    expect((evts[3]?.data as Record<string, unknown>).index).toBe(0)
  })

  it('error mid-stream while block open: emits content_block_stop then error', async () => {
    const partial = makePartial()
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial },
      { type: 'text_start', contentIndex: 0, partial },
      { type: 'text_delta', contentIndex: 0, delta: 'partial', partial },
      {
        type: 'error',
        reason: 'error',
        error: makePartial({ stopReason: 'error', errorMessage: 'upstream failed' })
      }
    ]
    const raw = await drainStream(createAnthropicSseStream(toAsyncIterable(events), 'r7', 'model'))
    const evts = parseSseEvents(raw)
    const types = evts.map((e) => e.event)
    expect(types).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop', // auto-emitted before error
      'error'
    ])
    expect((evts[3]?.data as Record<string, unknown>).index).toBe(0)
    expect((evts[4]?.data as Record<string, unknown>).type).toBe('error')
  })
})

// --- Anthropic SSE tests ---

describe('createAnthropicSseStream', () => {
  it('streams text: start → text_start → text_delta × N → text_end → done', async () => {
    const partial = makePartial()
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial },
      { type: 'text_start', contentIndex: 0, partial },
      { type: 'text_delta', contentIndex: 0, delta: 'Hello', partial },
      { type: 'text_delta', contentIndex: 0, delta: ' world', partial },
      { type: 'text_end', contentIndex: 0, content: 'Hello world', partial },
      { type: 'done', reason: 'stop', message: makePartial({ usage: makeUsage(100, 50) }) }
    ]

    const stream = createAnthropicSseStream(
      toAsyncIterable(events),
      'req-1',
      'claude-sonnet-4-20250514'
    )
    const lines = await collectSseLines(stream)

    // message_start
    const startLine = lines.find((l) => l.startsWith('data: ') && l.includes('"message_start"'))
    expect(startLine).toBeDefined()
    const startData = JSON.parse(requireLine(startLine).slice(6))
    expect(startData.type).toBe('message_start')
    expect(startData.message.id).toBe('req-1')
    expect(startData.message.model).toBe('claude-sonnet-4-20250514')
    expect(startData.message.role).toBe('assistant')
    expect(startData.message.usage.input_tokens).toBe(100)

    // content_block_start
    const blockStartLine = lines.find(
      (l) => l.startsWith('data: ') && l.includes('"content_block_start"')
    )
    expect(blockStartLine).toBeDefined()
    const blockStartData = JSON.parse(requireLine(blockStartLine).slice(6))
    expect(blockStartData.index).toBe(0)
    expect(blockStartData.content_block.type).toBe('text')

    // content_block_delta (two deltas)
    const deltaLines = lines.filter(
      (l) => l.startsWith('data: ') && l.includes('"content_block_delta"')
    )
    expect(deltaLines).toHaveLength(2)
    const delta1 = JSON.parse(requireLine(deltaLines[0]).slice(6))
    expect(delta1.delta.type).toBe('text_delta')
    expect(delta1.delta.text).toBe('Hello')
    const delta2 = JSON.parse(requireLine(deltaLines[1]).slice(6))
    expect(delta2.delta.text).toBe(' world')

    // content_block_stop
    const blockStopLine = lines.find(
      (l) => l.startsWith('data: ') && l.includes('"content_block_stop"')
    )
    expect(blockStopLine).toBeDefined()

    // message_delta with stop_reason
    const messageDeltaLine = lines.find(
      (l) => l.startsWith('data: ') && l.includes('"message_delta"')
    )
    expect(messageDeltaLine).toBeDefined()
    const messageDeltaData = JSON.parse(requireLine(messageDeltaLine).slice(6))
    expect(messageDeltaData.delta.stop_reason).toBe('end_turn')
    expect(messageDeltaData.usage.output_tokens).toBe(50)

    // message_stop
    const messageStopLine = lines.find(
      (l) => l.startsWith('data: ') && l.includes('"message_stop"')
    )
    expect(messageStopLine).toBeDefined()
  })

  it('streams thinking blocks', async () => {
    const partial = makePartial()
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial },
      { type: 'thinking_start', contentIndex: 0, partial },
      { type: 'thinking_delta', contentIndex: 0, delta: 'Let me think...', partial },
      { type: 'thinking_end', contentIndex: 0, content: 'Let me think...', partial },
      { type: 'text_start', contentIndex: 1, partial },
      { type: 'text_delta', contentIndex: 1, delta: 'Answer', partial },
      { type: 'text_end', contentIndex: 1, content: 'Answer', partial },
      { type: 'done', reason: 'stop', message: makePartial() }
    ]

    const stream = createAnthropicSseStream(
      toAsyncIterable(events),
      'req-2',
      'claude-sonnet-4-20250514'
    )
    const lines = await collectSseLines(stream)

    // thinking content_block_start
    const blockStarts = lines.filter(
      (l) => l.startsWith('data: ') && l.includes('"content_block_start"')
    )
    expect(blockStarts).toHaveLength(2)
    const thinkingStart = JSON.parse(requireLine(blockStarts[0]).slice(6))
    expect(thinkingStart.index).toBe(0)
    expect(thinkingStart.content_block.type).toBe('thinking')

    // thinking delta
    const thinkingDelta = lines.find(
      (l) => l.startsWith('data: ') && l.includes('"thinking_delta"')
    )
    expect(thinkingDelta).toBeDefined()
    const thinkingDeltaData = JSON.parse(requireLine(thinkingDelta).slice(6))
    expect(thinkingDeltaData.delta.thinking).toBe('Let me think...')

    // text block should be index 1
    const textStart = JSON.parse(requireLine(blockStarts[1]).slice(6))
    expect(textStart.index).toBe(1)
    expect(textStart.content_block.type).toBe('text')
  })

  it('streams tool calls', async () => {
    const partial = makePartial({
      content: [{ type: 'toolCall', id: 'tool_1', name: 'get_weather', arguments: {} }]
    })
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: makePartial() },
      { type: 'toolcall_start', contentIndex: 0, partial },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"loc', partial },
      { type: 'toolcall_delta', contentIndex: 0, delta: 'ation":"NYC"}', partial },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: {
          type: 'toolCall',
          id: 'tool_1',
          name: 'get_weather',
          arguments: { location: 'NYC' }
        },
        partial
      },
      { type: 'done', reason: 'toolUse', message: makePartial({ stopReason: 'toolUse' }) }
    ]

    const stream = createAnthropicSseStream(
      toAsyncIterable(events),
      'req-3',
      'claude-sonnet-4-20250514'
    )
    const lines = await collectSseLines(stream)

    // tool_use content_block_start
    const blockStart = lines.find(
      (l) => l.startsWith('data: ') && l.includes('"content_block_start"')
    )
    expect(blockStart).toBeDefined()
    const blockStartData = JSON.parse(requireLine(blockStart).slice(6))
    expect(blockStartData.content_block.type).toBe('tool_use')
    expect(blockStartData.content_block.id).toBe('tool_1')
    expect(blockStartData.content_block.name).toBe('get_weather')

    // input_json_delta
    const inputDeltas = lines.filter(
      (l) => l.startsWith('data: ') && l.includes('"input_json_delta"')
    )
    expect(inputDeltas).toHaveLength(2)
    const id1 = JSON.parse(requireLine(inputDeltas[0]).slice(6))
    expect(id1.delta.partial_json).toBe('{"loc')

    // stop reason should be tool_use
    const messageDelta = lines.find((l) => l.startsWith('data: ') && l.includes('"message_delta"'))
    const messageDeltaData = JSON.parse(requireLine(messageDelta).slice(6))
    expect(messageDeltaData.delta.stop_reason).toBe('tool_use')
  })

  it('maps stop reasons correctly', async () => {
    const testStopReason = async (piAiReason: 'stop' | 'length' | 'toolUse', expected: string) => {
      const events: AssistantMessageEvent[] = [
        { type: 'start', partial: makePartial() },
        { type: 'done', reason: piAiReason, message: makePartial({ stopReason: piAiReason }) }
      ]
      const stream = createAnthropicSseStream(toAsyncIterable(events), 'req-sr', 'model')
      const lines = await collectSseLines(stream)
      const messageDelta = lines.find(
        (l) => l.startsWith('data: ') && l.includes('"message_delta"')
      )
      const data = JSON.parse(requireLine(messageDelta).slice(6))
      expect(data.delta.stop_reason).toBe(expected)
    }

    await testStopReason('stop', 'end_turn')
    await testStopReason('toolUse', 'tool_use')
    await testStopReason('length', 'max_tokens')
  })

  it('handles error events', async () => {
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: makePartial() },
      {
        type: 'error',
        reason: 'error',
        error: makePartial({ stopReason: 'error', errorMessage: 'Something went wrong' })
      }
    ]

    const stream = createAnthropicSseStream(toAsyncIterable(events), 'req-err', 'model')
    const lines = await collectSseLines(stream)

    const errorLine = lines.find((l) => l.startsWith('data: ') && l.includes('"error"'))
    expect(errorLine).toBeDefined()
    const errorData = JSON.parse(requireLine(errorLine).slice(6))
    expect(errorData.type).toBe('error')
    expect(errorData.error.type).toBe('api_error')
    expect(errorData.error.message).toBe('Something went wrong')
  })

  it('tracks block index across multiple content blocks', async () => {
    const partial = makePartial()
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial },
      { type: 'text_start', contentIndex: 0, partial },
      { type: 'text_delta', contentIndex: 0, delta: 'First', partial },
      { type: 'text_end', contentIndex: 0, content: 'First', partial },
      { type: 'text_start', contentIndex: 1, partial },
      { type: 'text_delta', contentIndex: 1, delta: 'Second', partial },
      { type: 'text_end', contentIndex: 1, content: 'Second', partial },
      { type: 'done', reason: 'stop', message: makePartial() }
    ]

    const stream = createAnthropicSseStream(toAsyncIterable(events), 'req-bi', 'model')
    const lines = await collectSseLines(stream)

    const blockStarts = lines.filter(
      (l) => l.startsWith('data: ') && l.includes('"content_block_start"')
    )
    expect(blockStarts).toHaveLength(2)
    expect(JSON.parse(requireLine(blockStarts[0]).slice(6)).index).toBe(0)
    expect(JSON.parse(requireLine(blockStarts[1]).slice(6)).index).toBe(1)

    const blockStops = lines.filter(
      (l) => l.startsWith('data: ') && l.includes('"content_block_stop"')
    )
    expect(blockStops).toHaveLength(2)
    expect(JSON.parse(requireLine(blockStops[0]).slice(6)).index).toBe(0)
    expect(JSON.parse(requireLine(blockStops[1]).slice(6)).index).toBe(1)
  })
})

// --- OpenAI SSE tests ---

describe('createOpenAiSseStream', () => {
  it('streams text: start → text_delta × N → done', async () => {
    const partial = makePartial()
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial },
      { type: 'text_start', contentIndex: 0, partial },
      { type: 'text_delta', contentIndex: 0, delta: 'Hello', partial },
      { type: 'text_delta', contentIndex: 0, delta: ' world', partial },
      { type: 'text_end', contentIndex: 0, content: 'Hello world', partial },
      { type: 'done', reason: 'stop', message: makePartial({ usage: makeUsage(100, 50) }) }
    ]

    const stream = createOpenAiSseStream(toAsyncIterable(events), 'req-1', 'gpt-4')
    const lines = await collectSseLines(stream)
    const dataChunks = parseDataLines(lines)

    // First chunk: role announcement
    const firstChunk = dataChunks[0] as Record<string, unknown>
    expect(firstChunk.id).toBe('req-1')
    expect(firstChunk.object).toBe('chat.completion.chunk')
    expect(firstChunk.model).toBe('gpt-4')
    const firstChoice = (firstChunk.choices as Record<string, unknown>[])[0]
    if (!firstChoice) throw new Error('missing first choice')
    expect((firstChoice.delta as Record<string, unknown>).role).toBe('assistant')

    // Text deltas
    const textChunks = (dataChunks as Record<string, unknown>[]).filter((c) => {
      const choices = c.choices as Record<string, unknown>[] | undefined
      return choices?.[0]?.delta && 'content' in (choices[0].delta as Record<string, unknown>)
    })
    expect(textChunks).toHaveLength(2)
    const tc1Choices = textChunks[0]?.choices as Record<string, unknown>[]
    expect((tc1Choices[0]?.delta as Record<string, unknown>).content).toBe('Hello')

    // Final chunk with finish_reason
    const lastDataLine = lines.filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).at(-1)
    const lastChunk = JSON.parse(requireLine(lastDataLine).slice(6))
    const lastChoice = lastChunk.choices[0]
    expect(lastChoice.finish_reason).toBe('stop')

    // [DONE] sentinel
    const doneLine = lines.find((l) => l === 'data: [DONE]')
    expect(doneLine).toBeDefined()
  })

  it('skips thinking events (no OpenAI equivalent)', async () => {
    const partial = makePartial()
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial },
      { type: 'thinking_start', contentIndex: 0, partial },
      { type: 'thinking_delta', contentIndex: 0, delta: 'thinking...', partial },
      { type: 'thinking_end', contentIndex: 0, content: 'thinking...', partial },
      { type: 'text_start', contentIndex: 1, partial },
      { type: 'text_delta', contentIndex: 1, delta: 'Answer', partial },
      { type: 'text_end', contentIndex: 1, content: 'Answer', partial },
      { type: 'done', reason: 'stop', message: makePartial() }
    ]

    const stream = createOpenAiSseStream(toAsyncIterable(events), 'req-t', 'gpt-4')
    const lines = await collectSseLines(stream)
    const dataChunks = parseDataLines(lines)

    // Should not contain any thinking-related content
    const allJson = JSON.stringify(dataChunks)
    expect(allJson).not.toContain('thinking')

    // Should still have the text delta
    const textChunks = (dataChunks as Record<string, unknown>[]).filter((c) => {
      const choices = c.choices as Record<string, unknown>[] | undefined
      return choices?.[0]?.delta && 'content' in (choices[0].delta as Record<string, unknown>)
    })
    expect(textChunks).toHaveLength(1)
  })

  it('streams tool calls', async () => {
    const partial = makePartial({
      content: [{ type: 'toolCall', id: 'call_1', name: 'get_weather', arguments: {} }]
    })
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: makePartial() },
      { type: 'toolcall_start', contentIndex: 0, partial },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"loc', partial },
      { type: 'toolcall_delta', contentIndex: 0, delta: 'ation":"NYC"}', partial },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: {
          type: 'toolCall',
          id: 'call_1',
          name: 'get_weather',
          arguments: { location: 'NYC' }
        },
        partial
      },
      { type: 'done', reason: 'toolUse', message: makePartial({ stopReason: 'toolUse' }) }
    ]

    const stream = createOpenAiSseStream(toAsyncIterable(events), 'req-tc', 'gpt-4')
    const lines = await collectSseLines(stream)
    const dataChunks = parseDataLines(lines) as Record<string, unknown>[]

    // toolcall_start -> tool_calls array with id, name
    const toolStartChunk = dataChunks.find((c) => {
      const choices = c.choices as Record<string, unknown>[]
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
      return delta?.tool_calls !== undefined
    })
    expect(toolStartChunk).toBeDefined()
    const toolStartDelta = (toolStartChunk?.choices as Record<string, unknown>[])[0]
      ?.delta as Record<string, unknown>
    const toolCalls = toolStartDelta.tool_calls as Record<string, unknown>[]
    expect(toolCalls[0]?.id).toBe('call_1')
    expect((toolCalls[0]?.function as Record<string, unknown>).name).toBe('get_weather')

    // toolcall_delta -> arguments
    const toolDeltaChunks = dataChunks.filter((c) => {
      const choices = c.choices as Record<string, unknown>[]
      const delta = choices?.[0]?.delta as Record<string, unknown> | undefined
      const tcs = delta?.tool_calls as Record<string, unknown>[] | undefined
      return (
        tcs?.[0]?.function &&
        'arguments' in (tcs[0].function as Record<string, unknown>) &&
        !(tcs[0] as Record<string, unknown>).id
      )
    })
    expect(toolDeltaChunks).toHaveLength(2)

    // finish_reason should be tool_calls
    const lastDataLine = lines.filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).at(-1)
    const lastChunk = JSON.parse(requireLine(lastDataLine).slice(6))
    expect(lastChunk.choices[0].finish_reason).toBe('tool_calls')
  })

  it('maps stop reasons correctly', async () => {
    const testStopReason = async (piAiReason: 'stop' | 'length' | 'toolUse', expected: string) => {
      const events: AssistantMessageEvent[] = [
        { type: 'start', partial: makePartial() },
        { type: 'done', reason: piAiReason, message: makePartial({ stopReason: piAiReason }) }
      ]
      const stream = createOpenAiSseStream(toAsyncIterable(events), 'req-sr', 'model')
      const lines = await collectSseLines(stream)
      const lastDataLine = lines
        .filter((l) => l.startsWith('data: ') && !l.includes('[DONE]'))
        .at(-1)
      const data = JSON.parse(requireLine(lastDataLine).slice(6))
      expect(data.choices[0].finish_reason).toBe(expected)
    }

    await testStopReason('stop', 'stop')
    await testStopReason('toolUse', 'tool_calls')
    await testStopReason('length', 'length')
  })

  it('handles error events', async () => {
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: makePartial() },
      {
        type: 'error',
        reason: 'error',
        error: makePartial({ stopReason: 'error', errorMessage: 'Bad request' })
      }
    ]

    const stream = createOpenAiSseStream(toAsyncIterable(events), 'req-err', 'model')
    const lines = await collectSseLines(stream)

    const errorLine = lines.find((l) => l.startsWith('data: ') && l.includes('"api_error"'))
    expect(errorLine).toBeDefined()
    const errorData = JSON.parse(requireLine(errorLine).slice(6))
    expect(errorData.error.message).toBe('Bad request')
    expect(errorData.error.type).toBe('api_error')

    // Should end with [DONE]
    const doneLine = lines.find((l) => l === 'data: [DONE]')
    expect(doneLine).toBeDefined()
  })
})

// --- Non-streaming tests ---

describe('anthropicMessageToJson', () => {
  it('converts text-only message', () => {
    const message = makePartial({
      content: [{ type: 'text', text: 'Hello world' }],
      usage: makeUsage(100, 50)
    })

    const result = anthropicMessageToJson(message, 'req-1', 'claude-sonnet-4-20250514')
    expect(result.id).toBe('req-1')
    expect(result.type).toBe('message')
    expect(result.role).toBe('assistant')
    expect(result.model).toBe('claude-sonnet-4-20250514')
    expect(result.stop_reason).toBe('end_turn')
    expect(result.stop_sequence).toBeNull()

    const content = result.content as Record<string, unknown>[]
    expect(content).toHaveLength(1)
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text).toBe('Hello world')

    const usage = result.usage as Record<string, unknown>
    expect(usage.input_tokens).toBe(100)
    expect(usage.output_tokens).toBe(50)
    expect(usage.cache_read_input_tokens).toBe(10)
    expect(usage.cache_creation_input_tokens).toBe(5)
  })

  it('converts thinking content', () => {
    const message = makePartial({
      content: [
        { type: 'thinking', thinking: 'Let me reason...' },
        { type: 'text', text: 'The answer is 42.' }
      ]
    })

    const result = anthropicMessageToJson(message, 'req-2', 'model')
    const content = result.content as Record<string, unknown>[]
    expect(content).toHaveLength(2)
    expect(content[0]?.type).toBe('thinking')
    expect(content[0]?.thinking).toBe('Let me reason...')
    expect(content[1]?.type).toBe('text')
    expect(content[1]?.text).toBe('The answer is 42.')
  })

  it('converts tool use', () => {
    const message = makePartial({
      content: [
        { type: 'toolCall', id: 'tool_1', name: 'search', arguments: { query: 'weather' } }
      ],
      stopReason: 'toolUse'
    })

    const result = anthropicMessageToJson(message, 'req-3', 'model')
    expect(result.stop_reason).toBe('tool_use')

    const content = result.content as Record<string, unknown>[]
    expect(content).toHaveLength(1)
    expect(content[0]?.type).toBe('tool_use')
    expect(content[0]?.id).toBe('tool_1')
    expect(content[0]?.name).toBe('search')
    expect(content[0]?.input).toEqual({ query: 'weather' })
  })

  it('maps length stop reason', () => {
    const message = makePartial({ stopReason: 'length' })
    const result = anthropicMessageToJson(message, 'req-4', 'model')
    expect(result.stop_reason).toBe('max_tokens')
  })
})

describe('openaiMessageToJson', () => {
  it('converts text-only message', () => {
    const message = makePartial({
      content: [{ type: 'text', text: 'Hello world' }],
      usage: makeUsage(100, 50)
    })

    const result = openaiMessageToJson(message, 'req-1', 'gpt-4')
    expect(result.id).toBe('req-1')
    expect(result.object).toBe('chat.completion')
    expect(result.model).toBe('gpt-4')
    expect(typeof result.created).toBe('number')

    const choices = result.choices as Record<string, unknown>[]
    expect(choices).toHaveLength(1)
    const choice = choices[0]
    if (!choice) throw new Error('missing choice')
    expect(choice.index).toBe(0)
    expect(choice.finish_reason).toBe('stop')

    const msg = choice.message as Record<string, unknown>
    expect(msg.role).toBe('assistant')
    expect(msg.content).toBe('Hello world')
    expect(msg.tool_calls).toBeUndefined()

    const usage = result.usage as Record<string, unknown>
    expect(usage.prompt_tokens).toBe(100)
    expect(usage.completion_tokens).toBe(50)
    expect(usage.total_tokens).toBe(150)
  })

  it('converts tool calls', () => {
    const message = makePartial({
      content: [
        { type: 'text', text: 'Using a tool' },
        { type: 'toolCall', id: 'call_1', name: 'search', arguments: { q: 'test' } }
      ],
      stopReason: 'toolUse'
    })

    const result = openaiMessageToJson(message, 'req-2', 'gpt-4')
    const choices = result.choices as Record<string, unknown>[]
    const msg = choices[0]?.message as Record<string, unknown>
    expect(msg.content).toBe('Using a tool')
    expect(choices[0]?.finish_reason).toBe('tool_calls')

    const toolCalls = msg.tool_calls as Record<string, unknown>[]
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]?.id).toBe('call_1')
    expect(toolCalls[0]?.type).toBe('function')
    const fn = toolCalls[0]?.function as Record<string, unknown>
    expect(fn.name).toBe('search')
    expect(fn.arguments).toBe('{"q":"test"}')
  })

  it('returns null content when no text blocks', () => {
    const message = makePartial({
      content: [{ type: 'toolCall', id: 'call_1', name: 'fn', arguments: {} }],
      stopReason: 'toolUse'
    })

    const result = openaiMessageToJson(message, 'req-3', 'gpt-4')
    const msg = (result.choices as Record<string, unknown>[])[0]?.message as Record<string, unknown>
    expect(msg.content).toBeNull()
  })

  it('joins multiple text blocks', () => {
    const message = makePartial({
      content: [
        { type: 'text', text: 'Part 1' },
        { type: 'text', text: 'Part 2' }
      ]
    })

    const result = openaiMessageToJson(message, 'req-4', 'gpt-4')
    const msg = (result.choices as Record<string, unknown>[])[0]?.message as Record<string, unknown>
    expect(msg.content).toBe('Part 1Part 2')
  })

  it('maps stop reasons correctly', () => {
    const test = (stopReason: 'stop' | 'length' | 'toolUse', expected: string) => {
      const message = makePartial({ stopReason })
      const result = openaiMessageToJson(message, 'r', 'm')
      expect((result.choices as Record<string, unknown>[])[0]?.finish_reason).toBe(expected)
    }
    test('stop', 'stop')
    test('toolUse', 'tool_calls')
    test('length', 'length')
  })

  it('ignores thinking content in output', () => {
    const message = makePartial({
      content: [
        { type: 'thinking', thinking: 'internal' },
        { type: 'text', text: 'visible' }
      ]
    })

    const result = openaiMessageToJson(message, 'req-5', 'gpt-4')
    const msg = (result.choices as Record<string, unknown>[])[0]?.message as Record<string, unknown>
    expect(msg.content).toBe('visible')
  })
})

// --- Responses helpers ---

/** Drain a ReadableStream<Uint8Array> to a single string. */
const readStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(decoder.decode(value, { stream: true }))
  }
  return chunks.join('')
}

/** Build a minimal AssistantMessage for Responses encoder tests. */
const makeAssistantStubMessage = (
  text: string,
  toolCalls: {
    type: 'toolCall'
    id: string
    name: string
    arguments: Record<string, unknown>
  }[] = []
): AssistantMessage =>
  makePartial({
    content: [...(text ? [{ type: 'text' as const, text }] : []), ...toolCalls]
  })

// --- Responses SSE streaming tests ---

describe('createResponsesSseStream', () => {
  it('emits response.created then text deltas then response.completed for a simple text turn', async () => {
    const partial = makePartial()
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial },
      { type: 'text_start', contentIndex: 0, partial },
      { type: 'text_delta', contentIndex: 0, delta: 'Hello', partial },
      { type: 'text_delta', contentIndex: 0, delta: ' world', partial },
      { type: 'text_end', contentIndex: 0, content: 'Hello world', partial },
      { type: 'done', reason: 'stop', message: makeAssistantStubMessage('Hello world') }
    ]
    const stream = createResponsesSseStream(toAsyncIterable(events), 'req-1', 'gpt-4')
    const text = await readStream(stream)

    expect(text).toContain('event: response.created')
    expect(text).toContain('event: response.output_item.added')
    expect(text).toContain('event: response.content_part.added')
    expect(text).toContain('event: response.output_text.delta')
    expect(text).toContain('"delta":"Hello"')
    expect(text).toContain('"delta":" world"')
    expect(text).toContain('event: response.output_text.done')
    expect(text).toContain('event: response.content_part.done')
    expect(text).toContain('event: response.output_item.done')
    expect(text).toContain('event: response.completed')
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)

    // Verify ordering: response.created must appear before response.output_text.delta
    const createdIdx = text.indexOf('response.created')
    const deltaIdx = text.indexOf('response.output_text.delta')
    const completedIdx = text.indexOf('response.completed')
    const doneIdx = text.lastIndexOf('[DONE]')
    expect(createdIdx).toBeLessThan(deltaIdx)
    expect(deltaIdx).toBeLessThan(completedIdx)
    expect(completedIdx).toBeLessThan(doneIdx)
  })

  it('emits function_call events for a tool call', async () => {
    const partialWithTool = makePartial({
      content: [{ type: 'toolCall', id: 'call_x', name: 'fn', arguments: {} }]
    })
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial: makePartial() },
      { type: 'toolcall_start', contentIndex: 0, partial: partialWithTool },
      { type: 'toolcall_delta', contentIndex: 0, delta: '{"a":', partial: partialWithTool },
      { type: 'toolcall_delta', contentIndex: 0, delta: '1}', partial: partialWithTool },
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { type: 'toolCall', id: 'call_x', name: 'fn', arguments: { a: 1 } },
        partial: partialWithTool
      },
      {
        type: 'done',
        reason: 'toolUse',
        message: makeAssistantStubMessage('', [
          { type: 'toolCall', id: 'call_x', name: 'fn', arguments: { a: 1 } }
        ])
      }
    ]
    const stream = createResponsesSseStream(toAsyncIterable(events), 'req-2', 'gpt-4')
    const text = await readStream(stream)

    expect(text).toContain('event: response.output_item.added')
    expect(text).toContain('"type":"function_call"')
    expect(text).toContain('event: response.function_call_arguments.delta')
    expect(text).toContain('"delta":"{\\"a\\":')
    expect(text).toContain('event: response.function_call_arguments.done')
    expect(text).toContain('event: response.output_item.done')
    expect(text).toContain('event: response.completed')
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)
  })

  it('emits [DONE] sentinel last', async () => {
    const partial = makePartial()
    const events: AssistantMessageEvent[] = [
      { type: 'start', partial },
      { type: 'done', reason: 'stop', message: makeAssistantStubMessage('') }
    ]
    const stream = createResponsesSseStream(toAsyncIterable(events), 'req-3', 'gpt-4')
    const text = await readStream(stream)
    expect(text.trim().endsWith('data: [DONE]')).toBe(true)
  })
})

// --- Responses non-streaming JSON tests ---

describe('responsesMessageToJson', () => {
  it('encodes a text-only message as a Responses object', () => {
    const msg = makeAssistantStubMessage('Hello world')
    const out = responsesMessageToJson(msg, 'req-1', 'gpt-4')
    expect(out.id).toMatch(/^resp_/)
    expect(out.object).toBe('response')
    expect(out.model).toBe('gpt-4')
    expect(out.status).toBe('completed')
    const output = out.output as Record<string, unknown>[]
    expect(output).toHaveLength(1)
    expect(output[0]?.type).toBe('message')
    expect(output[0]?.role).toBe('assistant')
    const content = output[0]?.content as Record<string, unknown>[]
    expect(content[0]?.type).toBe('output_text')
    expect(content[0]?.text).toBe('Hello world')
  })

  it('includes usage when present', () => {
    const msg = makeAssistantStubMessage('hi')
    msg.usage = {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
    const out = responsesMessageToJson(msg, 'req-1', 'gpt-4')
    const usage = out.usage as Record<string, unknown>
    expect(usage.input_tokens).toBe(10)
    expect(usage.output_tokens).toBe(5)
    expect(usage.total_tokens).toBe(15)
  })

  it('encodes function calls as function_call output items', () => {
    const msg = makeAssistantStubMessage('', [
      { type: 'toolCall', id: 'call_x', name: 'fn', arguments: { a: 1 } }
    ])
    const out = responsesMessageToJson(msg, 'req-1', 'gpt-4')
    const output = out.output as Record<string, unknown>[]
    const fcItem = output.find((item) => item.type === 'function_call')
    expect(fcItem).toBeDefined()
    expect(fcItem?.call_id).toBe('call_x')
    expect(fcItem?.name).toBe('fn')
    expect(fcItem?.arguments).toBe('{"a":1}')
    expect(fcItem?.status).toBe('completed')
  })
})

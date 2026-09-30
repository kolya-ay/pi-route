// src/providers/to-sse.ts

import {
  type AssistantMessage,
  type AssistantMessageEvent,
  isContextOverflow,
  type ToolCall
} from '@earendil-works/pi-ai'

import type { IncomingRequest } from '../types'

// Several providers report an oversized prompt in a way that says nothing useful on
// its own — cerebras answers a 400 with an empty body, which pi-ai renders as
// "400 status code (no body)". pi-ai already knows that whole family, so name the
// cause rather than passing the opaque text straight through to the client.
//
// Note the detection of cerebras's bodyless form is gated inside pi-ai on the
// message's `provider`, which for pi-route is the operator's config key; an operator
// who renames that provider gets the original message back, not a wrong one.
export const describeStreamError = (error: AssistantMessage): string => {
  const message = error.errorMessage ?? 'pi-ai stream error'
  return isContextOverflow(error)
    ? `context overflow — the prompt exceeds this model's context window (upstream said: ${message})`
    : message
}

const mapAnthropicStopReason = (reason: string): string =>
  reason === 'stop'
    ? 'end_turn'
    : reason === 'toolUse'
      ? 'tool_use'
      : reason === 'length'
        ? 'max_tokens'
        : reason

const mapOpenAiFinishReason = (reason: string): string =>
  reason === 'stop'
    ? 'stop'
    : reason === 'toolUse'
      ? 'tool_calls'
      : reason === 'length'
        ? 'length'
        : reason

const sseEvent = (eventType: string, data: unknown): string =>
  `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`

const sseData = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`

const sseDone = (): string => 'data: [DONE]\n\n'

// --- Anthropic SSE streaming ---

// Anthropic blocks are strictly sequential, but pi-ai interleaves: one text and one
// thinking block per message, parallel tool calls by upstream index. So wire indices
// are the encoder's own — text that resurfaces opens anew — and tool calls, whose
// deltas would interleave, are sent whole on toolcall_end, with a ping per delta to
// keep the line warm. Tool input is JSON.stringify of pi-ai's parsed arguments, so
// truncated JSON arrives repaired or as {}. Thinking that resurfaces is a stray
// reasoning tail and is dropped: Claude Code reads the reply from the last block.
// `open` is the pi-ai contentIndex of the open wire block, whose index is next - 1;
// `closed` holds the contentIndexes whose blocks have stopped.
type SseState = { open: number | undefined; next: number; closed: Set<number> }

const closeOpen = (state: SseState): string => {
  if (state.open === undefined) return ''
  state.closed.add(state.open)
  state.open = undefined
  return sseEvent('content_block_stop', { type: 'content_block_stop', index: state.next - 1 })
}

const openBlock = (state: SseState, source: number, contentBlock: object): string => {
  const out =
    closeOpen(state) +
    sseEvent('content_block_start', {
      type: 'content_block_start',
      index: state.next++,
      content_block: contentBlock
    })
  state.open = source
  return out
}

const ensureOpen = (state: SseState, source: number, contentBlock: object): string =>
  state.open === source ? '' : openBlock(state, source, contentBlock)

const blockDelta = (state: SseState, delta: object): string =>
  sseEvent('content_block_delta', { type: 'content_block_delta', index: state.next - 1, delta })

const TEXT = { type: 'text', text: '' }
const THINKING = { type: 'thinking', thinking: '' }

const anthropicEventToSse = (
  event: AssistantMessageEvent,
  requestId: string,
  model: string,
  state: SseState
): string => {
  switch (event.type) {
    case 'start':
      return sseEvent('message_start', {
        type: 'message_start',
        message: {
          id: requestId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: event.partial.usage.input,
            cache_read_input_tokens: event.partial.usage.cacheRead,
            cache_creation_input_tokens: event.partial.usage.cacheWrite,
            output_tokens: 0
          }
        }
      })

    case 'text_start':
      return ensureOpen(state, event.contentIndex, TEXT)

    case 'text_delta':
      return (
        ensureOpen(state, event.contentIndex, TEXT) +
        blockDelta(state, { type: 'text_delta', text: event.delta })
      )

    case 'thinking_start':
      return state.closed.has(event.contentIndex)
        ? ''
        : ensureOpen(state, event.contentIndex, THINKING)

    case 'thinking_delta':
      if (state.closed.has(event.contentIndex)) return ''
      return (
        ensureOpen(state, event.contentIndex, THINKING) +
        blockDelta(state, { type: 'thinking_delta', thinking: event.delta })
      )

    case 'text_end':
    case 'thinking_end':
      return state.open === event.contentIndex ? closeOpen(state) : ''

    case 'toolcall_start':
      return ''

    case 'toolcall_delta':
      return sseEvent('ping', { type: 'ping' })

    case 'toolcall_end': {
      const { id, name, arguments: input } = event.toolCall
      return (
        openBlock(state, event.contentIndex, { type: 'tool_use', id, name, input: {} }) +
        blockDelta(state, { type: 'input_json_delta', partial_json: JSON.stringify(input) }) +
        closeOpen(state)
      )
    }

    case 'done':
      return (
        closeOpen(state) +
        sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: mapAnthropicStopReason(event.reason), stop_sequence: null },
          usage: { output_tokens: event.message.usage.output }
        }) +
        sseEvent('message_stop', { type: 'message_stop' })
      )

    case 'error':
      return (
        closeOpen(state) +
        sseEvent('error', {
          type: 'error',
          error: { type: 'api_error', message: describeStreamError(event.error) }
        })
      )
  }
}

export const createAnthropicSseStream = (
  events: AsyncIterable<AssistantMessageEvent>,
  requestId: string,
  model: string
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  const state: SseState = { open: undefined, next: 0, closed: new Set() }
  const iterator = events[Symbol.asyncIterator]()

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next()
      if (done) {
        controller.close()
        return
      }
      const sse = anthropicEventToSse(value, requestId, model, state)
      controller.enqueue(encoder.encode(sse))
    }
  })
}

// --- OpenAI SSE streaming ---

const openAiChunk = (
  requestId: string,
  model: string,
  choices: unknown[],
  usage?: unknown
): Record<string, unknown> => ({
  id: requestId,
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model,
  choices,
  ...(usage !== undefined ? { usage } : {})
})

const openAiEventToSse = (
  event: AssistantMessageEvent,
  requestId: string,
  model: string,
  getToolCallIndex: () => number,
  advanceToolCallIndex: () => void
): string | null => {
  switch (event.type) {
    case 'start':
      return sseData(
        openAiChunk(requestId, model, [
          { index: 0, delta: { role: 'assistant' }, finish_reason: null }
        ])
      )

    case 'text_delta':
      return sseData(
        openAiChunk(requestId, model, [
          { index: 0, delta: { content: event.delta }, finish_reason: null }
        ])
      )

    case 'toolcall_start': {
      const toolCallContent = event.partial.content[event.contentIndex] as ToolCall | undefined
      return sseData(
        openAiChunk(requestId, model, [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: getToolCallIndex(),
                  id: toolCallContent?.id ?? '',
                  type: 'function',
                  function: { name: toolCallContent?.name ?? '', arguments: '' }
                }
              ]
            },
            finish_reason: null
          }
        ])
      )
    }

    case 'toolcall_delta':
      return sseData(
        openAiChunk(requestId, model, [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: getToolCallIndex(), function: { arguments: event.delta } }]
            },
            finish_reason: null
          }
        ])
      )

    case 'toolcall_end':
      advanceToolCallIndex()
      return null

    case 'done':
      return (
        sseData(
          openAiChunk(
            requestId,
            model,
            [{ index: 0, delta: {}, finish_reason: mapOpenAiFinishReason(event.reason) }],
            {
              prompt_tokens: event.message.usage.input,
              completion_tokens: event.message.usage.output,
              total_tokens: event.message.usage.input + event.message.usage.output
            }
          )
        ) + sseDone()
      )

    case 'error':
      return (
        sseData({
          error: { message: describeStreamError(event.error), type: 'api_error' }
        }) + sseDone()
      )

    // text_start, text_end, thinking_* — no OpenAI equivalent
    case 'text_start':
    case 'text_end':
    case 'thinking_start':
    case 'thinking_delta':
    case 'thinking_end':
      return null
  }
}

export const createOpenAiSseStream = (
  events: AsyncIterable<AssistantMessageEvent>,
  requestId: string,
  model: string
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  const state = { toolCallIndex: 0 }
  const iterator = events[Symbol.asyncIterator]()

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        const { done, value } = await iterator.next()
        if (done) {
          controller.close()
          return
        }
        const sse = openAiEventToSse(
          value,
          requestId,
          model,
          () => state.toolCallIndex,
          () => {
            state.toolCallIndex += 1
          }
        )
        if (sse !== null) {
          controller.enqueue(encoder.encode(sse))
          return
        }
      }
    }
  })
}

// --- Non-streaming Anthropic JSON ---

const mapAnthropicContentBlock = (
  block: AssistantMessage['content'][number]
): Record<string, unknown> => {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'thinking':
      return { type: 'thinking', thinking: block.thinking }
    case 'toolCall':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.arguments }
  }
}

export const anthropicMessageToJson = (
  message: AssistantMessage,
  requestId: string,
  model: string
): Record<string, unknown> => ({
  id: requestId,
  type: 'message',
  role: 'assistant',
  content: message.content.map(mapAnthropicContentBlock),
  model,
  stop_reason: mapAnthropicStopReason(message.stopReason),
  stop_sequence: null,
  usage: {
    input_tokens: message.usage.input,
    output_tokens: message.usage.output,
    cache_read_input_tokens: message.usage.cacheRead,
    cache_creation_input_tokens: message.usage.cacheWrite
  }
})

// --- Responses SSE streaming + non-streaming JSON ---

const makeRespId = (requestId: string): string => `resp_${requestId}`
const makeMsgId = (requestId: string): string => `msg_${requestId}_${Date.now()}`
const makeFcId = (callId: string): string => `fc_${callId}`

const buildOutputItems = (message: AssistantMessage): Record<string, unknown>[] => {
  const items: Record<string, unknown>[] = []
  const textParts: string[] = []
  const toolCalls: ToolCall[] = []
  for (const part of message.content) {
    if (part.type === 'text') textParts.push(part.text)
    else if (part.type === 'toolCall') toolCalls.push(part)
  }
  if (textParts.length > 0) {
    items.push({
      type: 'message',
      id: makeMsgId('m'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: textParts.join(''), annotations: [] }]
    })
  }
  for (const tc of toolCalls) {
    items.push({
      type: 'function_call',
      id: makeFcId(tc.id),
      call_id: tc.id,
      name: tc.name,
      arguments: JSON.stringify(tc.arguments),
      status: 'completed'
    })
  }
  return items
}

const buildUsage = (message: AssistantMessage): Record<string, unknown> => {
  const usage: Record<string, unknown> = {
    input_tokens: message.usage.input,
    output_tokens: message.usage.output,
    total_tokens: message.usage.input + message.usage.output
  }
  if (message.usage.cacheRead > 0) {
    usage.input_tokens_details = { cached_tokens: message.usage.cacheRead }
  }
  return usage
}

const respEnvelope = (
  respId: string,
  model: string,
  status: string,
  output: Record<string, unknown>[],
  usage?: Record<string, unknown>
): Record<string, unknown> => ({
  id: respId,
  object: 'response',
  created_at: Math.floor(Date.now() / 1000),
  model,
  status,
  output,
  ...(usage !== undefined ? { usage } : {})
})

export const createResponsesSseStream = (
  events: AsyncIterable<AssistantMessageEvent>,
  requestId: string,
  requestedModel: string
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  const respId = makeRespId(requestId)

  return new ReadableStream({
    async start(controller) {
      const enq = (eventName: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`))
      }

      // In-band failure: the client already holds a 200, so the error must travel as
      // an event. After a cancel the controller is closed and enqueue throws; there is
      // nobody left to tell.
      const fail = (message: string) => {
        try {
          enq('response.failed', {
            type: 'response.failed',
            response: {
              ...respEnvelope(respId, requestedModel, 'failed', []),
              error: { code: 'server_error', message }
            }
          })
          controller.close()
        } catch {}
      }

      let outputIndex = 0
      let textItemId: string | null = null
      let textContentIndex = 0
      let accText = ''
      // key: contentIndex, value: tracked function call
      const openFcs = new Map<
        number,
        { itemId: string; callId: string; name: string; args: string }
      >()

      try {
        for await (const ev of events) {
          switch (ev.type) {
            case 'start':
              enq('response.created', {
                type: 'response.created',
                response: respEnvelope(respId, requestedModel, 'in_progress', [])
              })
              break

            case 'text_start': {
              const itemId = makeMsgId(requestId)
              textItemId = itemId
              textContentIndex = 0
              accText = ''
              enq('response.output_item.added', {
                type: 'response.output_item.added',
                output_index: outputIndex,
                item: {
                  type: 'message',
                  id: itemId,
                  status: 'in_progress',
                  role: 'assistant',
                  content: []
                }
              })
              enq('response.content_part.added', {
                type: 'response.content_part.added',
                item_id: itemId,
                output_index: outputIndex,
                content_index: textContentIndex,
                part: { type: 'output_text', text: '', annotations: [] }
              })
              break
            }

            case 'text_delta':
              if (textItemId) {
                accText += ev.delta
                enq('response.output_text.delta', {
                  type: 'response.output_text.delta',
                  item_id: textItemId,
                  output_index: outputIndex,
                  content_index: textContentIndex,
                  delta: ev.delta
                })
              }
              break

            case 'text_end':
              if (textItemId) {
                const text = ev.content ?? accText
                enq('response.output_text.done', {
                  type: 'response.output_text.done',
                  item_id: textItemId,
                  output_index: outputIndex,
                  content_index: textContentIndex,
                  text
                })
                enq('response.content_part.done', {
                  type: 'response.content_part.done',
                  item_id: textItemId,
                  output_index: outputIndex,
                  content_index: textContentIndex,
                  part: { type: 'output_text', text, annotations: [] }
                })
                enq('response.output_item.done', {
                  type: 'response.output_item.done',
                  output_index: outputIndex,
                  item: {
                    type: 'message',
                    id: textItemId,
                    status: 'completed',
                    role: 'assistant',
                    content: [{ type: 'output_text', text, annotations: [] }]
                  }
                })
                outputIndex += 1
                textItemId = null
              }
              break

            case 'toolcall_start': {
              const part = ev.partial.content[ev.contentIndex] as ToolCall | undefined
              const callId = part?.id ?? ''
              const name = part?.name ?? ''
              const itemId = makeFcId(callId)
              openFcs.set(ev.contentIndex, { itemId, callId, name, args: '' })
              enq('response.output_item.added', {
                type: 'response.output_item.added',
                output_index: outputIndex,
                item: {
                  type: 'function_call',
                  id: itemId,
                  call_id: callId,
                  name,
                  arguments: '',
                  status: 'in_progress'
                }
              })
              break
            }

            case 'toolcall_delta': {
              const fc = openFcs.get(ev.contentIndex)
              if (fc) {
                fc.args += ev.delta
                enq('response.function_call_arguments.delta', {
                  type: 'response.function_call_arguments.delta',
                  item_id: fc.itemId,
                  output_index: outputIndex,
                  delta: ev.delta
                })
              }
              break
            }

            case 'toolcall_end': {
              const fc = openFcs.get(ev.contentIndex)
              if (fc) {
                // Use streamed args if available, else serialize the final toolCall.arguments
                const args = fc.args || JSON.stringify(ev.toolCall.arguments ?? {})
                // Update ids/name from the finalized ToolCall
                fc.callId = ev.toolCall.id
                fc.name = ev.toolCall.name
                fc.itemId = makeFcId(fc.callId)
                enq('response.function_call_arguments.done', {
                  type: 'response.function_call_arguments.done',
                  item_id: fc.itemId,
                  output_index: outputIndex,
                  arguments: args,
                  name: fc.name
                })
                enq('response.output_item.done', {
                  type: 'response.output_item.done',
                  output_index: outputIndex,
                  item: {
                    type: 'function_call',
                    id: fc.itemId,
                    call_id: fc.callId,
                    name: fc.name,
                    arguments: args,
                    status: 'completed'
                  }
                })
                openFcs.delete(ev.contentIndex)
                outputIndex += 1
              }
              break
            }

            case 'done':
              enq('response.completed', {
                type: 'response.completed',
                response: respEnvelope(
                  respId,
                  requestedModel,
                  'completed',
                  buildOutputItems(ev.message),
                  buildUsage(ev.message)
                )
              })
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
              return

            case 'error':
              fail(describeStreamError(ev.error))
              return

            // thinking events — no Responses equivalent in v1
            case 'thinking_start':
            case 'thinking_delta':
            case 'thinking_end':
              break
          }
        }
        // Iterator exhausted without 'done' — close cleanly
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    }
  })
}

export const responsesMessageToJson = (
  message: AssistantMessage,
  requestId: string,
  requestedModel: string
): Record<string, unknown> =>
  respEnvelope(
    makeRespId(requestId),
    requestedModel,
    'completed',
    buildOutputItems(message),
    buildUsage(message)
  )

// --- Non-streaming OpenAI JSON ---

export const openaiMessageToJson = (
  message: AssistantMessage,
  requestId: string,
  model: string
): Record<string, unknown> => {
  const textBlocks = message.content.filter((b) => b.type === 'text')
  const toolCalls = message.content.filter((b): b is ToolCall => b.type === 'toolCall')

  const textContent =
    textBlocks.length > 0 ? textBlocks.map((b) => (b as { text: string }).text).join('') : null

  const messageObj: Record<string, unknown> = { role: 'assistant', content: textContent }

  if (toolCalls.length > 0) {
    messageObj.tool_calls = toolCalls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
    }))
  }

  return {
    id: requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: messageObj, finish_reason: mapOpenAiFinishReason(message.stopReason) }
    ],
    usage: {
      prompt_tokens: message.usage.input,
      completion_tokens: message.usage.output,
      total_tokens: message.usage.input + message.usage.output
    }
  }
}

export const formatSse = (
  format: IncomingRequest['format'],
  events: AsyncIterable<AssistantMessageEvent>,
  requestId: string,
  requestedModel: string
): ReadableStream =>
  format === 'anthropic'
    ? createAnthropicSseStream(events, requestId, requestedModel)
    : format === 'responses'
      ? createResponsesSseStream(events, requestId, requestedModel)
      : createOpenAiSseStream(events, requestId, requestedModel)

export const formatJson = (
  format: IncomingRequest['format'],
  message: AssistantMessage,
  requestId: string,
  requestedModel: string
): Record<string, unknown> =>
  format === 'anthropic'
    ? anthropicMessageToJson(message, requestId, requestedModel)
    : format === 'responses'
      ? responsesMessageToJson(message, requestId, requestedModel)
      : openaiMessageToJson(message, requestId, requestedModel)

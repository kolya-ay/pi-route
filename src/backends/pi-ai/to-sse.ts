// src/backends/pi-ai/to-sse.ts

import type { AssistantMessage, AssistantMessageEvent, ToolCall } from '@mariozechner/pi-ai'

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

const anthropicEventToSse = (
  event: AssistantMessageEvent,
  requestId: string,
  model: string,
  getBlockIndex: () => number,
  advanceBlockIndex: () => void
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
      return sseEvent('content_block_start', {
        type: 'content_block_start',
        index: getBlockIndex(),
        content_block: { type: 'text', text: '' }
      })

    case 'text_delta':
      return sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: getBlockIndex(),
        delta: { type: 'text_delta', text: event.delta }
      })

    case 'text_end': {
      const idx = getBlockIndex()
      advanceBlockIndex()
      return sseEvent('content_block_stop', { type: 'content_block_stop', index: idx })
    }

    case 'thinking_start':
      return sseEvent('content_block_start', {
        type: 'content_block_start',
        index: getBlockIndex(),
        content_block: { type: 'thinking', thinking: '' }
      })

    case 'thinking_delta':
      return sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: getBlockIndex(),
        delta: { type: 'thinking_delta', thinking: event.delta }
      })

    case 'thinking_end': {
      const idx = getBlockIndex()
      advanceBlockIndex()
      return sseEvent('content_block_stop', { type: 'content_block_stop', index: idx })
    }

    case 'toolcall_start': {
      const toolCallContent = event.partial.content[event.contentIndex] as ToolCall | undefined
      return sseEvent('content_block_start', {
        type: 'content_block_start',
        index: getBlockIndex(),
        content_block: {
          type: 'tool_use',
          id: toolCallContent?.id ?? '',
          name: toolCallContent?.name ?? '',
          input: {}
        }
      })
    }

    case 'toolcall_delta':
      return sseEvent('content_block_delta', {
        type: 'content_block_delta',
        index: getBlockIndex(),
        delta: { type: 'input_json_delta', partial_json: event.delta }
      })

    case 'toolcall_end': {
      const idx = getBlockIndex()
      advanceBlockIndex()
      return sseEvent('content_block_stop', { type: 'content_block_stop', index: idx })
    }

    case 'done':
      return (
        sseEvent('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: mapAnthropicStopReason(event.reason), stop_sequence: null },
          usage: { output_tokens: event.message.usage.output }
        }) + sseEvent('message_stop', { type: 'message_stop' })
      )

    case 'error':
      return sseEvent('error', {
        type: 'error',
        error: { type: 'api_error', message: event.error.errorMessage ?? 'Unknown error' }
      })
  }
}

export const createAnthropicSseStream = (
  events: AsyncIterable<AssistantMessageEvent>,
  requestId: string,
  model: string
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  const state = { blockIndex: 0 }
  const iterator = events[Symbol.asyncIterator]()

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await iterator.next()
      if (done) {
        controller.close()
        return
      }
      const sse = anthropicEventToSse(
        value,
        requestId,
        model,
        () => state.blockIndex,
        () => {
          state.blockIndex += 1
        }
      )
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
          error: { message: event.error.errorMessage ?? 'Unknown error', type: 'api_error' }
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
        // Skip null events (text_start, text_end, thinking_*, toolcall_end)
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

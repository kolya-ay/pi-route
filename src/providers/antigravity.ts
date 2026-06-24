// src/providers/antigravity.ts

import { arch, platform } from 'node:os'

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Message,
  type Model,
  type StreamOptions,
  type TextContent,
  type Tool,
  type ToolCall
} from '@mariozechner/pi-ai'

import type { Account, IncomingRequest, Provider, ProviderResponse } from '../types'

import { anthropicToContext, openaiToContext } from './to-context'
import {
  anthropicMessageToJson,
  createAnthropicSseStream,
  createOpenAiSseStream,
  openaiMessageToJson
} from './to-sse'

// --- Google Content types (local, minimal) ---

type GooglePart =
  | { text: string; thought?: boolean }
  | { functionCall: { name: string; args: Record<string, unknown>; id?: string } }
  | { functionResponse: { name: string; response: { output: string } } }

type GoogleContent = { role: 'user' | 'model'; parts: GooglePart[] }

// --- Parsed SSE chunk types ---

export type ParsedPart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'functionCall'; name: string; args: Record<string, unknown>; id?: string }
  | {
      type: 'usage'
      promptTokenCount: number
      candidatesTokenCount: number
      thoughtsTokenCount: number
      cachedContentTokenCount: number
    }
  | { type: 'finish'; reason: string }

// --- Context → Google Content conversion ---

const messageToContent = (msg: Message): GoogleContent => {
  switch (msg.role) {
    case 'user': {
      const parts: GooglePart[] =
        typeof msg.content === 'string'
          ? [{ text: msg.content }]
          : (msg.content as TextContent[])
              .filter((c): c is TextContent => c.type === 'text')
              .map((c) => ({ text: c.text }))
      return { role: 'user', parts }
    }
    case 'assistant': {
      const parts: GooglePart[] = msg.content.map((block) => {
        if (block.type === 'toolCall') {
          return { functionCall: { name: block.name, args: block.arguments, id: block.id } }
        }
        return { text: (block as TextContent).text }
      })
      return { role: 'model', parts }
    }
    case 'toolResult': {
      const text = msg.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
      return {
        role: 'user',
        parts: [{ functionResponse: { name: msg.toolName, response: { output: text } } }]
      }
    }
  }
}

export const contextToContents = (ctx: Context): GoogleContent[] =>
  ctx.messages.map(messageToContent)

// --- Cloud Code envelope ---

type EnvelopeParams = {
  projectId: string
  modelId: string
  contents: GoogleContent[]
  maxOutputTokens: number
  temperature: number
  systemPrompt?: string
  tools?: Tool[]
}

export const buildEnvelope = (params: EnvelopeParams): Record<string, unknown> => ({
  project: params.projectId,
  model: params.modelId,
  request: {
    contents: params.contents,
    ...(params.systemPrompt !== undefined
      ? { systemInstruction: { role: 'user', parts: [{ text: params.systemPrompt }] } }
      : {}),
    generationConfig: {
      maxOutputTokens: params.maxOutputTokens,
      temperature: params.temperature,
      thinkingConfig: { includeThoughts: true }
    },
    ...(params.tools !== undefined && params.tools.length > 0
      ? {
          tools: [
            {
              functionDeclarations: params.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters
              }))
            }
          ],
          toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } }
        }
      : {})
  },
  requestType: 'agent',
  userAgent: 'antigravity',
  requestId: `agent-${crypto.randomUUID()}`
})

// --- SSE response parsing ---

export const parseCloudCodeChunk = (chunk: Record<string, unknown>): ParsedPart[] => {
  const response = chunk.response as Record<string, unknown> | undefined
  if (!response) return []

  const candidates = response.candidates as Record<string, unknown>[] | undefined
  if (!candidates || candidates.length === 0) return []

  const candidate = candidates[0]!
  const content = candidate.content as
    | { role: string; parts: Record<string, unknown>[] }
    | undefined
  const rawParts = content?.parts ?? []

  const parsed: ParsedPart[] = rawParts.map((part) => {
    if (part.functionCall !== undefined) {
      const fc = part.functionCall as { name: string; args: Record<string, unknown>; id?: string }
      return {
        type: 'functionCall' as const,
        name: fc.name,
        args: fc.args,
        ...(fc.id !== undefined ? { id: fc.id } : {})
      }
    }
    if (part.thought === true) {
      return { type: 'thinking' as const, text: part.text as string }
    }
    return { type: 'text' as const, text: part.text as string }
  })

  const finishReason = candidate.finishReason as string | undefined
  if (finishReason !== undefined) {
    parsed.push({ type: 'finish', reason: finishReason })
  }

  const usage = response.usageMetadata as Record<string, number> | undefined
  if (usage !== undefined) {
    parsed.push({
      type: 'usage',
      promptTokenCount: usage.promptTokenCount ?? 0,
      candidatesTokenCount: usage.candidatesTokenCount ?? 0,
      thoughtsTokenCount: usage.thoughtsTokenCount ?? 0,
      cachedContentTokenCount: usage.cachedContentTokenCount ?? 0
    })
  }

  return parsed
}

// --- SSE line parser ---

const parseSseLine = (line: string): Record<string, unknown> | null => {
  if (!line.startsWith('data: ')) return null
  const json = line.slice(6).trim()
  if (json === '' || json === '[DONE]') return null
  try {
    return JSON.parse(json) as Record<string, unknown>
  } catch {
    return null
  }
}

// --- Default usage ---

const defaultUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

// --- Map Cloud Code finish reason to pi-ai StopReason ---

const mapFinishReason = (reason: string): 'stop' | 'length' | 'toolUse' =>
  reason === 'STOP'
    ? 'stop'
    : reason === 'MAX_TOKENS'
      ? 'length'
      : reason === 'TOOL_USE'
        ? 'toolUse'
        : 'stop'

// --- Stream function ---

const PRIMARY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com'
const FALLBACK_ENDPOINT = 'https://daily-cloudcode-pa.sandbox.googleapis.com'
const RETRY_DELAYS_MS = [1000, 2000, 4000]

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const fetchWithRetry = async (
  url: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Response> => {
  const endpoints = [PRIMARY_ENDPOINT, FALLBACK_ENDPOINT]

  for (const endpoint of endpoints) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (signal?.aborted) throw new Error('Aborted')

      try {
        const response = await fetch(`${endpoint}${url}`, init)
        if (response.ok) return response
        if (response.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]!)
          continue
        }
        // Non-retryable error or exhausted retries on this endpoint
        if (response.status >= 500) break // try fallback endpoint
        throw new Error(`Cloud Code API error: ${response.status} ${response.statusText}`)
      } catch (error) {
        if (error instanceof TypeError && attempt < RETRY_DELAYS_MS.length) {
          // Network error, retry
          await sleep(RETRY_DELAYS_MS[attempt]!)
          continue
        }
        if (error instanceof TypeError) break // try fallback endpoint
        throw error
      }
    }
  }

  throw new Error('Cloud Code API: all endpoints and retries exhausted')
}

const processStream = async (
  response: Response,
  eventStream: AssistantMessageEventStream,
  model: Model<Api>
): Promise<void> => {
  const reader = response.body?.getReader()
  if (!reader) {
    eventStream.push({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: defaultUsage(),
        stopReason: 'error',
        errorMessage: 'No response body',
        timestamp: Date.now()
      }
    })
    return
  }

  const decoder = new TextDecoder()
  const partial: AssistantMessage = {
    role: 'assistant',
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: defaultUsage(),
    stopReason: 'stop',
    timestamp: Date.now()
  }

  eventStream.push({ type: 'start', partial })

  let buffer = ''
  let finishReason: string | undefined
  let contentIndex = 0

  const processChunk = (chunk: Record<string, unknown>) => {
    const parts = parseCloudCodeChunk(chunk)

    parts.forEach((part) => {
      switch (part.type) {
        case 'thinking': {
          const idx = contentIndex
          partial.content = [...partial.content, { type: 'thinking', thinking: part.text }]
          contentIndex = partial.content.length
          eventStream.push({ type: 'thinking_start', contentIndex: idx, partial })
          eventStream.push({ type: 'thinking_delta', contentIndex: idx, delta: part.text, partial })
          eventStream.push({ type: 'thinking_end', contentIndex: idx, content: part.text, partial })
          break
        }
        case 'text': {
          const idx = contentIndex
          partial.content = [...partial.content, { type: 'text', text: part.text }]
          contentIndex = partial.content.length
          eventStream.push({ type: 'text_start', contentIndex: idx, partial })
          eventStream.push({ type: 'text_delta', contentIndex: idx, delta: part.text, partial })
          eventStream.push({ type: 'text_end', contentIndex: idx, content: part.text, partial })
          break
        }
        case 'functionCall': {
          const idx = contentIndex
          const toolCall: ToolCall = {
            type: 'toolCall',
            id: part.id ?? '',
            name: part.name,
            arguments: part.args
          }
          partial.content = [...partial.content, toolCall]
          contentIndex = partial.content.length
          eventStream.push({ type: 'toolcall_start', contentIndex: idx, partial })
          eventStream.push({
            type: 'toolcall_delta',
            contentIndex: idx,
            delta: JSON.stringify(part.args),
            partial
          })
          eventStream.push({ type: 'toolcall_end', contentIndex: idx, toolCall, partial })
          break
        }
        case 'usage':
          partial.usage = {
            input: part.promptTokenCount,
            output: part.candidatesTokenCount,
            cacheRead: part.cachedContentTokenCount,
            cacheWrite: 0,
            totalTokens:
              part.promptTokenCount + part.candidatesTokenCount + part.thoughtsTokenCount,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
          break
        case 'finish':
          finishReason = part.reason
          break
      }
    })
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      lines.forEach((line) => {
        const parsed = parseSseLine(line)
        if (parsed !== null) processChunk(parsed)
      })
    }

    // Process remaining buffer
    if (buffer.trim() !== '') {
      const parsed = parseSseLine(buffer)
      if (parsed !== null) processChunk(parsed)
    }

    const stopReason = finishReason !== undefined ? mapFinishReason(finishReason) : 'stop'
    partial.stopReason = stopReason

    if (stopReason === 'toolUse') {
      eventStream.push({ type: 'done', reason: 'toolUse', message: { ...partial } })
    } else if (stopReason === 'length') {
      eventStream.push({ type: 'done', reason: 'length', message: { ...partial } })
    } else {
      eventStream.push({ type: 'done', reason: 'stop', message: { ...partial } })
    }
  } catch (error) {
    partial.stopReason = 'error'
    partial.errorMessage = error instanceof Error ? error.message : String(error)
    eventStream.push({ type: 'error', reason: 'error', error: { ...partial } })
  }
}

export const streamAntigravity = (
  model: Model<Api>,
  context: Context,
  options?: StreamOptions
): AssistantMessageEventStream => {
  const eventStream = createAssistantMessageEventStream()

  const apiKeyJson = options?.apiKey
  if (!apiKeyJson) {
    const errorMsg: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: defaultUsage(),
      stopReason: 'error',
      errorMessage: 'Missing apiKey (expected JSON with token and projectId)',
      timestamp: Date.now()
    }
    queueMicrotask(() => eventStream.push({ type: 'error', reason: 'error', error: errorMsg }))
    return eventStream
  }

  const { token, projectId } = JSON.parse(apiKeyJson) as { token: string; projectId: string }
  const contents = contextToContents(context)
  const envelope = buildEnvelope({
    projectId,
    modelId: model.id,
    contents,
    maxOutputTokens: options?.maxTokens ?? model.maxTokens,
    temperature: options?.temperature ?? 0.7,
    ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}),
    ...(context.tools !== undefined ? { tools: context.tools } : {})
  })

  const userAgent = `antigravity/1.104.0 ${platform()}/${arch()}`

  const doStream = async () => {
    try {
      const response = await fetchWithRetry(
        '/v1/stream',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'User-Agent': userAgent
          },
          body: JSON.stringify(envelope),
          ...(options?.signal !== undefined ? { signal: options.signal } : {})
        },
        options?.signal
      )
      await processStream(response, eventStream, model)
    } catch (error) {
      const errorMsg: AssistantMessage = {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: defaultUsage(),
        stopReason: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now()
      }
      eventStream.push({ type: 'error', reason: 'error', error: errorMsg })
    }
  }

  doStream()
  return eventStream
}

// --- Direct provider ---

export const createAntigravityProvider = (name: string, _baseUrl: string): Provider => ({
  name,
  type: 'antigravity',

  async dispatch(
    request: IncomingRequest,
    account: Account,
    apiKey: string
  ): Promise<ProviderResponse> {
    const start = Date.now()

    const body = JSON.parse(await request.rawRequest.text()) as Record<string, unknown>
    const context =
      request.format === 'anthropic' ? anthropicToContext(body) : openaiToContext(body)

    const model = {
      id: request.model,
      api: 'google-antigravity' as Api,
      provider: 'google-antigravity',
      maxTokens: (body.max_tokens as number) ?? 8192
    } as Model<Api>

    if (request.stream) {
      const eventStream = streamAntigravity(model, context, { apiKey })
      const sseBody =
        request.format === 'anthropic'
          ? createAnthropicSseStream(eventStream, request.id, request.model)
          : createOpenAiSseStream(eventStream, request.id, request.model)

      return {
        status: 200,
        headers: new Headers({
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        }),
        body: sseBody,
        metadata: {
          requestId: request.id,
          provider: name,
          model: request.model,
          latencyMs: Date.now() - start,
          ...('name' in account ? { account: account.name } : {})
        }
      }
    }

    const eventStream = streamAntigravity(model, context, { apiKey })
    let message: AssistantMessage | undefined
    for await (const event of eventStream) {
      if (event.type === 'done') {
        message = event.message
      }
      if (event.type === 'error') {
        throw new Error(event.error.errorMessage ?? 'Antigravity stream error')
      }
    }

    if (!message) throw new Error('No response from Antigravity stream')

    const responseBody =
      request.format === 'anthropic'
        ? anthropicMessageToJson(message, request.id, request.model)
        : openaiMessageToJson(message, request.id, request.model)

    return {
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: responseBody,
      metadata: {
        requestId: request.id,
        provider: name,
        model: request.model,
        latencyMs: Date.now() - start,
        ...('name' in account ? { account: account.name } : {})
      }
    }
  }
})

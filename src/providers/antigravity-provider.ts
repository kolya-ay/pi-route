// src/providers/antigravity-provider.ts
//
// Google Antigravity provider on pi-ai's `Provider` interface. Models are
// purely dynamic: `fetchModels` discovers the account's catalog from Cloud
// Code's `fetchAvailableModels`, and streaming speaks Cloud Code's Google-wire
// protocol over SSE. The Google-wire conversion, SSE parsing, and endpoint
// fallback are ported from the retired `antigravity.ts`; the route-facing
// dispatch wrapper is not — pi-ai's `Models` owns dispatch now.

import { arch, platform } from 'node:os'

import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  createProvider,
  type Message,
  type Model,
  type Provider,
  type RefreshModelsContext,
  type StreamOptions,
  type TextContent,
  type Tool,
  type ToolCall
} from '@earendil-works/pi-ai'

import { antigravityOAuth, PROJECT_HEADER } from '../auth/antigravity-auth'
import type { FetchFn } from '../models/fetch-timeout'
import { deadlined } from '../models/fetch-timeout'

// A narrower fetch than `typeof fetch` (mirrors cached-catalog.ts): Bun's mocks
// and bare `async () => Response` are assignable without the `preconnect` prop.
// Custom API tag: only this provider streams it, so `Models` routes every
// discovered model back through `streamAntigravity`.
const ANTIGRAVITY_API = 'google-antigravity' as Api
const PRIMARY_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com'
const ENDPOINTS = [PRIMARY_ENDPOINT, 'https://daily-cloudcode-pa.sandbox.googleapis.com']
const DENYLIST = new Set(['chat_20706', 'chat_23310', 'gemini-2.5-pro'])
const DEFAULT_CONTEXT = 200_000
const DEFAULT_OUTPUT = 64_000
const RETRY_DELAYS_MS = [1000, 2000, 4000]
const ANTIGRAVITY_USER_AGENT = `antigravity/1.104.0 ${platform()}/${arch()}`

// --- Model discovery ---

export const parseDiscovery = (
  providerId: string,
  baseUrl: string,
  payload: unknown
): Model<Api>[] => {
  const models = (payload as { models?: Record<string, Record<string, unknown>> })?.models ?? {}
  return Object.entries(models)
    .filter(([id, m]) => !DENYLIST.has(id) && m.isInternal !== true)
    .map(([id, m]) => ({
      id,
      name: typeof m.displayName === 'string' && m.displayName ? m.displayName : id,
      api: ANTIGRAVITY_API,
      provider: providerId,
      baseUrl,
      reasoning: m.supportsThinking === true,
      input: (m.supportsImages === true ? ['text', 'image'] : ['text']) as ('text' | 'image')[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow:
        typeof m.maxTokens === 'number' && m.maxTokens > 0 ? m.maxTokens : DEFAULT_CONTEXT,
      maxTokens:
        typeof m.maxOutputTokens === 'number' && m.maxOutputTokens > 0
          ? m.maxOutputTokens
          : DEFAULT_OUTPUT
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

// --- Google Content types (local, minimal) ---

type GooglePart =
  | { text: string; thought?: boolean }
  | { functionCall: { name: string; args: Record<string, unknown>; id?: string } }
  | { functionResponse: { name: string; response: { output: string } } }

type GoogleContent = { role: 'user' | 'model'; parts: GooglePart[] }

const messageToContent = (msg: Message): GoogleContent => {
  switch (msg.role) {
    case 'user': {
      const parts: GooglePart[] =
        typeof msg.content === 'string'
          ? [{ text: msg.content }]
          : msg.content
              .filter((c): c is TextContent => c.type === 'text')
              .map((c) => ({ text: c.text }))
      return { role: 'user', parts }
    }
    case 'assistant': {
      const parts: GooglePart[] = msg.content.map((block) => {
        if (block.type === 'toolCall') {
          return { functionCall: { name: block.name, args: block.arguments, id: block.id } }
        }
        if (block.type === 'thinking') {
          return { text: block.thinking, thought: true }
        }
        return { text: block.text }
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
  modelId: string
  contents: GoogleContent[]
  maxOutputTokens: number
  temperature: number
  projectId?: string
  systemPrompt?: string
  tools?: Tool[]
}

export const buildEnvelope = (params: EnvelopeParams): Record<string, unknown> => ({
  ...(params.projectId !== undefined ? { project: params.projectId } : {}),
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

// --- SSE chunk parsing ---

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

export const parseCloudCodeChunk = (chunk: Record<string, unknown>): ParsedPart[] => {
  const response = chunk.response as Record<string, unknown> | undefined
  if (!response) return []

  const candidates = response.candidates as Record<string, unknown>[] | undefined
  if (!candidates || candidates.length === 0) return []

  const candidate = candidates[0]
  if (!candidate) return []
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

const defaultUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

const mapFinishReason = (reason: string): 'stop' | 'length' | 'toolUse' =>
  reason === 'STOP'
    ? 'stop'
    : reason === 'MAX_TOKENS'
      ? 'length'
      : reason === 'TOOL_USE'
        ? 'toolUse'
        : 'stop'

// --- Streaming ---

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// Try each endpoint in turn, retrying 5xx/network errors with backoff before
// falling through to the next. `path` is appended to every endpoint base.
const fetchWithRetry = async (
  fetchFn: FetchFn,
  path: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<Response> => {
  for (const endpoint of ENDPOINTS) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (signal?.aborted) throw new Error('Aborted')

      try {
        const response = await fetchFn(`${endpoint}${path}`, init)
        if (response.ok) return response
        if (response.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[attempt]
          if (delay === undefined) break
          await sleep(delay)
          continue
        }
        if (response.status >= 500) break // exhausted retries; try next endpoint
        throw new Error(`Cloud Code API error: ${response.status} ${response.statusText}`)
      } catch (error) {
        if (error instanceof TypeError && attempt < RETRY_DELAYS_MS.length) {
          const delay = RETRY_DELAYS_MS[attempt]
          if (delay === undefined) break
          await sleep(delay)
          continue
        }
        if (error instanceof TypeError) break // network error; try next endpoint
        throw error
      }
    }
  }

  throw new Error('Cloud Code API: all endpoints and retries exhausted')
}

const errorMessage = (model: Model<Api>, message: string): AssistantMessage => ({
  role: 'assistant',
  content: [],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: defaultUsage(),
  stopReason: 'error',
  errorMessage: message,
  timestamp: Date.now()
})

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
      error: errorMessage(model, 'No response body')
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
    parseCloudCodeChunk(chunk).forEach((part) => {
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

    if (buffer.trim() !== '') {
      const parsed = parseSseLine(buffer)
      if (parsed !== null) processChunk(parsed)
    }

    const stopReason = finishReason !== undefined ? mapFinishReason(finishReason) : 'stop'
    partial.stopReason = stopReason
    eventStream.push({ type: 'done', reason: stopReason, message: { ...partial } })
  } catch (error) {
    partial.stopReason = 'error'
    partial.errorMessage = error instanceof Error ? error.message : String(error)
    eventStream.push({ type: 'error', reason: 'error', error: { ...partial } })
  }
}

// The resolved OAuth access token arrives as `options.apiKey`, and the Cloud
// Code projectId as the `PROJECT_HEADER` pseudo-header (both emitted by
// `antigravityOAuth.toAuth`). The pseudo-header only feeds the envelope's
// `project` field — the upstream request carries the fixed header set below,
// so it is never sent to Google.
export const streamAntigravity = (
  fetchFn: FetchFn,
  model: Model<Api>,
  context: Context,
  options?: StreamOptions
): AssistantMessageEventStream => {
  const eventStream = createAssistantMessageEventStream()

  const token = options?.apiKey
  if (!token) {
    queueMicrotask(() =>
      eventStream.push({
        type: 'error',
        reason: 'error',
        error: errorMessage(model, 'Missing access token')
      })
    )
    return eventStream
  }

  const projectId = options?.headers?.[PROJECT_HEADER]
  const envelope = buildEnvelope({
    modelId: model.id,
    contents: contextToContents(context),
    maxOutputTokens: options?.maxTokens ?? model.maxTokens,
    temperature: options?.temperature ?? 0.7,
    ...(typeof projectId === 'string' ? { projectId } : {}),
    ...(context.systemPrompt !== undefined ? { systemPrompt: context.systemPrompt } : {}),
    ...(context.tools !== undefined ? { tools: context.tools } : {})
  })

  const doStream = async () => {
    try {
      const response = await fetchWithRetry(
        fetchFn,
        '/v1/stream',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            'User-Agent': ANTIGRAVITY_USER_AGENT
          },
          body: JSON.stringify(envelope),
          ...(options?.signal !== undefined ? { signal: options.signal } : {})
        },
        options?.signal
      )
      await processStream(response, eventStream, model)
    } catch (error) {
      eventStream.push({
        type: 'error',
        reason: 'error',
        error: errorMessage(model, error instanceof Error ? error.message : String(error))
      })
    }
  }

  doStream()
  return eventStream
}

// --- Provider ---

export const antigravityProvider = (id: string, fetchFn: FetchFn = deadlined(fetch)): Provider =>
  createProvider({
    id,
    name: id,
    baseUrl: PRIMARY_ENDPOINT,
    auth: { oauth: antigravityOAuth({ fetchFn }) },
    models: [],
    fetchModels: async (context: RefreshModelsContext) => {
      const token = context.credential?.type === 'oauth' ? context.credential.access : undefined
      if (!token) return []
      for (const endpoint of ENDPOINTS) {
        try {
          // `deadlined` mints the deadline per call, so each endpoint in this
          // loop gets its own full budget — a shared one would let the first
          // slow host starve the fallbacks.
          const res = await fetchFn(`${endpoint}/v1internal:fetchAvailableModels`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              'User-Agent': ANTIGRAVITY_USER_AGENT
            },
            body: '{}',
            ...(context.signal ? { signal: context.signal } : {})
          })
          if (!res.ok) continue
          return parseDiscovery(id, endpoint, await res.json())
        } catch {
          // try next endpoint
        }
      }
      return []
    },
    api: {
      stream: (model, context, options) => streamAntigravity(fetchFn, model, context, options),
      streamSimple: (model, context, options) => streamAntigravity(fetchFn, model, context, options)
    }
  })

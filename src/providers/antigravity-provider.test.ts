// src/providers/antigravity-provider.test.ts

import { describe, expect, it, test } from 'bun:test'
import type {
  Api,
  Context,
  Model,
  OAuthCredential,
  ProviderModelsStore,
  Tool
} from '@earendil-works/pi-ai'

import { PROJECT_HEADER } from '../auth/antigravity-auth'
import {
  antigravityProvider,
  buildEnvelope,
  contextToContents,
  parseCloudCodeChunk,
  parseDiscovery,
  streamAntigravity
} from './antigravity-provider'

// --- parseDiscovery ---

const payload = {
  models: {
    'gemini-3.1-pro': {
      displayName: 'Gemini 3.1 Pro',
      supportsThinking: true,
      supportsImages: true,
      maxTokens: 1048576,
      maxOutputTokens: 65536
    },
    'gemini-2.5-pro': { displayName: 'Denied' },
    secret_internal: { displayName: 'x', isInternal: true },
    'claude-sonnet-4-6': { displayName: 'Claude Sonnet 4.6' }
  }
}

describe('parseDiscovery', () => {
  test('maps, filters denylist and internal, applies defaults', () => {
    const models = parseDiscovery('ag', 'https://daily-cloudcode-pa.googleapis.com', payload)
    const ids = models.map((m) => m.id).sort()
    expect(ids).toEqual(['claude-sonnet-4-6', 'gemini-3.1-pro'])
    const gemini = models.find((m) => m.id === 'gemini-3.1-pro')
    expect(gemini).toMatchObject({
      provider: 'ag',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1048576,
      maxTokens: 65536
    })
    const claude = models.find((m) => m.id === 'claude-sonnet-4-6')
    expect(claude).toMatchObject({ contextWindow: 200000, maxTokens: 64000, input: ['text'] })
  })

  test('returns empty for a payload without models', () => {
    expect(parseDiscovery('ag', 'https://x', {})).toEqual([])
    expect(parseDiscovery('ag', 'https://x', undefined)).toEqual([])
  })
})

// --- discovery fetch (via provider.refreshModels + getModels) ---

const oauthCredential: OAuthCredential = {
  type: 'oauth',
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 3_600_000
}

const stubStore: ProviderModelsStore = {
  read: async () => undefined,
  write: async () => {},
  delete: async () => {}
}

describe('antigravityProvider discovery', () => {
  it('returns no models without an oauth credential', async () => {
    let calls = 0
    const fetchFn = async () => {
      calls++
      return new Response('{}', { status: 200 })
    }
    const provider = antigravityProvider('ag', fetchFn)
    await provider.refreshModels?.({ store: stubStore, allowNetwork: true })
    expect(provider.getModels()).toEqual([])
    expect(calls).toBe(0)
  })

  it('falls back to the second endpoint when the first is non-ok', async () => {
    const discoveryPayload = {
      models: {
        'gemini-3.1-pro': { displayName: 'Gemini 3.1 Pro' },
        'gemini-2.5-pro': { displayName: 'Denied' }
      }
    }
    const seen: string[] = []
    const fetchFn = async (url: string) => {
      seen.push(url)
      return url.includes('sandbox')
        ? new Response(JSON.stringify(discoveryPayload), { status: 200 })
        : new Response('unavailable', { status: 500 })
    }
    const provider = antigravityProvider('ag', fetchFn)
    await provider.refreshModels?.({
      credential: oauthCredential,
      store: stubStore,
      allowNetwork: true
    })

    expect(seen).toHaveLength(2)
    expect(seen[0]).toContain('daily-cloudcode-pa.googleapis.com')
    expect(seen[1]).toContain('sandbox')
    expect(provider.getModels().map((m) => m.id)).toEqual(['gemini-3.1-pro'])
  })

  it('aborts an unresponsive endpoint instead of hanging', async () => {
    const aborted: boolean[] = []
    const fetchFn = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        expect(signal).toBeDefined()
        expect(signal?.aborted).toBe(false)
        signal?.addEventListener('abort', () => {
          aborted.push(true)
          reject(signal.reason)
        })
      })
    const provider = antigravityProvider('ag', fetchFn, 10)
    await provider.refreshModels?.({
      credential: oauthCredential,
      store: stubStore,
      allowNetwork: true
    })

    expect(aborted).toEqual([true, true])
    expect(provider.getModels()).toEqual([])
  })
})

// --- contextToContents (ported wire conversion) ---

describe('contextToContents', () => {
  it('converts a simple user text message', () => {
    const ctx: Context = { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] }
    expect(contextToContents(ctx)).toEqual([{ role: 'user', parts: [{ text: 'Hello' }] }])
  })

  it('converts user message with TextContent array', () => {
    const ctx: Context = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Part 1' },
            { type: 'text', text: 'Part 2' }
          ],
          timestamp: 0
        }
      ]
    }
    expect(contextToContents(ctx)).toEqual([
      { role: 'user', parts: [{ text: 'Part 1' }, { text: 'Part 2' }] }
    ])
  })

  it('converts assistant message with text content', () => {
    const ctx: Context = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Response' }],
          api: '' as never,
          provider: '',
          model: '',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'stop',
          timestamp: 0
        }
      ]
    }
    expect(contextToContents(ctx)).toEqual([{ role: 'model', parts: [{ text: 'Response' }] }])
  })

  it('converts assistant message with thinking and text content', () => {
    const ctx: Context = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me reason about this' },
            { type: 'text', text: 'Response' }
          ],
          api: '' as never,
          provider: '',
          model: '',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'stop',
          timestamp: 0
        }
      ]
    }
    expect(contextToContents(ctx)).toEqual([
      {
        role: 'model',
        parts: [{ text: 'Let me reason about this', thought: true }, { text: 'Response' }]
      }
    ])
  })

  it('converts assistant message with tool call', () => {
    const ctx: Context = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'tc-1', name: 'readFile', arguments: { path: '/tmp/foo' } }
          ],
          api: '' as never,
          provider: '',
          model: '',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          },
          stopReason: 'toolUse',
          timestamp: 0
        }
      ]
    }
    expect(contextToContents(ctx)).toEqual([
      {
        role: 'model',
        parts: [{ functionCall: { name: 'readFile', args: { path: '/tmp/foo' }, id: 'tc-1' } }]
      }
    ])
  })

  it('converts tool result message', () => {
    const ctx: Context = {
      messages: [
        {
          role: 'toolResult',
          toolCallId: 'tc-1',
          toolName: 'readFile',
          content: [{ type: 'text', text: 'file contents here' }],
          isError: false,
          timestamp: 0
        }
      ]
    }
    expect(contextToContents(ctx)).toEqual([
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'readFile', response: { output: 'file contents here' } } }
        ]
      }
    ])
  })
})

// --- buildEnvelope (ported) ---

describe('buildEnvelope', () => {
  const baseParams = {
    projectId: 'proj-123',
    modelId: 'gemini-2.5-pro',
    contents: [{ role: 'user' as const, parts: [{ text: 'Hello' }] }],
    maxOutputTokens: 8192,
    temperature: 0.7
  }

  it('builds correct base structure', () => {
    const envelope = buildEnvelope(baseParams)
    expect(envelope.project).toBe('proj-123')
    expect(envelope.model).toBe('gemini-2.5-pro')
    expect(envelope.requestType).toBe('agent')
    expect(envelope.userAgent).toBe('antigravity')
    expect((envelope.requestId as string).startsWith('agent-')).toBe(true)
  })

  it('omits project when no projectId is supplied', () => {
    const { projectId: _drop, ...rest } = baseParams
    const envelope = buildEnvelope(rest)
    expect('project' in envelope).toBe(false)
  })

  it('includes generationConfig with thinkingConfig', () => {
    const request = buildEnvelope(baseParams).request as Record<string, unknown>
    const genConfig = request.generationConfig as Record<string, unknown>
    expect(genConfig.maxOutputTokens).toBe(8192)
    expect(genConfig.temperature).toBe(0.7)
    expect(genConfig.thinkingConfig).toEqual({ includeThoughts: true })
  })

  it('includes systemInstruction when provided', () => {
    const request = buildEnvelope({ ...baseParams, systemPrompt: 'Be helpful' }).request as Record<
      string,
      unknown
    >
    expect(request.systemInstruction).toEqual({ role: 'user', parts: [{ text: 'Be helpful' }] })
  })

  it('includes tools and toolConfig when tools provided', () => {
    const tools: Tool[] = [
      { name: 'readFile', description: 'Read a file', parameters: { type: 'object' } as never }
    ]
    const request = buildEnvelope({ ...baseParams, tools }).request as Record<string, unknown>
    expect(request.tools).toEqual([
      {
        functionDeclarations: [
          { name: 'readFile', description: 'Read a file', parameters: { type: 'object' } }
        ]
      }
    ])
    expect(request.toolConfig).toEqual({ functionCallingConfig: { mode: 'VALIDATED' } })
  })

  it('omits tools and toolConfig when no tools', () => {
    const request = buildEnvelope(baseParams).request as Record<string, unknown>
    expect(request.tools).toBeUndefined()
    expect(request.toolConfig).toBeUndefined()
  })
})

// --- parseCloudCodeChunk (ported SSE part parsing) ---

describe('parseCloudCodeChunk', () => {
  it('parses text part', () => {
    const chunk = {
      response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello world' }] } }] }
    }
    expect(parseCloudCodeChunk(chunk)).toEqual([{ type: 'text', text: 'Hello world' }])
  })

  it('parses thinking part', () => {
    const chunk = {
      response: {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'Thinking...', thought: true }] } }
        ]
      }
    }
    expect(parseCloudCodeChunk(chunk)).toEqual([{ type: 'thinking', text: 'Thinking...' }])
  })

  it('parses function call part', () => {
    const chunk = {
      response: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'readFile', args: { path: '/tmp' }, id: 'fc-1' } }]
            }
          }
        ]
      }
    }
    expect(parseCloudCodeChunk(chunk)).toEqual([
      { type: 'functionCall', name: 'readFile', args: { path: '/tmp' }, id: 'fc-1' }
    ])
  })

  it('parses multiple parts in one chunk', () => {
    const chunk = {
      response: {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ text: 'Let me check', thought: true }, { text: 'Here is the answer' }]
            }
          }
        ]
      }
    }
    const parts = parseCloudCodeChunk(chunk)
    expect(parts[0]).toEqual({ type: 'thinking', text: 'Let me check' })
    expect(parts[1]).toEqual({ type: 'text', text: 'Here is the answer' })
  })

  it('extracts usage metadata and finish reason', () => {
    const chunk = {
      response: {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }
        ],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 50,
          thoughtsTokenCount: 20,
          cachedContentTokenCount: 10
        }
      }
    }
    expect(parseCloudCodeChunk(chunk)).toEqual([
      { type: 'text', text: 'done' },
      { type: 'finish', reason: 'STOP' },
      {
        type: 'usage',
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 20,
        cachedContentTokenCount: 10
      }
    ])
  })

  it('returns empty array for empty candidates', () => {
    expect(parseCloudCodeChunk({ response: { candidates: [] } })).toEqual([])
  })
})

// --- streamAntigravity projectId threading ---

const streamModel: Model<Api> = {
  id: 'gemini-3.1-pro',
  name: 'Gemini 3.1 Pro',
  api: 'google-antigravity',
  provider: 'ag',
  baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 64000
}

const sseBody =
  'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"hi"}]},"finishReason":"STOP"}]}}\n\n'

describe('streamAntigravity projectId', () => {
  const ctx: Context = { messages: [{ role: 'user', content: 'Hello', timestamp: 0 }] }

  const capture = () => {
    const requests: { url: string; init: RequestInit | undefined }[] = []
    const fetchFn = async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      return new Response(sseBody, { status: 200 })
    }
    return { requests, fetchFn }
  }

  it('puts the pseudo-header projectId into the envelope and strips it upstream', async () => {
    const { requests, fetchFn } = capture()
    const stream = streamAntigravity(fetchFn, streamModel, ctx, {
      apiKey: 'tok',
      headers: { [PROJECT_HEADER]: 'proj-1' }
    })
    const message = await stream.result()

    expect(message.stopReason).toBe('stop')
    expect(requests).toHaveLength(1)
    const first = requests[0]
    if (!first) throw new Error('no request captured')
    const body = JSON.parse(first.init?.body as string) as Record<string, unknown>
    expect(body.project).toBe('proj-1')
    const headers = first.init?.headers as Record<string, string>
    expect(headers[PROJECT_HEADER]).toBeUndefined()
    expect(headers.Authorization).toBe('Bearer tok')
  })

  it('omits project from the envelope without the pseudo-header', async () => {
    const { requests, fetchFn } = capture()
    await streamAntigravity(fetchFn, streamModel, ctx, { apiKey: 'tok' }).result()

    const first = requests[0]
    if (!first) throw new Error('no request captured')
    const body = JSON.parse(first.init?.body as string) as Record<string, unknown>
    expect('project' in body).toBe(false)
  })

  it('errors without an access token', async () => {
    const { fetchFn } = capture()
    const message = await streamAntigravity(fetchFn, streamModel, ctx).result()
    expect(message.stopReason).toBe('error')
    expect(message.errorMessage).toContain('access token')
  })
})

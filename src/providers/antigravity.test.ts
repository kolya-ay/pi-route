// src/providers/antigravity.test.ts

import { describe, expect, it } from 'bun:test'
import type { Context, Tool } from '@mariozechner/pi-ai'

import {
  buildEnvelope,
  contextToContents,
  createAntigravityProvider,
  parseCloudCodeChunk
} from './antigravity'

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

  it('handles mixed conversation', () => {
    const ctx: Context = {
      messages: [
        { role: 'user', content: 'Hello', timestamp: 0 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hi there' }],
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
    const contents = contextToContents(ctx)
    expect(contents).toHaveLength(2)
    expect(contents[0]?.role).toBe('user')
    expect(contents[1]?.role).toBe('model')
  })
})

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
    expect(typeof envelope.requestId).toBe('string')
    expect((envelope.requestId as string).startsWith('agent-')).toBe(true)
  })

  it('includes contents in request', () => {
    const envelope = buildEnvelope(baseParams)
    const request = envelope.request as Record<string, unknown>
    expect(request.contents).toEqual(baseParams.contents)
  })

  it('includes generationConfig with thinkingConfig', () => {
    const envelope = buildEnvelope(baseParams)
    const request = envelope.request as Record<string, unknown>
    const genConfig = request.generationConfig as Record<string, unknown>
    expect(genConfig.maxOutputTokens).toBe(8192)
    expect(genConfig.temperature).toBe(0.7)
    expect(genConfig.thinkingConfig).toEqual({ includeThoughts: true })
  })

  it('includes systemInstruction when provided', () => {
    const envelope = buildEnvelope({ ...baseParams, systemPrompt: 'Be helpful' })
    const request = envelope.request as Record<string, unknown>
    expect(request.systemInstruction).toEqual({ role: 'user', parts: [{ text: 'Be helpful' }] })
  })

  it('omits systemInstruction when not provided', () => {
    const envelope = buildEnvelope(baseParams)
    const request = envelope.request as Record<string, unknown>
    expect(request.systemInstruction).toBeUndefined()
  })

  it('includes tools and toolConfig when tools provided', () => {
    const tools: Tool[] = [
      { name: 'readFile', description: 'Read a file', parameters: { type: 'object' } as never }
    ]
    const envelope = buildEnvelope({ ...baseParams, tools })
    const request = envelope.request as Record<string, unknown>
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
    const envelope = buildEnvelope(baseParams)
    const request = envelope.request as Record<string, unknown>
    expect(request.tools).toBeUndefined()
    expect(request.toolConfig).toBeUndefined()
  })
})

describe('parseCloudCodeChunk', () => {
  it('parses text part', () => {
    const chunk = {
      response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello world' }] } }] }
    }
    const parts = parseCloudCodeChunk(chunk)
    expect(parts).toEqual([{ type: 'text', text: 'Hello world' }])
  })

  it('parses thinking part', () => {
    const chunk = {
      response: {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'Thinking...', thought: true }] } }
        ]
      }
    }
    const parts = parseCloudCodeChunk(chunk)
    expect(parts).toEqual([{ type: 'thinking', text: 'Thinking...' }])
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
    const parts = parseCloudCodeChunk(chunk)
    expect(parts).toEqual([
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
    expect(parts).toHaveLength(2)
    expect(parts[0]).toEqual({ type: 'thinking', text: 'Let me check' })
    expect(parts[1]).toEqual({ type: 'text', text: 'Here is the answer' })
  })

  it('extracts usage metadata', () => {
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
    const parts = parseCloudCodeChunk(chunk)
    expect(parts).toEqual([
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

  it('extracts finish reason', () => {
    const chunk = {
      response: {
        candidates: [
          { content: { role: 'model', parts: [{ text: 'done' }] }, finishReason: 'STOP' }
        ]
      }
    }
    const parts = parseCloudCodeChunk(chunk)
    const textPart = parts.find((p) => p.type === 'text')
    expect(textPart).toBeDefined()
    // finishReason is surfaced separately
    const finishPart = parts.find((p) => p.type === 'finish')
    expect(finishPart).toEqual({ type: 'finish', reason: 'STOP' })
  })

  it('returns empty array for empty candidates', () => {
    const chunk = { response: { candidates: [] } }
    expect(parseCloudCodeChunk(chunk)).toEqual([])
  })
})

describe('createAntigravityProvider', () => {
  it('returns a provider with correct name and type', () => {
    const provider = createAntigravityProvider('ag', 'https://daily-cloudcode-pa.googleapis.com')
    expect(provider.name).toBe('ag')
    expect(provider.type).toBe('antigravity')
  })

  it('throws when account has no resolveKey', async () => {
    const provider = createAntigravityProvider('ag', 'https://daily-cloudcode-pa.googleapis.com')
    const account = { type: 'antigravity-oauth' as const, name: 'test' }
    const request = {
      id: 'req-1',
      format: 'anthropic' as const,
      rawRequest: new Request('http://localhost', {
        method: 'POST',
        body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] })
      }),
      model: 'test',
      stream: false
    }
    await expect(provider.dispatch(request, account)).rejects.toThrow(
      "Account 'test' has no resolveKey"
    )
  })
})

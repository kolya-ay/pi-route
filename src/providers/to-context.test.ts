// src/providers/to-context.test.ts

import { describe, expect, it } from 'bun:test'
import type {
  AssistantMessage,
  TextContent,
  ToolCall,
  ToolResultMessage
} from '@mariozechner/pi-ai'

import { anthropicToContext, openaiToContext, responsesToContext } from './to-context'

describe('anthropicToContext', () => {
  it('converts basic anthropic message to systemPrompt and user message', () => {
    const body = {
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user', content: 'Hello!' }]
    }
    const ctx = anthropicToContext(body)
    expect(ctx.systemPrompt).toBe('You are a helpful assistant.')
    expect(ctx.messages).toHaveLength(1)
    expect(ctx.messages[0]?.role).toBe('user')
    expect(ctx.messages[0]?.content).toBe('Hello!')
    expect(ctx.tools).toBeUndefined()
  })

  it('joins array system prompt blocks with newlines', () => {
    const body = {
      system: [
        { type: 'text', text: 'You are an assistant.' },
        { type: 'text', text: 'Be concise.' }
      ],
      messages: [{ role: 'user', content: 'Hi' }]
    }
    const ctx = anthropicToContext(body)
    expect(ctx.systemPrompt).toBe('You are an assistant.\nBe concise.')
  })

  it('omits systemPrompt when no system provided', () => {
    const body = { messages: [{ role: 'user', content: 'Hello' }] }
    const ctx = anthropicToContext(body)
    expect(ctx.systemPrompt).toBeUndefined()
  })

  it('converts assistant message with text content block', () => {
    const body = {
      messages: [
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: [{ type: 'text', text: 'It is 4.' }] }
      ]
    }
    const ctx = anthropicToContext(body)
    expect(ctx.messages).toHaveLength(2)
    expect(ctx.messages[1]?.role).toBe('assistant')
    const content = ctx.messages[1]?.content as TextContent[]
    expect(content[0]?.text).toBe('It is 4.')
  })

  it('converts tool_use and tool_result round-trip', () => {
    const body = {
      messages: [
        { role: 'user', content: 'What is the weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { location: 'NYC' } }
          ]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Sunny, 72°F' }]
        }
      ]
    }
    const ctx = anthropicToContext(body)
    // user, assistant (toolCall), toolResult
    expect(ctx.messages).toHaveLength(3)

    const assistantMsg = ctx.messages[1]
    expect(assistantMsg?.role).toBe('assistant')
    expect(Array.isArray(assistantMsg?.content)).toBe(true)
    const toolCallBlock = (assistantMsg?.content as ToolCall[])[0]
    expect(toolCallBlock?.type).toBe('toolCall')
    expect(toolCallBlock?.name).toBe('get_weather')
    expect(toolCallBlock?.id).toBe('call_1')

    const toolMsg = ctx.messages[2] as ToolResultMessage
    expect(toolMsg?.role).toBe('toolResult')
    expect((toolMsg.content[0] as TextContent).text).toBe('Sunny, 72°F')
    expect(toolMsg.toolCallId).toBe('call_1')
  })

  it('converts tools array from input_schema', () => {
    const body = {
      messages: [{ role: 'user', content: 'Use the tool' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get current weather',
          input_schema: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location']
          }
        }
      ]
    }
    const ctx = anthropicToContext(body)
    expect(ctx.tools).toHaveLength(1)
    expect(ctx.tools?.[0]?.name).toBe('get_weather')
    expect(ctx.tools?.[0]?.description).toBe('Get current weather')
    expect(ctx.tools?.[0]?.parameters).toMatchObject({
      type: 'object',
      properties: { location: { type: 'string' } }
    })
  })
})

describe('openaiToContext', () => {
  it('converts basic OpenAI message to systemPrompt and user message', () => {
    const body = {
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hello!' }
      ]
    }
    const ctx = openaiToContext(body)
    expect(ctx.systemPrompt).toBe('You are helpful.')
    expect(ctx.messages).toHaveLength(1)
    expect(ctx.messages[0]?.role).toBe('user')
    expect(ctx.messages[0]?.content).toBe('Hello!')
  })

  it('omits systemPrompt when no system message', () => {
    const body = { messages: [{ role: 'user', content: 'Hello' }] }
    const ctx = openaiToContext(body)
    expect(ctx.systemPrompt).toBeUndefined()
  })

  it('converts assistant tool_calls to toolCall blocks', () => {
    const body = {
      messages: [
        { role: 'user', content: 'What is the weather in NYC?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_abc123',
              type: 'function',
              function: { name: 'get_weather', arguments: JSON.stringify({ location: 'NYC' }) }
            }
          ]
        }
      ]
    }
    const ctx = openaiToContext(body)
    expect(ctx.messages).toHaveLength(2)

    const assistantMsg = ctx.messages[1]
    expect(assistantMsg?.role).toBe('assistant')
    expect(Array.isArray(assistantMsg?.content)).toBe(true)
    const block = (assistantMsg?.content as ToolCall[])[0]
    expect(block?.type).toBe('toolCall')
    expect(block?.name).toBe('get_weather')
    expect(block?.id).toBe('call_abc123')
    expect(block?.arguments).toEqual({ location: 'NYC' })
  })

  it('converts tool response messages', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Weather?' },
        { role: 'tool', tool_call_id: 'call_abc123', content: 'Sunny, 72°F' }
      ]
    }
    const ctx = openaiToContext(body)
    expect(ctx.messages).toHaveLength(2)
    const toolMsg = ctx.messages[1] as ToolResultMessage
    expect(toolMsg?.role).toBe('toolResult')
    expect((toolMsg.content[0] as TextContent).text).toBe('Sunny, 72°F')
    expect(toolMsg.toolCallId).toBe('call_abc123')
  })

  it('converts OpenAI tools array', () => {
    const body = {
      messages: [{ role: 'user', content: 'Use the tool' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'search',
            description: 'Search the web',
            parameters: { type: 'object', properties: { query: { type: 'string' } } }
          }
        }
      ]
    }
    const ctx = openaiToContext(body)
    expect(ctx.tools).toHaveLength(1)
    expect(ctx.tools?.[0]?.name).toBe('search')
    expect(ctx.tools?.[0]?.description).toBe('Search the web')
    expect(ctx.tools?.[0]?.parameters).toMatchObject({ type: 'object' })
  })
})

describe('responsesToContext', () => {
  it('parses a simple string input as a user message', () => {
    const ctx = responsesToContext({ model: 'gpt-4', input: 'hello world' })
    expect(ctx.messages).toHaveLength(1)
    expect(ctx.messages[0]).toMatchObject({ role: 'user', content: 'hello world' })
  })

  it('parses instructions as a system prompt', () => {
    const ctx = responsesToContext({
      model: 'gpt-4',
      instructions: 'Be terse.',
      input: 'hi'
    })
    expect(ctx.systemPrompt).toBe('Be terse.')
  })

  it('returns empty messages when input is missing', () => {
    const ctx = responsesToContext({ model: 'gpt-4' })
    expect(ctx.messages).toHaveLength(0)
    expect(ctx.systemPrompt).toBeUndefined()
  })

  it('parses multi-part user input with input_text blocks', () => {
    const ctx = responsesToContext({
      model: 'gpt-4',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'part 1' },
            { type: 'input_text', text: 'part 2' }
          ]
        }
      ]
    })
    expect(ctx.messages[0]?.content).toEqual([
      { type: 'text', text: 'part 1' },
      { type: 'text', text: 'part 2' }
    ])
  })

  it('parses function_call + function_call_output into ToolCall + ToolResult', () => {
    const ctx = responsesToContext({
      model: 'gpt-4',
      input: [
        { type: 'message', role: 'user', content: 'what is the weather?' },
        {
          type: 'function_call',
          call_id: 'call_abc',
          name: 'get_weather',
          arguments: '{"city":"SF"}'
        },
        { type: 'function_call_output', call_id: 'call_abc', output: '72F sunny' }
      ]
    })
    expect(ctx.messages).toHaveLength(3)
    expect(ctx.messages[0]?.role).toBe('user')
    expect(ctx.messages[1]?.role).toBe('assistant')
    expect((ctx.messages[1] as AssistantMessage).content[0]).toMatchObject({
      type: 'toolCall',
      id: 'call_abc',
      name: 'get_weather',
      arguments: { city: 'SF' }
    })
    expect(ctx.messages[2]?.role).toBe('toolResult')
    expect((ctx.messages[2] as ToolResultMessage).toolCallId).toBe('call_abc')
  })

  it('parses tools array', () => {
    const ctx = responsesToContext({
      model: 'gpt-4',
      input: 'hi',
      tools: [
        {
          type: 'function',
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: {} }
        }
      ]
    })
    expect(ctx.tools).toHaveLength(1)
    expect(ctx.tools![0]).toMatchObject({ name: 'get_weather' })
  })

  it('ignores unsupported tool types (web_search, file_search)', () => {
    const ctx = responsesToContext({
      model: 'gpt-4',
      input: 'hi',
      tools: [{ type: 'web_search' }, { type: 'function', name: 'get_weather', parameters: {} }]
    })
    expect(ctx.tools).toHaveLength(1)
    expect(ctx.tools![0]?.name).toBe('get_weather')
  })

  it('flattens array-shaped function_call_output to a string', () => {
    const ctx = responsesToContext({
      model: 'gpt-4',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'fn', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [
            { type: 'output_text', text: 'part a' },
            { type: 'output_text', text: 'part b' }
          ]
        }
      ]
    })
    expect((ctx.messages[1] as ToolResultMessage).content[0]).toMatchObject({
      type: 'text',
      text: 'part apart b'
    })
  })
})

// src/providers/to-context.ts

import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  UserMessage
} from '@mariozechner/pi-ai'

import type { IncomingRequest } from '../types'

const defaultUsage = () => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
})

const makeUserMessage = (content: string | TextContent[]): UserMessage => ({
  role: 'user',
  content,
  timestamp: Date.now()
})

const makeAssistantMessage = (content: Array<TextContent | ToolCall>): AssistantMessage => ({
  role: 'assistant',
  content,
  api: '' as Api,
  provider: '',
  model: '',
  usage: defaultUsage(),
  stopReason: 'stop',
  timestamp: Date.now()
})

const makeToolResult = (toolCallId: string, text: string): ToolResultMessage => ({
  role: 'toolResult',
  toolCallId,
  toolName: '',
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: Date.now()
})

// --- Anthropic → Context ---

const extractAnthropicSystem = (system: unknown): string | undefined => {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
      .filter((b) => b.type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('\n')
  }
  return undefined
}

const extractAnthropicMessageContent = (
  content: unknown,
  role: 'user' | 'assistant'
): Message[] => {
  if (typeof content === 'string') {
    return role === 'user'
      ? [makeUserMessage(content)]
      : [makeAssistantMessage([{ type: 'text', text: content }])]
  }

  if (!Array.isArray(content)) return []

  const blocks = content.filter(
    (b): b is Record<string, unknown> => typeof b === 'object' && b !== null
  )

  // Check for tool_result blocks — these become separate toolResult messages
  const toolResults = blocks.filter((b) => b.type === 'tool_result')
  const otherBlocks = blocks.filter((b) => b.type !== 'tool_result')

  const messages: Message[] = []

  if (otherBlocks.length > 0) {
    if (role === 'user') {
      const parts: TextContent[] = otherBlocks.map((b) => ({
        type: 'text',
        text: String(b.text ?? '')
      }))
      // If single text block, simplify to string
      if (parts.length === 1) {
        // biome-ignore lint/style/noNonNullAssertion: length checked above
        messages.push(makeUserMessage(parts[0]!.text))
      } else {
        messages.push(makeUserMessage(parts))
      }
    } else {
      const parts: Array<TextContent | ToolCall> = otherBlocks.map((b) => {
        if (b.type === 'tool_use') {
          return {
            type: 'toolCall' as const,
            id: typeof b.id === 'string' ? b.id : '',
            name: typeof b.name === 'string' ? b.name : '',
            arguments:
              typeof b.input === 'object' && b.input !== null
                ? (b.input as Record<string, unknown>)
                : {}
          }
        }
        return { type: 'text' as const, text: String(b.text ?? '') }
      })

      // If single text block, simplify to string content in assistant message
      if (parts.length === 1 && parts[0]?.type === 'text') {
        messages.push(makeAssistantMessage([{ type: 'text', text: parts[0].text }]))
      } else {
        messages.push(makeAssistantMessage(parts))
      }
    }
  }

  toolResults.forEach((tr) => {
    const toolUseId = typeof tr.tool_use_id === 'string' ? tr.tool_use_id : ''
    const resultContent =
      typeof tr.content === 'string'
        ? tr.content
        : Array.isArray(tr.content)
          ? (tr.content as Record<string, unknown>[])
              .filter((b) => b.type === 'text')
              .map((b) => String(b.text ?? ''))
              .join('\n')
          : ''
    messages.push(makeToolResult(toolUseId, resultContent))
  })

  return messages
}

const convertAnthropicTools = (tools: unknown): Tool[] | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map((t) => ({
      name: String(t.name ?? ''),
      description: typeof t.description === 'string' ? t.description : '',
      parameters:
        typeof t.input_schema === 'object' && t.input_schema !== null
          ? (t.input_schema as Record<string, unknown>)
          : {}
    }))
}

export const anthropicToContext = (body: Record<string, unknown>): Context => {
  const systemPrompt = extractAnthropicSystem(body.system)
  const tools = convertAnthropicTools(body.tools)

  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  const messages: Message[] = rawMessages
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .flatMap((m) => {
      const role = m.role === 'assistant' ? 'assistant' : 'user'
      return extractAnthropicMessageContent(m.content, role)
    })

  return {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    messages,
    ...(tools !== undefined ? { tools } : {})
  }
}

// --- OpenAI → Context ---

const convertOpenAiTools = (tools: unknown): Tool[] | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .filter((t) => t.type === 'function')
    .map((t) => {
      const fn =
        typeof t.function === 'object' && t.function !== null
          ? (t.function as Record<string, unknown>)
          : {}
      return {
        name: String(fn.name ?? ''),
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters:
          typeof fn.parameters === 'object' && fn.parameters !== null
            ? (fn.parameters as Record<string, unknown>)
            : {}
      }
    })
}

const convertOpenAiMessage = (m: Record<string, unknown>): Message | null => {
  const role = m.role

  if (role === 'system') return null

  if (role === 'tool') {
    const toolCallId = typeof m.tool_call_id === 'string' ? m.tool_call_id : ''
    const text = typeof m.content === 'string' ? m.content : ''
    return makeToolResult(toolCallId, text)
  }

  if (role === 'assistant') {
    const toolCalls = m.tool_calls
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const parts: ToolCall[] = toolCalls
        .filter((tc): tc is Record<string, unknown> => typeof tc === 'object' && tc !== null)
        .map((tc) => {
          const fn =
            typeof tc.function === 'object' && tc.function !== null
              ? (tc.function as Record<string, unknown>)
              : {}
          const args = ((): Record<string, unknown> => {
            try {
              const raw = fn.arguments
              return typeof raw === 'string' ? (JSON.parse(raw) as Record<string, unknown>) : {}
            } catch {
              return {}
            }
          })()
          return {
            type: 'toolCall' as const,
            id: typeof tc.id === 'string' ? tc.id : '',
            name: typeof fn.name === 'string' ? fn.name : '',
            arguments: args
          }
        })
      return makeAssistantMessage(parts)
    }

    const content = m.content
    return makeAssistantMessage([
      { type: 'text', text: typeof content === 'string' ? content : '' }
    ])
  }

  // user message
  const content = m.content
  if (typeof content === 'string') {
    return makeUserMessage(content)
  }
  if (Array.isArray(content)) {
    const parts: TextContent[] = (content as Record<string, unknown>[])
      .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
      .map((b) => ({ type: 'text' as const, text: String(b.text ?? '') }))
    return makeUserMessage(parts)
  }
  return makeUserMessage('')
}

// --- Responses → Context ---
// Full implementation in Task 3. Stubbed here so plumbing in Task 2 type-checks.
export const responsesToContext = (_body: Record<string, unknown>): Context => {
  throw new Error('responsesToContext: not implemented')
}

export const openaiToContext = (body: Record<string, unknown>): Context => {
  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  const typedMessages = rawMessages.filter(
    (m): m is Record<string, unknown> => typeof m === 'object' && m !== null
  )

  const systemMsg = typedMessages.find((m) => m.role === 'system')
  const systemPrompt =
    systemMsg !== undefined && typeof systemMsg.content === 'string' ? systemMsg.content : undefined

  const messages: Message[] = typedMessages
    .map(convertOpenAiMessage)
    .filter((m): m is Message => m !== null)

  const tools = convertOpenAiTools(body.tools)

  return {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    messages,
    ...(tools !== undefined ? { tools } : {})
  }
}

export const toContext = (
  format: IncomingRequest['format'],
  body: Record<string, unknown>
): Context =>
  format === 'anthropic'
    ? anthropicToContext(body)
    : format === 'responses'
      ? responsesToContext(body)
      : openaiToContext(body)

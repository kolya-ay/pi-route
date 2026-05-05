// src/backends/pi-ai/to-context.ts

export type PiAiMessage = {
  role: 'user' | 'assistant' | 'tool'
  content: string | PiAiContentBlock[]
  toolCallId?: string | undefined
}

export type PiAiContentBlock = {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string | undefined
  id?: string | undefined
  name?: string | undefined
  input?: Record<string, unknown> | undefined
  toolUseId?: string | undefined
  content?: string | undefined
}

export type PiAiTool = {
  name: string
  description?: string | undefined
  parameters: Record<string, unknown>
}

export type PiAiContext = {
  systemPrompt?: string | undefined
  messages: PiAiMessage[]
  tools?: PiAiTool[] | undefined
}

// --- Anthropic → PiAiContext ---

const extractAnthropicSystem = (system: unknown): string | undefined => {
  if (typeof system === 'string') return system
  if (Array.isArray(system)) {
    return system
      .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
      .filter((b) => b['type'] === 'text')
      .map((b) => String(b['text'] ?? ''))
      .join('\n')
  }
  return undefined
}

const extractAnthropicMessageContent = (
  content: unknown,
  role: 'user' | 'assistant'
): PiAiMessage[] => {
  if (typeof content === 'string') {
    return [{ role, content }]
  }

  if (!Array.isArray(content)) return []

  const blocks = content.filter(
    (b): b is Record<string, unknown> => typeof b === 'object' && b !== null
  )

  // Check for tool_result blocks — these become separate tool messages
  const toolResults = blocks.filter((b) => b['type'] === 'tool_result')
  const otherBlocks = blocks.filter((b) => b['type'] !== 'tool_result')

  const messages: PiAiMessage[] = []

  if (otherBlocks.length > 0) {
    const parts: PiAiContentBlock[] = otherBlocks.map((b) => {
      if (b['type'] === 'text') {
        return { type: 'text', text: String(b['text'] ?? '') }
      }
      if (b['type'] === 'tool_use') {
        return {
          type: 'tool_use',
          id: typeof b['id'] === 'string' ? b['id'] : undefined,
          name: typeof b['name'] === 'string' ? b['name'] : undefined,
          input:
            typeof b['input'] === 'object' && b['input'] !== null
              ? (b['input'] as Record<string, unknown>)
              : {}
        }
      }
      return { type: 'text', text: String(b['text'] ?? '') }
    })

    // If single text block, simplify to string
    if (parts.length === 1 && parts[0]?.type === 'text') {
      messages.push({ role, content: parts[0].text ?? '' })
    } else {
      messages.push({ role, content: parts })
    }
  }

  for (const tr of toolResults) {
    const toolUseId = typeof tr['tool_use_id'] === 'string' ? tr['tool_use_id'] : undefined
    const resultContent =
      typeof tr['content'] === 'string'
        ? tr['content']
        : Array.isArray(tr['content'])
          ? (tr['content'] as Array<Record<string, unknown>>)
              .filter((b) => b['type'] === 'text')
              .map((b) => String(b['text'] ?? ''))
              .join('\n')
          : ''
    messages.push({ role: 'tool', content: resultContent, toolCallId: toolUseId })
  }

  return messages
}

const convertAnthropicTools = (tools: unknown): PiAiTool[] | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map((t) => ({
      name: String(t['name'] ?? ''),
      description: typeof t['description'] === 'string' ? t['description'] : undefined,
      parameters:
        typeof t['input_schema'] === 'object' && t['input_schema'] !== null
          ? (t['input_schema'] as Record<string, unknown>)
          : {}
    }))
}

export const anthropicToContext = (body: Record<string, unknown>): PiAiContext => {
  const systemPrompt = extractAnthropicSystem(body['system'])
  const tools = convertAnthropicTools(body['tools'])

  const rawMessages = Array.isArray(body['messages']) ? body['messages'] : []
  const messages: PiAiMessage[] = rawMessages
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .flatMap((m) => {
      const role = m['role'] === 'assistant' ? 'assistant' : 'user'
      return extractAnthropicMessageContent(m['content'], role)
    })

  return {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    messages,
    ...(tools !== undefined ? { tools } : {})
  }
}

// --- OpenAI → PiAiContext ---

const convertOpenAiTools = (tools: unknown): PiAiTool[] | undefined => {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .filter((t) => t['type'] === 'function')
    .map((t) => {
      const fn =
        typeof t['function'] === 'object' && t['function'] !== null
          ? (t['function'] as Record<string, unknown>)
          : {}
      return {
        name: String(fn['name'] ?? ''),
        description: typeof fn['description'] === 'string' ? fn['description'] : undefined,
        parameters:
          typeof fn['parameters'] === 'object' && fn['parameters'] !== null
            ? (fn['parameters'] as Record<string, unknown>)
            : {}
      }
    })
}

const convertOpenAiMessage = (m: Record<string, unknown>): PiAiMessage | null => {
  const role = m['role']

  if (role === 'system') return null

  if (role === 'tool') {
    return {
      role: 'tool',
      content: typeof m['content'] === 'string' ? m['content'] : '',
      toolCallId: typeof m['tool_call_id'] === 'string' ? m['tool_call_id'] : undefined
    }
  }

  if (role === 'assistant') {
    const toolCalls = m['tool_calls']
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      const parts: PiAiContentBlock[] = toolCalls
        .filter((tc): tc is Record<string, unknown> => typeof tc === 'object' && tc !== null)
        .map((tc) => {
          const fn =
            typeof tc['function'] === 'object' && tc['function'] !== null
              ? (tc['function'] as Record<string, unknown>)
              : {}
          const input = ((): Record<string, unknown> => {
            try {
              const args = fn['arguments']
              return typeof args === 'string' ? (JSON.parse(args) as Record<string, unknown>) : {}
            } catch {
              return {}
            }
          })()
          return {
            type: 'tool_use' as const,
            id: typeof tc['id'] === 'string' ? tc['id'] : undefined,
            name: typeof fn['name'] === 'string' ? fn['name'] : undefined,
            input
          }
        })
      return { role: 'assistant', content: parts }
    }

    const content = m['content']
    return { role: 'assistant', content: typeof content === 'string' ? content : '' }
  }

  // user message
  const content = m['content']
  if (typeof content === 'string') {
    return { role: 'user', content }
  }
  if (Array.isArray(content)) {
    const parts: PiAiContentBlock[] = (content as Array<Record<string, unknown>>)
      .filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null)
      .map((b) => ({ type: 'text' as const, text: String(b['text'] ?? '') }))
    return { role: 'user', content: parts }
  }
  return { role: 'user', content: '' }
}

export const openaiToContext = (body: Record<string, unknown>): PiAiContext => {
  const rawMessages = Array.isArray(body['messages']) ? body['messages'] : []
  const typedMessages = rawMessages.filter(
    (m): m is Record<string, unknown> => typeof m === 'object' && m !== null
  )

  const systemMsg = typedMessages.find((m) => m['role'] === 'system')
  const systemPrompt =
    systemMsg !== undefined && typeof systemMsg['content'] === 'string'
      ? systemMsg['content']
      : undefined

  const messages: PiAiMessage[] = typedMessages
    .map(convertOpenAiMessage)
    .filter((m): m is PiAiMessage => m !== null)

  const tools = convertOpenAiTools(body['tools'])

  return {
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
    messages,
    ...(tools !== undefined ? { tools } : {})
  }
}

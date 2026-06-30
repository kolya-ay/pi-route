import { createHash } from 'node:crypto'

type BodyShape = {
  metadata?: { user_id?: unknown } | undefined
  conversation_id?: unknown
  messages?: Array<{ role?: unknown; content?: unknown }> | undefined
}

const firstUserMessageText = (body: BodyShape): string | undefined => {
  const msgs = body.messages
  if (!Array.isArray(msgs)) return undefined
  const first = msgs.find((m) => m.role === 'user')
  if (!first) return undefined
  const c = first.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    const part = c.find((p) => typeof p === 'object' && p !== null && 'text' in p) as
      | { text?: unknown }
      | undefined
    return typeof part?.text === 'string' ? part.text : undefined
  }
  return undefined
}

export const extractSessionId = (headers: Headers, body: unknown): string => {
  const header = headers.get('x-session-id') || headers.get('x-client-request-id')
  if (header) return header

  const b = (body ?? {}) as BodyShape
  const userId = b.metadata?.user_id
  if (typeof userId === 'string' && userId) return userId

  const conv = b.conversation_id
  if (typeof conv === 'string' && conv) return conv

  const text = firstUserMessageText(b)
  if (text) return `sha1:${createHash('sha1').update(text).digest('hex')}`

  return 'anon'
}

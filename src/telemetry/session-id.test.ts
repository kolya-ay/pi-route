import { describe, expect, it } from 'bun:test'

import { extractSessionId } from './session-id'

describe('extractSessionId', () => {
  it('reads X-Session-Id header (case-insensitive)', () => {
    const h = new Headers({ 'x-session-id': 'sess-abc' })
    expect(extractSessionId(h, {})).toBe('sess-abc')
  })

  it('reads X-Client-Request-Id header when X-Session-Id is absent', () => {
    const h = new Headers({ 'x-client-request-id': 'crid-1' })
    expect(extractSessionId(h, {})).toBe('crid-1')
  })

  it('reads body.metadata.user_id (Anthropic convention)', () => {
    expect(extractSessionId(new Headers(), { metadata: { user_id: 'u-7' } })).toBe('u-7')
  })

  it('reads body.conversation_id when nothing else hits', () => {
    expect(extractSessionId(new Headers(), { conversation_id: 'conv-9' })).toBe('conv-9')
  })

  it('falls back to SHA1 of first user message text', () => {
    const id = extractSessionId(new Headers(), {
      messages: [{ role: 'user', content: 'hello world' }]
    })
    expect(id).toMatch(/^sha1:[0-9a-f]{40}$/)
  })

  it('returns "anon" when no session source is present', () => {
    expect(extractSessionId(new Headers(), {})).toBe('anon')
  })

  it('header takes priority over body when both present', () => {
    const h = new Headers({ 'x-session-id': 'header-wins' })
    expect(extractSessionId(h, { metadata: { user_id: 'body-loses' } })).toBe('header-wins')
  })

  it('falls back to SHA1 of first text part when user message content is an array', () => {
    const id = extractSessionId(new Headers(), {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: {} },
            { type: 'text', text: 'hello' }
          ]
        }
      ]
    })
    expect(id).toMatch(/^sha1:[0-9a-f]{40}$/)
  })

  it('skips body.metadata.user_id when it is an empty string', () => {
    expect(extractSessionId(new Headers(), { metadata: { user_id: '' } })).toBe('anon')
  })
})

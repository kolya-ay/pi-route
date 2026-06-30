import { describe, expect, it } from 'bun:test'

import { buildRequestCaptureAttrs, buildResponseCaptureAttr } from './capture'

describe('buildRequestCaptureAttrs', () => {
  it('returns empty when capture disabled', () => {
    expect(
      buildRequestCaptureAttrs({ capturePrompts: false, maxBytes: 1000 }, { messages: [] })
    ).toEqual({})
  })

  it('serializes messages and system', () => {
    const attrs = buildRequestCaptureAttrs(
      { capturePrompts: true, maxBytes: 65536 },
      { messages: [{ role: 'user', content: 'hi' }], system: 'be brief' }
    )
    expect(attrs['gen_ai.input.messages']).toBe(JSON.stringify([{ role: 'user', content: 'hi' }]))
    expect(attrs['gen_ai.system_instructions']).toBe('be brief')
  })

  it('serializes tools when present', () => {
    const tools = [{ name: 'get_weather', input_schema: { type: 'object' } }]
    const attrs = buildRequestCaptureAttrs(
      { capturePrompts: true, maxBytes: 65536 },
      { messages: [], tools }
    )
    expect(attrs['gen_ai.tool.definitions']).toBe(JSON.stringify(tools))
  })

  it('replaces oversized attribute with <truncated:N> and emits truncated flag', () => {
    const big = 'x'.repeat(5000)
    const attrs = buildRequestCaptureAttrs(
      { capturePrompts: true, maxBytes: 1024 },
      { messages: [{ role: 'user', content: big }] }
    )
    expect(attrs['gen_ai.input.messages']).toMatch(/^<truncated:\d+>$/)
    expect(attrs['pi.captured_fields_truncated']).toContain('gen_ai.input.messages')
  })

  it('records pi.captured_fields_truncated as a string array', () => {
    const big = 'x'.repeat(5000)
    const attrs = buildRequestCaptureAttrs(
      { capturePrompts: true, maxBytes: 1024 },
      { messages: [{ role: 'user', content: big }], tools: [{ name: 't' }] }
    )
    expect(Array.isArray(attrs['pi.captured_fields_truncated'])).toBe(true)
    // tools fits, only messages truncates
    expect(attrs['pi.captured_fields_truncated']).toEqual(['gen_ai.input.messages'])
  })

  it('skips body fields that are null', () => {
    const attrs = buildRequestCaptureAttrs({ capturePrompts: true, maxBytes: 65536 }, {
      messages: null,
      system: null,
      tools: null
    } as unknown as { messages?: unknown; system?: unknown; tools?: unknown })
    expect(attrs).toEqual({})
  })

  it('skips body.system when empty string', () => {
    const attrs = buildRequestCaptureAttrs(
      { capturePrompts: true, maxBytes: 65536 },
      { messages: [], system: '' }
    )
    expect(attrs['gen_ai.system_instructions']).toBeUndefined()
  })

  it('does not throw on circular body shapes', () => {
    const circular: { messages: unknown[]; self?: unknown } = {
      messages: [{ role: 'user', content: 'hi' }]
    }
    circular.self = circular
    const attrs = buildRequestCaptureAttrs(
      { capturePrompts: true, maxBytes: 65536 },
      circular as { messages?: unknown }
    )
    // messages itself doesn't contain the circular ref, so it should serialize cleanly
    expect(attrs['gen_ai.input.messages']).toBe(JSON.stringify(circular.messages))
  })

  it('measures bytes not chars (multibyte UTF-8)', () => {
    // Single Japanese char "猫" is 3 bytes in UTF-8 but 1 in .length
    const cjk = '猫'.repeat(400) // ~1200 UTF-8 bytes
    const attrs = buildRequestCaptureAttrs(
      { capturePrompts: true, maxBytes: 1024 },
      { messages: [{ role: 'user', content: cjk }] }
    )
    // serialized JSON of [{role:'user', content:'猫猫...'}] is ~1228 bytes — over cap
    expect(attrs['gen_ai.input.messages']).toMatch(/^<truncated:\d+>$/)
  })
})

describe('buildResponseCaptureAttr', () => {
  it('returns empty when capture disabled', () => {
    expect(
      buildResponseCaptureAttr({ capturePrompts: false, maxBytes: 1000 }, { content: [] })
    ).toEqual({})
  })

  it('serializes assistant message content', () => {
    const msg = { content: [{ type: 'text', text: 'hello' }] }
    const attrs = buildResponseCaptureAttr({ capturePrompts: true, maxBytes: 65536 }, msg)
    expect(attrs['gen_ai.output.messages']).toBe(JSON.stringify(msg.content))
  })

  it('truncates oversized response content', () => {
    const huge = { content: [{ type: 'text', text: 'x'.repeat(5000) }] }
    const attrs = buildResponseCaptureAttr({ capturePrompts: true, maxBytes: 1024 }, huge)
    expect(attrs['gen_ai.output.messages']).toMatch(/^<truncated:\d+>$/)
    expect(attrs['pi.captured_fields_truncated']).toContain('gen_ai.output.messages')
  })
})

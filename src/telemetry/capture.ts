import type { Attributes } from '@opentelemetry/api'

export type CaptureOpts = { capturePrompts: boolean; maxBytes: number }

const safeStringify = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

const cap = (
  attrs: Attributes,
  key: string,
  value: string,
  maxBytes: number,
  truncated: string[]
): void => {
  const bytes = Buffer.byteLength(value, 'utf-8')
  // Strict > keeps values that exactly hit the cap.
  if (bytes > maxBytes) {
    attrs[key] = `<truncated:${bytes}>`
    truncated.push(key)
  } else {
    attrs[key] = value
  }
}

export const buildRequestCaptureAttrs = (
  opts: CaptureOpts,
  body: { messages?: unknown; system?: unknown; tools?: unknown }
): Attributes => {
  if (!opts.capturePrompts) return {}
  const attrs: Attributes = {}
  const truncated: string[] = []
  if (body.messages != null) {
    const v = safeStringify(body.messages)
    if (v !== undefined) cap(attrs, 'gen_ai.input.messages', v, opts.maxBytes, truncated)
  }
  if (typeof body.system === 'string' && body.system) {
    cap(attrs, 'gen_ai.system_instructions', body.system, opts.maxBytes, truncated)
  }
  if (body.tools != null) {
    const v = safeStringify(body.tools)
    if (v !== undefined) cap(attrs, 'gen_ai.tool.definitions', v, opts.maxBytes, truncated)
  }
  if (truncated.length > 0) attrs['pi.captured_fields_truncated'] = truncated
  return attrs
}

export const buildResponseCaptureAttr = (
  opts: CaptureOpts,
  message: { content?: unknown }
): Attributes => {
  if (!opts.capturePrompts) return {}
  if (message.content == null) return {}
  const v = safeStringify(message.content)
  if (v === undefined) return {}
  const attrs: Attributes = {}
  const truncated: string[] = []
  cap(attrs, 'gen_ai.output.messages', v, opts.maxBytes, truncated)
  if (truncated.length > 0) attrs['pi.captured_fields_truncated'] = truncated
  return attrs
}

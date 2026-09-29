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
  body: {
    messages?: unknown
    system?: unknown
    tools?: unknown
    response_format?: unknown
    text?: unknown
  }
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
  // The requested schema is neither a message nor a tool on the way in — Chat carries
  // it on `response_format`, Responses inline on `text.format` — so without this the
  // one field a schema bug lives in is the one field never recorded.
  const requestedFormat =
    body.response_format ??
    (typeof body.text === 'object' && body.text !== null
      ? (body.text as { format?: unknown }).format
      : undefined)
  if (requestedFormat != null) {
    const v = safeStringify(requestedFormat)
    if (v !== undefined) {
      cap(attrs, 'gen_ai.request.response_format', v, opts.maxBytes, truncated)
    }
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

// Compression policy for pi-route.
//
// Request bodies: accepts zstd/gzip/deflate. Historical driver — codex-acp
// 0.15 sent zstd (0.16 stopped, but generic OpenAI clients may still gzip).
//
// Response bodies: NOT compressed. The hot path is SSE streams from
// upstream providers; hono/compress buffers and would break per-token
// latency. Non-streaming responses (/v1/models, /health) are tiny —
// gzip overhead beats wire savings on localhost.
//
// Body size: capped uniformly by PI_ROUTE_MAX_BODY_BYTES. Compressed
// input rejected pre-decompress via content-length check; decompressed
// input then guarded by hono/body-limit.

import type { MiddlewareHandler } from 'hono'

const SUPPORTED = ['zstd', 'gzip', 'deflate']

export const decompressRequest =
  (opts: { maxBodyBytes: number }): MiddlewareHandler =>
  async (c, next) => {
    const encoding = c.req.header('content-encoding')?.toLowerCase()
    if (!encoding || !SUPPORTED.includes(encoding)) return next()

    const contentLength = c.req.header('content-length')
    if (contentLength && Number(contentLength) > opts.maxBodyBytes) {
      return c.text('Payload too large', 413)
    }

    const body = c.req.raw.body
    if (!body) return next()

    const decompressed = await new Response(
      body.pipeThrough(new DecompressionStream(encoding as CompressionFormat))
    ).bytes()

    const newHeaders = new Headers(c.req.raw.headers)
    newHeaders.delete('content-encoding')
    newHeaders.delete('content-length')
    c.req.raw = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers: newHeaders,
      body: decompressed,
      duplex: 'half'
    } as RequestInit)
    return next()
  }

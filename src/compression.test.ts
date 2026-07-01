// src/compression.test.ts
import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { decompressRequest } from './compression'

const compress = async (text: string, encoding: string): Promise<ArrayBuffer> =>
  new Response(
    new Blob([text]).stream().pipeThrough(new CompressionStream(encoding as CompressionFormat))
  ).arrayBuffer()

const makeEchoApp = (maxBodyBytes = 10 * 1024 * 1024): Hono => {
  const app = new Hono()
  app.use('*', decompressRequest({ maxBodyBytes }))
  app.use('*', bodyLimit({ maxSize: maxBodyBytes }))
  app.post('/echo', async (c) => {
    const text = await c.req.raw.text()
    const ce = c.req.header('content-encoding') ?? ''
    return c.json({ body: text, contentEncoding: ce })
  })
  return app
}

describe('decompressRequest', () => {
  test('plaintext POST passes through unchanged', async () => {
    const app = makeEchoApp()
    const payload = JSON.stringify({ model: 'test', messages: [] })
    const r = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload
    })
    expect(r.status).toBe(200)
    const json = (await r.json()) as { body: string; contentEncoding: string }
    expect(json.body).toBe(payload)
    expect(json.contentEncoding).toBe('')
  })

  for (const encoding of ['zstd', 'gzip', 'deflate'] as const) {
    test(`${encoding}-compressed POST is decompressed and content-encoding removed`, async () => {
      const app = makeEchoApp()
      const payload = JSON.stringify({
        model: `${encoding}-model`,
        messages: [{ role: 'user', content: 'hi' }]
      })
      const compressed = await compress(payload, encoding)
      const r = await app.request('/echo', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': encoding },
        body: compressed
      })
      expect(r.status).toBe(200)
      const json = (await r.json()) as { body: string; contentEncoding: string }
      expect(json.body).toBe(payload)
      expect(json.contentEncoding).toBe('')
    })
  }

  test('unsupported content-encoding (br) passes through unchanged', async () => {
    const app = makeEchoApp()
    const raw = new TextEncoder().encode('not-real-brotli')
    const r = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'br' },
      body: raw
    })
    expect(r.status).toBe(200)
    const json = (await r.json()) as { body: string; contentEncoding: string }
    expect(json.contentEncoding).toBe('br')
  })

  test('oversize compressed input (content-length > cap) returns 413 before decompression', async () => {
    const app = makeEchoApp(1024) // 1 KB cap
    const r = await app.request('/echo', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(2048) // claim 2 KB > 1 KB cap
      },
      body: new Uint8Array(2048)
    })
    expect(r.status).toBe(413)
  })

  test('oversize decompressed input is caught by body-limit', async () => {
    const app = makeEchoApp(1024) // 1 KB cap
    const bigPayload = 'x'.repeat(5000) // 5 KB uncompressed; compresses tiny
    const compressed = await compress(bigPayload, 'gzip')
    const r = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
      body: compressed
    })
    expect(r.status).toBe(413)
  })

  test('compressed body with no content-length header is still decompressed', async () => {
    const app = makeEchoApp()
    const payload = JSON.stringify({ model: 'stream-test' })
    const compressed = await compress(payload, 'gzip')
    // A ReadableStream body has no known length, so fetch/Hono omit
    // content-length. This exercises the "if (contentLength && …)" branch
    // where the pre-decompress size check is skipped.
    const stream = new Blob([compressed]).stream()
    const r = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: stream,
      duplex: 'half'
    } as RequestInit)
    expect(r.status).toBe(200)
    const json = (await r.json()) as { body: string; contentEncoding: string }
    expect(json.body).toBe(payload)
    expect(json.contentEncoding).toBe('')
  })
})

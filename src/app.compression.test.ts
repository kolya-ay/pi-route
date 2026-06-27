// src/app.compression.test.ts

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createApp } from './app'

const compress = async (text: string, encoding: string): Promise<ArrayBuffer> =>
  new Response(
    new Blob([text]).stream().pipeThrough(new CompressionStream(encoding as CompressionFormat))
  ).arrayBuffer()

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-route-compression-'))
  process.env.PI_ROUTE_CONFIG = join(dir, 'router.yaml')
  process.env.PI_ROUTE_AUTH = dir
  await writeFile(
    process.env.PI_ROUTE_CONFIG,
    `providers:\n  cerebras:\n    type: cerebras\n    account:\n      credential: key\n      key: sk-test\n`
  )
})

afterEach(async () => {
  delete process.env.PI_ROUTE_CONFIG
  delete process.env.PI_ROUTE_AUTH
  await rm(dir, { recursive: true, force: true })
})

// Mount a test echo handler on a plain Hono app with the same decompression
// middleware extracted from createApp, so we can inspect what the downstream
// handler sees without needing real providers.
const makeEchoApp = (): Hono => {
  const app = new Hono()
  app.use('*', async (c, next) => {
    const encoding = c.req.header('content-encoding')?.toLowerCase()
    if (!encoding || (encoding !== 'zstd' && encoding !== 'gzip' && encoding !== 'deflate'))
      return next()
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
  })
  app.post('/echo', async (c) => {
    const text = await c.req.raw.text()
    const ce = c.req.header('content-encoding') ?? ''
    return c.json({ body: text, contentEncoding: ce })
  })
  return app
}

describe('request body decompression middleware', () => {
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

  test('zstd-compressed POST is decompressed and content-encoding removed', async () => {
    const app = makeEchoApp()
    const payload = JSON.stringify({
      model: 'zstd-model',
      messages: [{ role: 'user', content: 'hi' }]
    })
    const compressed = await compress(payload, 'zstd')
    const r = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'zstd' },
      body: compressed
    })
    expect(r.status).toBe(200)
    const json = (await r.json()) as { body: string; contentEncoding: string }
    expect(json.body).toBe(payload)
    expect(json.contentEncoding).toBe('')
  })

  test('gzip-compressed POST is decompressed and content-encoding removed', async () => {
    const app = makeEchoApp()
    const payload = JSON.stringify({ model: 'gzip-model', stream: false })
    const compressed = await compress(payload, 'gzip')
    const r = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
      body: compressed
    })
    expect(r.status).toBe(200)
    const json = (await r.json()) as { body: string; contentEncoding: string }
    expect(json.body).toBe(payload)
    expect(json.contentEncoding).toBe('')
  })

  test('deflate-compressed POST is decompressed and content-encoding removed', async () => {
    const app = makeEchoApp()
    const payload = JSON.stringify({ model: 'deflate-model', prompt: 'hello' })
    const compressed = await compress(payload, 'deflate')
    const r = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'deflate' },
      body: compressed
    })
    expect(r.status).toBe(200)
    const json = (await r.json()) as { body: string; contentEncoding: string }
    expect(json.body).toBe(payload)
    expect(json.contentEncoding).toBe('')
  })

  test('unsupported content-encoding (br/brotli) passes through unchanged', async () => {
    const app = makeEchoApp()
    // We pass raw bytes as if brotli; the middleware should not touch them
    const raw = new TextEncoder().encode('not-real-brotli')
    const r = await app.request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-encoding': 'br' },
      body: raw
    })
    expect(r.status).toBe(200)
    const json = (await r.json()) as { body: string; contentEncoding: string }
    // Body comes through as-is (may be garbled bytes decoded as UTF-8 — that's fine for this test)
    expect(json.contentEncoding).toBe('br')
  })

  test('createApp /v1/models still works after adding middleware (regression)', async () => {
    const router = await createApp()
    const r = await router.app.request('/v1/models')
    expect(r.status).toBe(200)
    const body = (await r.json()) as { object: string }
    expect(body.object).toBe('list')
  })
})

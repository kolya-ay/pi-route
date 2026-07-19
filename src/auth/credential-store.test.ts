// src/auth/credential-store.test.ts

import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouterOptions } from '../types'
import { fileCredentialStore } from './credential-store'

const options = {
  providers: {
    cc: { type: 'anthropic', account: { credential: 'oauth', name: 'cc' } },
    chutes: {
      type: 'openai-compatible',
      baseUrl: 'https://x',
      account: { credential: 'key', key: 'sk-123' }
    }
  },
  pipeline: [],
  expose: []
} as unknown as RouterOptions

describe('fileCredentialStore', () => {
  test('key accounts resolve from config, no file involved', async () => {
    const store = fileCredentialStore(mkdtempSync(join(tmpdir(), 'cred-')), options)
    expect(await store.read('chutes')).toEqual({ type: 'api_key', key: 'sk-123' })
  })

  test('oauth round-trip preserves CredentialFile shape incl. extras', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cred-'))
    await Bun.write(
      join(dir, 'cc.json'),
      JSON.stringify({
        provider: 'anthropic',
        refresh: 'r1',
        access: 'a1',
        expires: 111,
        projectId: 'p'
      })
    )
    const store = fileCredentialStore(dir, options)
    const cred = await store.read('cc')
    expect(cred).toMatchObject({ type: 'oauth', refresh: 'r1', access: 'a1', expires: 111 })
    await store.modify(
      'cc',
      async (current) =>
        ({
          ...(current as object),
          type: 'oauth',
          refresh: 'r2',
          access: 'a2',
          expires: 222
        }) as never
    )
    const onDisk = await Bun.file(join(dir, 'cc.json')).json()
    expect(onDisk.refresh).toBe('r2')
    expect(onDisk.provider).toBe('anthropic') // legacy field preserved
    expect(onDisk.projectId).toBe('p')
    expect(onDisk.type).toBeUndefined() // pi-ai tag not leaked to disk
  })

  test('modify is serialized per provider id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cred-'))
    await Bun.write(
      join(dir, 'cc.json'),
      JSON.stringify({ provider: 'anthropic', refresh: 'r', access: 'a', expires: 0 })
    )
    const store = fileCredentialStore(dir, options)
    const order: number[] = []
    await Promise.all([
      store.modify('cc', async (c) => {
        await Bun.sleep(20)
        order.push(1)
        return c
      }),
      store.modify('cc', async (c) => {
        order.push(2)
        return c
      })
    ])
    expect(order).toEqual([1, 2])
  })

  test('unknown provider id reads undefined; list covers config', async () => {
    const store = fileCredentialStore(mkdtempSync(join(tmpdir(), 'cred-')), options)
    expect(await store.read('nope')).toBeUndefined()
    const infos = await store.list()
    expect(infos.map((i) => i.providerId).sort()).toEqual(['cc', 'chutes'])
  })
})

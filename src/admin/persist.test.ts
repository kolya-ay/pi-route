// src/admin/persist.test.ts
import { describe, expect, it } from 'bun:test'
import { existsSync, rmSync, statSync } from 'node:fs'
import type { RouterOptions } from '../types'
import { createPersistHook } from './persist'

const sample: RouterOptions = {
  server: { port: 3000, host: '127.0.0.1' },
  auth: { apiKeys: [] },
  providers: {
    p1: {
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      accounts: [
        { type: 'api-key', name: 'a', key: 'k' },
        { type: 'antigravity-oauth', name: 'b', disabled: true }
      ],
      balancing: { strategy: 'round-robin' }
    }
  },
  authDir: '/tmp/auth',
  routing: { rules: [], scenarios: {}, default: { provider: 'p1' } },
  telemetry: { level: 'info' }
}

describe('createPersistHook', () => {
  it('writes JSON atomically and round-trips options', async () => {
    const dir = `/tmp/persist-${crypto.randomUUID()}`
    await Bun.write(`${dir}/router.json`, '{}')
    const path = `${dir}/router.json`
    const persist = createPersistHook(path)

    await persist(sample)

    expect(existsSync(`${path}.tmp`)).toBe(false)
    const read = JSON.parse(await Bun.file(path).text())
    expect(read.providers.p1.accounts[0].name).toBe('a')
    expect(read.providers.p1.accounts[1].disabled).toBe(true)

    rmSync(dir, { recursive: true, force: true })
  })

  it('produces pretty-printed JSON (2-space indent)', async () => {
    const dir = `/tmp/persist-${crypto.randomUUID()}`
    const path = `${dir}/router.json`
    const persist = createPersistHook(path)

    await persist(sample)
    const text = await Bun.file(path).text()
    expect(text).toContain('\n  "server"')
    expect(text).toContain('\n    "port"')

    rmSync(dir, { recursive: true, force: true })
  })

  it('writes file with mode 0o600 (owner read/write only)', async () => {
    const dir = `/tmp/persist-${crypto.randomUUID()}`
    const path = `${dir}/router.json`
    const persist = createPersistHook(path)

    await persist(sample)
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)

    rmSync(dir, { recursive: true, force: true })
  })
})

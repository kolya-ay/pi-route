// src/serve.test.ts
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let stop: (() => void) | undefined
afterEach(() => {
  stop?.()
  process.removeAllListeners('SIGHUP')
})

test('SIGHUP reloads the config in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-route-sighup-'))
  const cfg = join(dir, 'config.yml')

  writeFileSync(
    cfg,
    `
providers:
  c1:
    type: cerebras
    apiKey: k1

pipeline:
  alpha: c1/llama3.1-8b

expose:
  - alpha
`
  )

  const { startServer } = await import('./serve')
  const server = await startServer({ configPath: cfg, stateDir: dir, port: 0 })
  stop = () => server.stop(true)

  writeFileSync(
    cfg,
    `
providers:
  c1:
    type: cerebras
    apiKey: k1

pipeline:
  beta: c1/llama3.1-8b

expose:
  - beta
`
  )

  process.emit('SIGHUP')
  await Bun.sleep(200)

  const res = await fetch(`http://${server.hostname}:${server.port}/v1/models`)
  const body = (await res.json()) as { data: { id: string }[] }
  expect(body.data.some((m) => m.id === 'beta')).toBe(true)
})

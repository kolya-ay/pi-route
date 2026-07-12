// src/config/watch.test.ts
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchConfig } from './watch'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('watchConfig', () => {
  test('fires onChange (debounced) after the file is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-'))
    const cfg = join(dir, 'config.yaml')
    writeFileSync(cfg, 'a: 1\n')
    let hits = 0
    const stop = watchConfig(
      cfg,
      () => {
        hits += 1
      },
      40
    )
    await sleep(50)
    writeFileSync(cfg, 'a: 2\n')
    writeFileSync(cfg, 'a: 3\n') // burst — debounce should coalesce
    await sleep(150)
    stop()
    expect(hits).toBeGreaterThanOrEqual(1)
    expect(hits).toBeLessThanOrEqual(2)
  })
})

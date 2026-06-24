import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRuntimeState, writeRuntimeState } from './state'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-route-state-'))
})

describe('readRuntimeState', () => {
  test('returns empty when state.json does not exist', async () => {
    const s = await readRuntimeState(dir)
    expect(s).toEqual({ accounts: {} })
  })
  test('reads existing state.json', async () => {
    await Bun.write(
      join(dir, 'state.json'),
      JSON.stringify({
        accounts: { foo: { isInvalid: false } }
      })
    )
    const s = await readRuntimeState(dir)
    expect(s.accounts.foo).toEqual({ isInvalid: false })
  })
})

describe('writeRuntimeState', () => {
  test('writes atomically', async () => {
    await writeRuntimeState(dir, {
      accounts: { bar: { isInvalid: true } }
    })
    const re = JSON.parse(await Bun.file(join(dir, 'state.json')).text())
    expect(re.accounts.bar.isInvalid).toBe(true)
  })
  test('roundtrip preserves data', async () => {
    const original = {
      accounts: { x: { isInvalid: false } }
    }
    await writeRuntimeState(dir, original)
    expect(await readRuntimeState(dir)).toEqual(original)
  })
})

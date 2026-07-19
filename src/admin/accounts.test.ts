import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readRuntimeState } from '../config/state'
import { buildTestModels } from '../models/test-models'
import { buildCatalog } from '../pipeline/catalog'
import { createState, type RouterState } from '../state'
import type { RouterOptions } from '../types'
import { getAccount, listAccounts, setAccountInvalid } from './accounts'

const baseOpts: RouterOptions = {
  providers: {
    foo: { type: 'cerebras', account: { credential: 'key', key: 'k' } }
  },
  pipeline: [],
  expose: []
}

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pi-admin-'))
})

const mkState = (options: RouterOptions = baseOpts): RouterState => {
  const models = buildTestModels(options)
  return createState(options, buildCatalog(options, models), models, { accounts: {} }, dir)
}

describe('admin/accounts', () => {
  test('listAccounts returns one entry per provider', () => {
    const s = mkState()
    const list = listAccounts(s)
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('foo')
    expect(list[0]?.provider).toBe('foo')
    expect(list[0]?.type).toBe('cerebras')
    expect(list[0]?.disabled).toBe(false)
    expect(list[0]?.isInvalid).toBe(false)
  })

  test('listAccounts reflects runtime state', () => {
    const s = mkState()
    s.runtime.accounts.foo = { isInvalid: true }
    const list = listAccounts(s)
    expect(list[0]?.isInvalid).toBe(true)
  })

  test('listAccounts surfaces YAML-declared disabled flag', () => {
    const s = mkState({
      ...baseOpts,
      providers: {
        foo: { type: 'cerebras', account: { credential: 'key', key: 'k', disabled: true } }
      }
    })
    expect(listAccounts(s)[0]?.disabled).toBe(true)
  })

  test('getAccount returns matching entry', () => {
    const s = mkState()
    const got = getAccount(s, 'foo')
    expect(got).not.toBeNull()
    expect(got?.name).toBe('foo')
  })

  test('getAccount returns null for unknown name', () => {
    const s = mkState()
    expect(getAccount(s, 'nope')).toBeNull()
  })

  test('setAccountInvalid writes to state.json and memory', async () => {
    const s = mkState()
    await setAccountInvalid(s, 'foo', true)
    expect(s.runtime.accounts.foo?.isInvalid).toBe(true)
    const onDisk = await readRuntimeState(dir)
    expect(onDisk.accounts.foo?.isInvalid).toBe(true)
  })

  test('setAccountInvalid can clear back to false', async () => {
    const s = mkState()
    s.runtime.accounts.foo = { isInvalid: true }
    await setAccountInvalid(s, 'foo', false)
    const onDisk = await readRuntimeState(dir)
    expect(onDisk.accounts.foo?.isInvalid).toBe(false)
  })

  test('setAccountInvalid throws on unknown account', async () => {
    const s = mkState()
    await expect(setAccountInvalid(s, 'nope', true)).rejects.toThrow(/unknown/)
  })
})

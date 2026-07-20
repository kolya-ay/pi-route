// src/cli/verbs.test.ts

import { describe, expect, test } from 'bun:test'
import { dispatchVerb, renderVerbs, type Verb } from './verbs'

const calls: string[] = []
// config/stateDir mirror the global flags every real cac opts object carries
// (see ProviderOpts in src/cli.ts) — included here so the "global flags are
// always accepted" case below type-checks like a real invocation would.
const table: Verb<{ all?: boolean; type?: string; config?: string }, undefined>[] = [
  {
    name: 'list',
    description: 'List them',
    flags: ['--all'],
    run: async () => void calls.push('list')
  },
  {
    name: 'login',
    arg: '<name>',
    description: 'Log in',
    flags: ['--type'],
    run: async (_ctx, arg) => void calls.push(`login:${arg}`)
  }
]

describe('dispatchVerb', () => {
  test('routes to the named verb', async () => {
    await dispatchVerb('provider', table, ['login', 'cc'], { type: 'anthropic' }, undefined)
    expect(calls).toContain('login:cc')
  })

  test('a verb with no argument dispatches bare', async () => {
    await dispatchVerb('provider', table, ['list'], {}, undefined)
    expect(calls).toContain('list')
  })

  test('an unknown verb lists the valid ones', async () => {
    await expect(dispatchVerb('provider', table, ['bogus'], {}, undefined)).rejects.toThrow(
      /list.*login/s
    )
  })

  test('a missing required argument is a usage error', async () => {
    await expect(dispatchVerb('provider', table, ['login'], {}, undefined)).rejects.toThrow(
      /<name>/
    )
  })

  test('a flag not valid for the verb is a usage error', async () => {
    await expect(
      dispatchVerb('provider', table, ['list'], { type: 'anthropic' }, undefined)
    ).rejects.toThrow(/--type/)
  })

  test('global flags are always accepted', async () => {
    await dispatchVerb('provider', table, ['list'], { config: '/tmp/x.yml' }, undefined)
    expect(calls).toContain('list')
  })
})

test('renderVerbs lists every verb with its argument and flags', () => {
  const out = renderVerbs('provider', table)
  expect(out).toContain('provider login <name>')
  expect(out).toContain('--type')
})

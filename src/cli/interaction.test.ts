import { describe, expect, test } from 'bun:test'
import { selectAnswer, stdinInteraction } from './interaction'

const OPTIONS = [
  { id: 'browser', label: 'Browser login (default)' },
  { id: 'device', label: 'Device code login (headless)' }
] as const

describe('selectAnswer', () => {
  test('empty input picks the first option', () => {
    expect(selectAnswer(OPTIONS, '')).toBe('browser')
    expect(selectAnswer(OPTIONS, '  ')).toBe('browser')
  })

  test('accepts a 1-based number', () => {
    expect(selectAnswer(OPTIONS, '2')).toBe('device')
  })

  test('accepts an option id', () => {
    expect(selectAnswer(OPTIONS, 'device')).toBe('device')
  })

  test('rejects anything else', () => {
    expect(() => selectAnswer(OPTIONS, '9')).toThrow(/invalid selection/)
    expect(() => selectAnswer(OPTIONS, 'nope')).toThrow(/invalid selection/)
  })
})

describe('stdinInteraction', () => {
  test('a prompt stays pending until input arrives', async () => {
    // Never resolves: nothing is written to stdin during this test. The old,
    // buggy implementation used Bun's synchronous globalThis.prompt(), which
    // under a non-TTY test runner returns null (-> '') almost immediately
    // instead of blocking. This distinguishes that bug from the real fix.
    const pending = stdinInteraction().prompt({ type: 'text', message: 'waiting?' })
    pending.catch(() => {}) // left dangling on purpose; the process exits after the suite
    const outcome = await Promise.race([
      pending.then(() => 'settled'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 50))
    ])
    expect(outcome).toBe('pending')
  })

  test('an aborted prompt resolves empty instead of hanging', async () => {
    const controller = new AbortController()
    const pending = stdinInteraction().prompt({
      type: 'manual_code',
      message: 'paste url',
      signal: controller.signal
    })
    controller.abort()
    expect(await pending).toBe('')
  })
})

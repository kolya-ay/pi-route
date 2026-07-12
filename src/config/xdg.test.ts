import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { xdgConfigHome, xdgDataHome } from './xdg'

describe('xdg base dirs', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env.XDG_CONFIG_HOME
    delete process.env.XDG_DATA_HOME
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  test('falls back to ~/.config and ~/.local/share when unset', () => {
    expect(xdgConfigHome()).toBe(join(homedir(), '.config'))
    expect(xdgDataHome()).toBe(join(homedir(), '.local/share'))
  })

  test('honors an absolute XDG value', () => {
    process.env.XDG_CONFIG_HOME = '/custom/cfg'
    expect(xdgConfigHome()).toBe('/custom/cfg')
  })

  test('ignores a relative XDG value (spec requires absolute)', () => {
    process.env.XDG_DATA_HOME = 'relative/data'
    expect(xdgDataHome()).toBe(join(homedir(), '.local/share'))
  })
})

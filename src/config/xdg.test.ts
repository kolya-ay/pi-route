import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { xdgConfigHome, xdgStateHome } from './xdg'

describe('xdg base dirs', () => {
  const saved = { ...process.env }
  beforeEach(() => {
    delete process.env.XDG_CONFIG_HOME
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  test('falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    expect(xdgConfigHome()).toBe(join(homedir(), '.config'))
  })

  test('honors an absolute XDG value', () => {
    process.env.XDG_CONFIG_HOME = '/custom/cfg'
    expect(xdgConfigHome()).toBe('/custom/cfg')
  })

  describe('xdgStateHome', () => {
    beforeEach(() => {
      delete process.env.XDG_STATE_HOME
    })
    test('honors an absolute XDG_STATE_HOME', () => {
      process.env.XDG_STATE_HOME = '/custom/state'
      expect(xdgStateHome()).toBe('/custom/state')
    })
    test('falls back to ~/.local/state when unset', () => {
      delete process.env.XDG_STATE_HOME
      expect(xdgStateHome()).toBe(join(homedir(), '.local/state'))
    })
    test('ignores a relative XDG_STATE_HOME', () => {
      process.env.XDG_STATE_HOME = 'relative/state'
      expect(xdgStateHome()).toBe(join(homedir(), '.local/state'))
    })
  })
})

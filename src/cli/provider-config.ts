import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { RouterOptions } from '../types'
import { patchYaml } from './config-patch'
import { type Colorize, dim, green, red, renderTable } from './format'

// Upsert providers.<name> = block, preserving unrelated keys and block comments.
export const upsertProviderBlock = async (
  configPath: string,
  name: string,
  block: Record<string, unknown>
): Promise<void> => {
  const existing = existsSync(configPath) ? await Bun.file(configPath).text() : ''
  const patched = patchYaml(existing, [[['providers', name], block]])
  await Bun.write(configPath, patched)
}

// Delete auth/<name>.json. Returns true if a file was removed.
export const removeCredential = (authDir: string, name: string): boolean => {
  const path = join(authDir, `${name}.json`)
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}

export const formatProviderList = (options: RouterOptions, invalid: Set<string>): string => {
  const entries = Object.entries(options.providers)
  if (entries.length === 0) return '(no providers)'
  const rows = entries.map(([name, p]) => {
    const status = p.account.disabled ? 'disabled' : invalid.has(name) ? 'invalid' : 'ok'
    return [name, p.type, p.account.credential, status]
  })
  const colorize: Colorize = (_ri, ci, cell) => {
    if (ci !== 3) return cell
    const s = cell.trim()
    return s === 'ok' ? green(cell) : s === 'invalid' ? red(cell) : dim(cell)
  }
  return renderTable(['PROVIDER', 'TYPE', 'CREDENTIAL', 'STATUS'], rows, colorize)
}

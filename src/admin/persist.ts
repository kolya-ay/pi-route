// src/admin/persist.ts
import { chmodSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { RouterOptions } from '../types'

export const createPersistHook =
  (configPath: string) =>
  async (opts: RouterOptions): Promise<void> => {
    mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 })
    const tmp = `${configPath}.tmp`
    await Bun.write(tmp, JSON.stringify(opts, null, 2))
    chmodSync(tmp, 0o600)
    renameSync(tmp, configPath)
  }

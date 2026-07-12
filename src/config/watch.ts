// src/config/watch.ts
import { watch } from 'node:fs'
import { basename, dirname } from 'node:path'

// Watch the *parent dir* (not the file) so editor atomic-save-via-rename keeps
// firing. Debounce coalesces the multi-event burst a single save produces.
export const watchConfig = (
  configPath: string,
  onChange: () => void,
  debounceMs = 150
): (() => void) => {
  const dir = dirname(configPath)
  const file = basename(configPath)
  let timer: ReturnType<typeof setTimeout> | undefined
  const watcher = watch(dir, (_event, changed) => {
    if (changed !== null && changed !== file) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(onChange, debounceMs)
  })
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    watcher.close()
  }
}

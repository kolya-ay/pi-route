import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelsStore, ModelsStoreEntry } from '@earendil-works/pi-ai'

// One JSON file per provider id under <dir>/. Corrupt/missing → undefined;
// pi-ai treats that as "no stored catalog" and falls back to static models.
export const fileModelsStore = (dir: string): ModelsStore => {
  const pathFor = (id: string) => join(dir, `${encodeURIComponent(id)}.json`)
  return {
    async read(providerId) {
      try {
        const file = Bun.file(pathFor(providerId))
        if (!(await file.exists())) return undefined
        return (await file.json()) as ModelsStoreEntry
      } catch {
        return undefined
      }
    },
    async write(providerId, entry) {
      mkdirSync(dir, { recursive: true })
      await Bun.write(pathFor(providerId), JSON.stringify(entry))
    },
    async delete(providerId) {
      rmSync(pathFor(providerId), { force: true })
    }
  }
}

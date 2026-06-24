import { chmodSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

const AccountStateSchema = z.object({
  isInvalid: z.boolean().default(false)
})

const StateSchema = z.object({
  accounts: z.record(z.string(), AccountStateSchema).default({})
})

export type AccountRuntimeState = z.infer<typeof AccountStateSchema>
export type RuntimeState = z.infer<typeof StateSchema>

export const readRuntimeState = async (dir: string): Promise<RuntimeState> => {
  const f = Bun.file(join(dir, 'state.json'))
  if (!(await f.exists())) return { accounts: {} }
  const raw = await f.json()
  return StateSchema.parse(raw)
}

export const writeRuntimeState = async (dir: string, state: RuntimeState): Promise<void> => {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = join(dir, 'state.json')
  const tmp = `${path}.${Math.random().toString(36).slice(2)}.tmp`
  await Bun.write(tmp, JSON.stringify(state, null, 2))
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

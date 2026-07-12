// src/cli/agent.ts

import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { Edit } from './config-patch'

export type RoleModel = {
  id: string
  name: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: string[]
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
}

export type PlannedWrite = {
  path: string
  action: 'create' | 'update'
  before: string // existing file text; '' when creating
  content: string // full merged text to write
}

// The pi-route API-key env-var name. The token is a secret and stays in this
// env var (or ${...} reference) — never written to a config file.
export const PI_ROUTE_API_KEY = 'PI_ROUTE_API_KEY'

export const edit = (path: (string | number)[], value: unknown): Edit => [path, value]

export const dedupById = (models: RoleModel[]): RoleModel[] => [
  ...new Map(models.map((m) => [m.id, m])).values()
]

// Read the user's existing file (or start empty), merge pi-route's key-paths,
// return the full merged text. Absent file -> action 'create'.
export const mergedWrite = async (
  path: string,
  patch: (existing: string, edits: Edit[]) => string,
  edits: Edit[]
): Promise<PlannedWrite> => {
  const present = existsSync(path)
  const existing = present ? await readFile(path, 'utf8') : ''
  return {
    path,
    action: present ? 'update' : 'create',
    before: existing,
    content: patch(existing, edits)
  }
}

export const applyWrites = async (writes: PlannedWrite[]): Promise<void> => {
  await Promise.all(
    writes.map(async (w) => {
      await mkdir(dirname(w.path), { recursive: true })
      await writeFile(w.path, w.content)
    })
  )
}

// Derived once in setupModels so the eight writers don't each recompute (and
// re-assert) them: `all` = deduped default+fast members, `main` = the primary
// default (guaranteed present by setupModels' guard), `fast` = the fast-role lead.
export type AgentContext = {
  url: string
  home: string
  all: RoleModel[]
  main: RoleModel
  fast: RoleModel | null
}

export type Agent = {
  name: string // CLI id, e.g. 'claude'
  description: string // one-liner for --help and bare-install listing
  write: (ctx: AgentContext) => Promise<PlannedWrite[]>
}

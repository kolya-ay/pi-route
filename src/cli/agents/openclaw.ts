// src/cli/agents/openclaw.ts

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import {
  type Agent,
  edit,
  mergedWrite,
  PI_ROUTE_API_KEY,
  type PlannedWrite,
  type RoleModel
} from '../agent'
import { patchJson } from '../config-patch'

const openclawModel = (m: RoleModel) => ({
  id: m.id,
  name: m.name,
  ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
  input: m.input && m.input.length > 0 ? m.input : ['text'],
  ...(m.cost
    ? {
        cost: {
          input: m.cost.input ?? 0,
          output: m.cost.output ?? 0,
          cacheRead: m.cost.cacheRead ?? 0,
          cacheWrite: m.cost.cacheWrite ?? 0
        }
      }
    : {}),
  ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
  ...(m.maxTokens ? { maxTokens: m.maxTokens } : {})
})

export const openclaw: Agent = {
  name: 'openclaw',
  description: 'openclaw — ~/.openclaw/openclaw.json',
  write: async ({ url, home, all, main }): Promise<PlannedWrite[]> => {
    const path = join(home, '.openclaw/openclaw.json')
    // If `agents.defaults.model` is already an object, descend so sibling keys
    // survive; if it's a legacy scalar (or absent) jsonc-parser can't index into
    // it, so replace the whole node instead.
    const existing = existsSync(path)
      ? (parseJsonc(await readFile(path, 'utf8')) as
          | { agents?: { defaults?: { model?: unknown } } }
          | undefined)
      : undefined
    const modelNode = existing?.agents?.defaults?.model
    const modelIsObject = typeof modelNode === 'object' && modelNode !== null
    const primary = `piroute/${main.id}`
    const edits = [
      edit(['models', 'mode'], 'merge'),
      edit(['models', 'providers', 'piroute'], {
        baseUrl: `${url}/v1`,
        apiKey: `\${${PI_ROUTE_API_KEY}}`,
        api: 'openai-completions',
        models: all.map(openclawModel)
      }),
      modelIsObject
        ? edit(['agents', 'defaults', 'model', 'primary'], primary)
        : edit(['agents', 'defaults', 'model'], { primary }),
      edit(['agents', 'defaults', 'models', 'piroute/*'], {})
    ]
    return [await mergedWrite(path, patchJson, edits)]
  }
}

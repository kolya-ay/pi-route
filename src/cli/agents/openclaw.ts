// src/cli/agents/openclaw.ts

import { join } from 'node:path'
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
    const edits = [
      edit(['models', 'mode'], 'merge'),
      edit(['models', 'providers', 'piroute'], {
        baseUrl: `${url}/v1`,
        apiKey: `\${${PI_ROUTE_API_KEY}}`,
        api: 'openai-completions',
        models: all.map(openclawModel)
      }),
      edit(['agents', 'defaults', 'model', 'primary'], `piroute/${main.id}`),
      edit(['agents', 'defaults', 'models', 'piroute/*'], {})
    ]
    return [await mergedWrite(join(home, '.openclaw/openclaw.json'), patchJson, edits)]
  }
}

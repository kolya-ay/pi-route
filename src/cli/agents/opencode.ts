// src/cli/agents/opencode.ts

import { join } from 'node:path'
import type { ModelsDevModel } from '../../routes/model-projection'
import {
  type Agent,
  edit,
  mergedWrite,
  PI_ROUTE_API_KEY,
  type PlannedWrite,
  type RoleModel
} from '../agent'
import { patchJson } from '../config-patch'

const modelDev = (m: RoleModel): ModelsDevModel => ({
  id: m.id,
  name: m.name,
  attachment: Boolean(m.input?.includes('image')),
  reasoning: Boolean(m.reasoning),
  tool_call: true,
  temperature: true,
  modalities: { input: m.input && m.input.length > 0 ? m.input : ['text'], output: ['text'] },
  limit: {
    ...(m.contextWindow ? { context: m.contextWindow } : {}),
    ...(m.maxTokens ? { output: m.maxTokens } : {})
  },
  cost: {
    ...(m.cost?.input !== undefined ? { input: m.cost.input } : {}),
    ...(m.cost?.output !== undefined ? { output: m.cost.output } : {}),
    ...(m.cost?.cacheRead !== undefined ? { cache_read: m.cost.cacheRead } : {}),
    ...(m.cost?.cacheWrite !== undefined ? { cache_write: m.cost.cacheWrite } : {})
  }
})

export const opencode: Agent = {
  name: 'opencode',
  description: 'opencode — ~/.config/opencode/opencode.json',
  write: async ({ url, home, all, main, fast }): Promise<PlannedWrite[]> => {
    const models = Object.fromEntries(all.map((m) => [m.id, modelDev(m)]))
    const edits = [
      edit(['model'], `pi-route/${main.id}`),
      ...(fast ? [edit(['small_model'], `pi-route/${fast.id}`)] : []),
      edit(['provider', 'pi-route'], {
        npm: '@ai-sdk/openai-compatible',
        name: 'pi-route',
        id: 'pi-route',
        api: `${url}/v1`,
        env: [PI_ROUTE_API_KEY],
        options: { baseURL: `${url}/v1` },
        models
      })
    ]
    return [await mergedWrite(join(home, '.config/opencode/opencode.json'), patchJson, edits)]
  }
}

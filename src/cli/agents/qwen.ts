// src/cli/agents/qwen.ts

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

const qwenModel = (m: RoleModel, url: string) => ({
  id: m.id,
  name: m.name,
  baseUrl: `${url}/v1`,
  envKey: PI_ROUTE_API_KEY,
  ...(m.input?.includes('image') ? { capabilities: { vision: true } } : {}),
  ...(m.contextWindow ? { generationConfig: { contextWindowSize: m.contextWindow } } : {})
})

export const qwen: Agent = {
  name: 'qwen',
  description: 'Qwen Code — ~/.qwen/settings.json',
  write: async ({ url, home, all, main }): Promise<PlannedWrite[]> => {
    const edits = [
      edit(['security', 'auth'], { selectedType: 'openai', baseUrl: `${url}/v1` }),
      edit(['providerProtocol', 'openai'], 'openai'),
      edit(
        ['modelProviders', 'openai'],
        all.map((m) => qwenModel(m, url))
      ),
      edit(['model', 'name'], main.id)
    ]
    return [await mergedWrite(join(home, '.qwen/settings.json'), patchJson, edits)]
  }
}

// src/cli/agents/pi.ts

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

const piOverride = (m: RoleModel) => ({
  name: m.name,
  ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
  ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
  ...(m.cost
    ? {
        cost: {
          ...(m.cost.input !== undefined ? { input: m.cost.input } : {}),
          ...(m.cost.output !== undefined ? { output: m.cost.output } : {})
        }
      }
    : {})
})

export const pi: Agent = {
  name: 'pi',
  description: 'pi — ~/.pi/agent/*.json',
  write: async ({ url, home, all, main }): Promise<PlannedWrite[]> => {
    return [
      await mergedWrite(join(home, '.pi/agent/models.json'), patchJson, [
        edit(['providers', 'piroute'], {
          name: 'pi-route',
          baseUrl: `${url}/v1`,
          apiKey: `\${${PI_ROUTE_API_KEY}}`,
          api: 'openai-completions',
          models: [],
          modelOverrides: Object.fromEntries(all.map((m) => [m.id, piOverride(m)]))
        })
      ]),
      await mergedWrite(join(home, '.pi/agent/settings.json'), patchJson, [
        edit(['defaultProvider'], 'piroute'),
        edit(['defaultModel'], main.id)
      ])
    ]
  }
}

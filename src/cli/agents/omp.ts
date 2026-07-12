// src/cli/agents/omp.ts

import { join } from 'node:path'
import {
  type Agent,
  edit,
  mergedWrite,
  PI_ROUTE_API_KEY,
  type PlannedWrite,
  type RoleModel
} from '../agent'
import { patchYaml } from '../config-patch'

const ompModelOverride = (m: RoleModel) => ({
  name: m.name,
  ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
  ...(m.maxTokens ? { maxTokens: m.maxTokens } : {}),
  ...(m.cost?.input !== undefined || m.cost?.output !== undefined
    ? {
        cost: {
          ...(m.cost.input !== undefined ? { input: m.cost.input } : {}),
          ...(m.cost.output !== undefined ? { output: m.cost.output } : {})
        }
      }
    : {})
})

export const omp: Agent = {
  name: 'omp',
  description: 'omp — ~/.omp/agent/*.yml',
  write: async ({ url, home, all, main, fast }): Promise<PlannedWrite[]> => {
    return [
      await mergedWrite(join(home, '.omp/agent/models.yml'), patchYaml, [
        edit(['providers', 'piroute'], {
          baseUrl: `${url}/v1`,
          // omp reads apiKey as an env-var name (or literal fallback); keep the token in env.
          apiKey: PI_ROUTE_API_KEY,
          api: 'openai-completions',
          auth: 'apiKey',
          discovery: { type: 'litellm' },
          modelOverrides: Object.fromEntries(all.map((m) => [m.id, ompModelOverride(m)]))
        })
      ]),
      await mergedWrite(join(home, '.omp/agent/config.yml'), patchYaml, [
        edit(['modelRoles', 'default'], `piroute/${main.id}`),
        ...(fast ? [edit(['modelRoles', 'smol'], `piroute/${fast.id}`)] : [])
      ])
    ]
  }
}

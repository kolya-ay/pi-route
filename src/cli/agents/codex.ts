// src/cli/agents/codex.ts

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type Agent,
  edit,
  mergedWrite,
  PI_ROUTE_API_KEY,
  type PlannedWrite,
  type RoleModel
} from '../agent'
import { patchToml } from '../config-patch'

// Codex resolves request model ids by longest-prefix against a bundled catalog.
// A custom-provider id (real backend address) matches nothing -> "metadata not
// found" warning. A static model_catalog_json whose slug == the id silences it.
// Required fields track codex-rs/protocol/src/openai_models.rs on `main`; if
// codex errors at startup parsing this file, upstream added a field — add it here.
const codexCatalogEntry = (m: RoleModel) => ({
  slug: m.id,
  display_name: m.name,
  supported_reasoning_levels: [] as string[],
  shell_type: 'shell_command',
  visibility: 'list',
  supported_in_api: true,
  priority: 1,
  base_instructions: '',
  supports_reasoning_summaries: false,
  default_reasoning_summary: 'none',
  support_verbosity: false,
  truncation_policy: { mode: 'tokens', limit: 10000 }, // codex default truncation window
  supports_parallel_tool_calls: true,
  experimental_supported_tools: [] as string[],
  context_window: m.contextWindow ?? 200000, // codex fallback when pi-route has no metadata
  max_context_window: m.contextWindow ?? 200000
})

export const codex: Agent = {
  name: 'codex',
  description: 'Codex — ~/.codex/config.toml + catalog',
  write: async ({ url, home, all, main }): Promise<PlannedWrite[]> => {
    // codex resolves a relative model_catalog_json against ~/.codex/ (its config
    // dir), not cwd — so the bare basename points at the file we write beside it.
    const catalogFile = 'pi-route-catalog.json'
    const catalogPath = join(home, '.codex', catalogFile)
    const edits = [
      edit(['model'], main.id),
      edit(['model_provider'], 'piroute'),
      edit(['model_catalog_json'], catalogFile),
      ...(main.contextWindow ? [edit(['model_context_window'], main.contextWindow)] : []),
      ...(main.maxTokens ? [edit(['model_max_output_tokens'], main.maxTokens)] : []),
      edit(['model_providers', 'piroute'], {
        name: 'pi-route',
        base_url: `${url}/v1`,
        wire_api: 'responses',
        env_key: PI_ROUTE_API_KEY,
        requires_openai_auth: false
      })
    ]
    // pi-route-owned catalog file: overwrite (not a merge). codex parses it as { models: ModelInfo[] }.
    const catalogContent = `${JSON.stringify({ models: all.map(codexCatalogEntry) }, null, 2)}\n`
    const catalogExists = existsSync(catalogPath)
    const catalogBefore = catalogExists ? await readFile(catalogPath, 'utf8') : ''
    return [
      await mergedWrite(join(home, '.codex/config.toml'), patchToml, edits),
      {
        path: catalogPath,
        action: catalogExists ? 'update' : 'create',
        before: catalogBefore,
        content: catalogContent
      }
    ]
  }
}

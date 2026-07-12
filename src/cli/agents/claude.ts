// src/cli/agents/claude.ts

import { join } from 'node:path'
import { type Agent, edit, mergedWrite, type PlannedWrite } from '../agent'
import { patchJson } from '../config-patch'

export const claude: Agent = {
  name: 'claude',
  description: 'Claude Code — ~/.claude/settings.json',
  write: async ({ url, home, all, main, fast }): Promise<PlannedWrite[]> => {
    // Token stays in the ambient ANTHROPIC_AUTH_TOKEN env var, not baked here.
    // Fast/background slot (titles, summaries) uses ANTHROPIC_DEFAULT_HAIKU_MODEL;
    // ANTHROPIC_SMALL_FAST_MODEL is deprecated.
    const edits = [
      edit(['model'], main.id),
      edit(
        ['availableModels'],
        all.map((m) => m.id)
      ),
      edit(['env', 'ANTHROPIC_BASE_URL'], url),
      edit(['env', 'ANTHROPIC_MODEL'], main.id),
      ...(fast ? [edit(['env', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'], fast.id)] : [])
    ]
    return [await mergedWrite(join(home, '.claude/settings.json'), patchJson, edits)]
  }
}

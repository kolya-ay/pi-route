// src/cli/agents/zed.ts

import { join } from 'node:path'
import { type Agent, edit, mergedWrite, type PlannedWrite, type RoleModel } from '../agent'
import { patchJson } from '../config-patch'

// Zed reads the model catalog + all metadata ONLY from settings.json ->
// available_models (it never calls /v1/models for an openai_compatible provider).
// Verified against zed main: reasoning_effort is open_ai::ReasoningEffort (lowercase
// minimal|low|medium|high|xhigh|max|none), "medium" valid; ModelCapabilities uses serde
// defaults so a { tools, images } subset is accepted; the openai_compatible settings
// sub-key is the provider id used in agent.default_model.provider ("pi-route"); the edit-
// prediction provider literal is "open_ai_compatible_api" (edit_predictions sub-key), fields
// api_url/model/max_output_tokens(64)/prompt_format:"infer".
const openaiCompatibleModel = (m: RoleModel) => ({
  name: m.id,
  display_name: m.name,
  // Zed "max_tokens" == context window
  ...(m.contextWindow ? { max_tokens: m.contextWindow } : {}),
  ...(m.maxTokens ? { max_output_tokens: m.maxTokens } : {}),
  capabilities: { tools: true, images: m.input?.includes('image') ?? false },
  ...(m.reasoning ? { reasoning_effort: 'medium' } : {})
})

export const zed: Agent = {
  name: 'zed',
  description: 'Zed — ~/.config/zed/settings.json',
  write: async ({ url, home, all, main, fast }): Promise<PlannedWrite[]> => {
    const edits = [
      edit(['language_models', 'openai_compatible', 'pi-route'], {
        api_url: `${url}/v1`,
        available_models: all.map(openaiCompatibleModel)
      }),
      edit(['agent', 'default_model'], {
        provider: 'pi-route',
        model: main.id,
        enable_thinking: Boolean(main.reasoning)
      }),
      ...(fast
        ? [
            edit(['edit_predictions', 'open_ai_compatible_api'], {
              api_url: `${url}/v1`,
              model: fast.id,
              max_output_tokens: fast.maxTokens ?? 64,
              prompt_format: 'infer'
            }),
            edit(['features', 'edit_prediction_provider'], 'open_ai_compatible_api')
          ]
        : [])
    ]
    return [await mergedWrite(join(home, '.config/zed/settings.json'), patchJson, edits)]
  }
}

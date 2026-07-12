import type { Api, Model } from '@mariozechner/pi-ai'
import type { ModelMeta } from './catalog'

// pi-ai `Model` → our `ModelMeta`. Copies only the fields the projections use.
export const toModelMeta = (m: Model<Api>): ModelMeta => {
  const compat = (m as unknown as { compat?: { supportsReasoningEffort?: boolean } }).compat
  return {
    name: m.name,
    ...(m.contextWindow !== undefined ? { contextWindow: m.contextWindow } : {}),
    ...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
    ...(m.cost !== undefined
      ? {
          cost: {
            ...(m.cost.input !== undefined ? { input: m.cost.input } : {}),
            ...(m.cost.output !== undefined ? { output: m.cost.output } : {}),
            ...(m.cost.cacheRead !== undefined ? { cacheRead: m.cost.cacheRead } : {}),
            ...(m.cost.cacheWrite !== undefined ? { cacheWrite: m.cost.cacheWrite } : {})
          }
        }
      : {}),
    reasoning: Boolean(m.reasoning),
    ...(Array.isArray(m.input) ? { input: m.input } : {}),
    ...(m.thinkingLevelMap !== undefined
      ? { thinkingLevelMap: m.thinkingLevelMap as Record<string, string | null> }
      : {}),
    ...(compat?.supportsReasoningEffort !== undefined
      ? { supportsReasoningEffort: compat.supportsReasoningEffort }
      : {})
  }
}

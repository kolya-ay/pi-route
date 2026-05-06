// src/routing/rule-match.ts

import type { RoutingStrategy, RoutingContext, RoutingDecision } from '../types'

const globToRegex = (pattern: string): RegExp => {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

export const ruleMatchStrategy: RoutingStrategy = {
  name: 'rule-match',
  resolve(context: RoutingContext): RoutingDecision | null {
    const { model, options } = context
    for (const rule of options.routing.rules) {
      if (globToRegex(rule.match).test(model)) {
        return { provider: rule.provider, reason: `rule: ${rule.match}` }
      }
    }
    return null
  }
}

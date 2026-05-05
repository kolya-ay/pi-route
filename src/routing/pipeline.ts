// src/routing/pipeline.ts

import type { RoutingStrategy, RoutingContext, RoutingDecision } from '../types.js'
import { ruleMatchStrategy } from './rule-match.js'
import { scenarioStrategy } from './scenario.js'

export const createRoutingPipeline = (): RoutingStrategy => ({
  name: 'pipeline',
  resolve(context: RoutingContext): RoutingDecision {
    const strategies: RoutingStrategy[] = [ruleMatchStrategy, scenarioStrategy]

    for (const strategy of strategies) {
      const decision = strategy.resolve(context)
      if (decision !== null) return decision
    }

    return { backend: context.options.routing.default.backend, reason: 'default' }
  },
})

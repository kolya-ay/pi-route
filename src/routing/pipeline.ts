// src/routing/pipeline.ts

import type { RoutingStrategy, RoutingContext, RoutingDecision } from '../types'

import { ruleMatchStrategy } from './rule-match'
import { scenarioStrategy } from './scenario'

export const createRoutingPipeline = (): RoutingStrategy => ({
  name: 'pipeline',
  resolve(context: RoutingContext): RoutingDecision {
    const strategies: RoutingStrategy[] = [ruleMatchStrategy, scenarioStrategy]

    for (const strategy of strategies) {
      const decision = strategy.resolve(context)
      if (decision !== null) return decision
    }

    return { provider: context.options.routing.default.provider, reason: 'default' }
  }
})

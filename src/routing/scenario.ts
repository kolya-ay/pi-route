// src/routing/scenario.ts

import type { RoutingStrategy, RoutingContext, RoutingDecision, ScenarioType } from '../types'

const detectScenario = (context: RoutingContext): ScenarioType | null => {
  const { model, body } = context

  if (body.thinking !== undefined || body.reasoning_effort !== undefined) {
    return 'thinking'
  }

  if (/haiku/i.test(model)) {
    return 'background'
  }

  return null
}

export const scenarioStrategy: RoutingStrategy = {
  name: 'scenario',
  resolve(context: RoutingContext): RoutingDecision | null {
    const scenario = detectScenario(context)
    if (scenario === null) return null

    const config = context.options.routing.scenarios[scenario]
    if (!config) return null

    return { provider: config.provider, model: config.model, reason: `scenario: ${scenario}` }
  }
}

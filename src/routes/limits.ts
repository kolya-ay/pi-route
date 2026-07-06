import { Hono } from 'hono'
import { collectLimitsSnapshot } from '../limits'
import type { RouterState } from '../state'
import type { Tel } from '../telemetry/tel'

export const createLimitsRoute = (state: RouterState, tel: Tel): Hono => {
  const app = new Hono()
  app.get('/', async (c) => c.json(await collectLimitsSnapshot(state, tel)))
  return app
}

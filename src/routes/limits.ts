import { Hono } from 'hono'
import { collectLimitsSnapshot } from '../limits'
import type { RouterState } from '../state'

export const createLimitsRoute = (state: RouterState): Hono => {
  const app = new Hono()
  app.get('/', async (c) => c.json(await collectLimitsSnapshot(state)))
  return app
}

import { Hono } from 'hono'
import type { RouterState } from '../state'
import { exposedAddresses, resolveModel, toOpenAIModel } from './model-projection'

// Reads options/catalog/models from `state` at request time so a post-refresh
// catalog rebuild is reflected in the listing without a reload.
export const createModelsRoute = (state: RouterState): Hono => {
  const app = new Hono()
  app.get('/', (c) => {
    const { options, catalog, models } = state
    const data = exposedAddresses(options, catalog).map((addr) =>
      toOpenAIModel(resolveModel(options, catalog, models, addr))
    )
    return c.json({ object: 'list', data })
  })
  return app
}

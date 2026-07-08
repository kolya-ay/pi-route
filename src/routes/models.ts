import { Hono } from 'hono'
import type { Catalog } from '../pipeline/catalog'
import type { RouterOptions } from '../types'
import { exposedAddresses, resolveModel, toOpenAIModel } from './model-projection'

export const createModelsRoute = (options: RouterOptions, catalog: Catalog): Hono => {
  const app = new Hono()
  const data = exposedAddresses(options, catalog).map((addr) =>
    toOpenAIModel(resolveModel(options, catalog, addr))
  )
  const body = { object: 'list', data }
  app.get('/', (c) => c.json(body))
  return app
}

import type { Models } from '@earendil-works/pi-ai'
import type { Catalog } from '../pipeline/catalog'
import type { RouterOptions } from '../types'
import {
  exposedAddresses,
  type ModelsDevModel,
  resolveModel,
  toModelsDevModel
} from './model-projection'

// The models map (keyed by pi-route address).
export const buildOpencodeModels = (
  options: RouterOptions,
  catalog: Catalog,
  models: Models
): Record<string, ModelsDevModel> =>
  Object.fromEntries(
    exposedAddresses(options, catalog)
      .map((addr): [string, ModelsDevModel | null] => [
        addr,
        toModelsDevModel(resolveModel(options, catalog, models, addr))
      ])
      .filter((e): e is [string, ModelsDevModel] => e[1] !== null)
  )

// Per-request: the callback URL OpenCode should POST inference to.
type ReqLike = { header: (name: string) => string | undefined; url: string }
export const resolveApiUrl = (req: ReqLike, override?: string): string => {
  if (override) return override
  const u = new URL(req.url)
  // Host/x-forwarded-proto are client-controlled; a spoofed value only changes
  // the callback URL OpenCode dials back to (self-redirect) — no data exposure.
  const host = req.header('host') ?? u.host
  const proto = req.header('x-forwarded-proto') ?? u.protocol.replace(':', '')
  return `${proto}://${host}/v1`
}

// models.dev catalog envelope: one synthetic `pi-route` provider.
export const renderApiJson = (models: Record<string, ModelsDevModel>, api: string) => ({
  'pi-route': {
    id: 'pi-route',
    npm: '@ai-sdk/openai-compatible',
    name: 'pi-route',
    api,
    env: ['PI_ROUTE_API_KEY'],
    models
  }
})

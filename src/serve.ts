// src/serve.ts

import { loadRouter } from './app'

const configPath = Bun.env.ROUTER_CONFIG ?? 'router.json'
const adminKey = Bun.env.PI_ROUTE_ADMIN_KEY

const router = await loadRouter(configPath, adminKey ? { admin: { authKey: adminKey } } : {})

console.log(
  `Router listening on http://${router.options.server.host}:${router.options.server.port}`
)

export default {
  port: router.options.server.port,
  hostname: router.options.server.host,
  fetch: router.app.fetch
}

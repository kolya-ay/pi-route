// src/serve.ts

import { createApp } from './app'
import { type EnvPathOverrides, readEnvConfig } from './config/env'

export const startServer = async (overrides: EnvPathOverrides = {}) => {
  const env = readEnvConfig(overrides)
  const adminKey = process.env.PI_ROUTE_ADMIN_KEY
  const router = await createApp(adminKey ? { admin: { authKey: adminKey } } : {}, overrides)
  const server = Bun.serve({
    port: env.port,
    hostname: env.host,
    idleTimeout: env.idleTimeout,
    fetch: router.app.fetch
  })
  console.log(`Router listening on http://${server.hostname}:${server.port}`)
  return server
}

if (import.meta.main) {
  await startServer()
}

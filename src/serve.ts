// src/serve.ts

import { createApp } from './app'
import { type EnvPathOverrides, readEnvConfig } from './config/env'

export async function startServer(overrides: EnvPathOverrides = {}) {
  const env = readEnvConfig(overrides)
  const adminKey = process.env.PI_ROUTE_ADMIN_KEY
  await createApp(adminKey ? { admin: { authKey: adminKey } } : {}, overrides)
  console.log(`Router listening on http://${env.host}:${env.port}`)
}

const env = readEnvConfig({})
const adminKey = process.env.PI_ROUTE_ADMIN_KEY
const router = await createApp(adminKey ? { admin: { authKey: adminKey } } : {}, {})

console.log(`Router listening on http://${env.host}:${env.port}`)

export default {
  port: env.port,
  hostname: env.host,
  idleTimeout: env.idleTimeout,
  fetch: router.app.fetch
}

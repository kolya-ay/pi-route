// src/serve.ts

import { createApp } from './app'
import { parseCliPathArgs } from './cli/args'
import { readEnvConfig } from './config/env'

const { overrides } = parseCliPathArgs(Bun.argv.slice(2))
const env = readEnvConfig(overrides)
const adminKey = process.env.PI_ROUTE_ADMIN_KEY

const router = await createApp(adminKey ? { admin: { authKey: adminKey } } : {}, overrides)

console.log(`Router listening on http://${env.host}:${env.port}`)

export default {
  port: env.port,
  hostname: env.host,
  idleTimeout: env.idleTimeout,
  fetch: router.app.fetch
}

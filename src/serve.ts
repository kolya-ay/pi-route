// src/serve.ts

import { createApp } from './app'
import { readEnvConfig } from './config/env'

const env = readEnvConfig()
const adminKey = process.env.PI_ROUTE_ADMIN_KEY

const router = await createApp(adminKey ? { admin: { authKey: adminKey } } : {})

console.log(`Router listening on http://${env.host}:${env.port}`)

export default {
  port: env.port,
  hostname: env.host,
  fetch: router.app.fetch
}

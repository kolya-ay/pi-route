import { serve } from '@hono/node-server'

import { createApp } from './app.js'
import { loadConfig } from './config/loader.js'

const configPath = process.env['ROUTER_CONFIG'] ?? 'router.json'
const options = loadConfig(configPath)
const app = createApp(options)

serve({ fetch: app.fetch, port: options.server.port }, (info) => {
  console.log(`Router listening on http://${options.server.host}:${info.port}`)
})

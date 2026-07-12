// src/serve.ts

import { createApp } from './app'
import { cancelRefresh } from './auth/scheduler'
import { type EnvPathOverrides, readEnvConfig } from './config/env'
import { watchConfig } from './config/watch'

export const startServer = async (
  overrides: EnvPathOverrides = {},
  opts: { watch?: boolean } = {}
) => {
  const env = readEnvConfig(overrides)
  const adminKey = process.env.PI_ROUTE_ADMIN_KEY
  const appOpts = adminKey ? { admin: { authKey: adminKey } } : {}
  let current = await createApp(appOpts, overrides)
  const server = Bun.serve({
    port: env.port,
    hostname: env.host,
    idleTimeout: env.idleTimeout,
    fetch: current.app.fetch
  })
  console.log(`Router listening on http://${server.hostname}:${server.port}`)

  const watchEnabled = opts.watch === true || process.env.PI_ROUTE_WATCH === '1'
  if (watchEnabled) {
    // Serialize reloads: createApp does network I/O, so two rapid saves could
    // otherwise race on `current` — serving stale config and leaking the newer
    // state's refresh timers. A reload in flight defers the next to one re-run.
    let reloading = false
    let again = false
    const reload = async (): Promise<void> => {
      if (reloading) {
        again = true
        return
      }
      reloading = true
      try {
        const next = await createApp(appOpts, overrides)
        const previous = current
        server.reload({ fetch: next.app.fetch })
        // Cancel the just-replaced state's refresh timers so they don't
        // double-schedule alongside the new state's.
        for (const name of [...previous.timers.keys()]) cancelRefresh(previous, name)
        current = next
        console.log('Config reloaded')
      } catch (error) {
        console.error(
          `Config reload failed — keeping previous config: ${error instanceof Error ? error.message : String(error)}`
        )
      } finally {
        reloading = false
        if (again) {
          again = false
          void reload()
        }
      }
    }
    watchConfig(env.configPath, () => void reload())
    console.log(`Watching ${env.configPath} for changes`)
  }
  return server
}

if (import.meta.main) {
  await startServer()
}

// src/serve.ts

import { createApp } from './app'
import { type EnvPathOverrides, readEnvConfig } from './config/env'
import { watchConfig } from './config/watch'
import { shutdownOtel } from './telemetry/tel'

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

  // Serialize reloads: createApp does network I/O, so two rapid triggers could
  // otherwise race on `current` — serving stale config and leaking the newer
  // state's refresh timer. A reload in flight defers the next to one re-run.
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
      previous.stop() // clear the superseded app's background refresh interval
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

  // SIGHUP is the production reload trigger (systemd ExecReload); always on.
  process.on('SIGHUP', () => void reload())

  // systemd stop sends SIGTERM; Ctrl-C sends SIGINT. Flush the span batch before exit,
  // or the last BatchSpanProcessor interval of traces is lost. A collector that is down
  // fails the flush; that loses those spans but must not turn a clean stop into a crash.
  // A second signal while shutting down is ignored.
  let stopping = false
  const shutdown = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    current.stop()
    await server.stop()
    await shutdownOtel().catch((err) =>
      console.error(
        `[otel] flush on shutdown failed: ${err instanceof Error ? err.message : String(err)}`
      )
    )
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())

  // File-watch is a dev/opt-in convenience.
  const watchEnabled = opts.watch === true || process.env.PI_ROUTE_WATCH === '1'
  if (watchEnabled) {
    watchConfig(env.configPath, () => void reload())
    console.log(`Watching ${env.configPath} for changes`)
  }
  return server
}

if (import.meta.main) {
  await startServer()
}

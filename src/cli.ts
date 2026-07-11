#!/usr/bin/env bun

// src/cli.ts

import { getOAuthProvider, type OAuthCredentials } from '@mariozechner/pi-ai/oauth'
import cac from 'cac'
import { z } from 'zod'

import { writeCredentials } from './auth/credentials'
import { deriveName } from './auth/name-derivers'
import { registerAllOAuthProviders } from './auth/register-all-oauth'
import {
  type Harness,
  listModelIds,
  renderPlannedWrites,
  setupModels,
  showModel
} from './cli/models'
import { formatTable, runStats } from './cli/stats'
import { type EnvPathOverrides, readEnvConfig } from './config/env'
import { ConfigError } from './config/errors'
import { loadConfig } from './config/loader'
import { collectLimitsSnapshot } from './limits'
import { buildCatalog } from './pipeline/catalog'
import { createState } from './state'
import { createTel } from './telemetry/tel'
import type { CredentialFile } from './types'

// cac tags its own arg/option errors with name 'CACError' (not exported). Reuse that
// name so self-raised usage errors share the exit-2 path — no bespoke error type.
const usageError = (message: string): Error =>
  Object.assign(new Error(message), { name: 'CACError' })

const toOverrides = (options: { config?: string; authDir?: string }): EnvPathOverrides => {
  const overrides: EnvPathOverrides = {}
  if (options.config) overrides.configPath = options.config
  if (options.authDir) overrides.authDir = options.authDir
  return overrides
}

const tryOpen = (url: string): void => {
  for (const opener of ['xdg-open', 'open']) {
    try {
      Bun.spawn([opener, url]).exited.catch(() => {})
      return
    } catch {
      // try next opener
    }
  }
}

const StatsArgsSchema = z.object({
  by: z.enum(['provider', 'model', 'day', 'session']),
  since: z.string().regex(/^\d+[dh]$/, 'expected e.g. 7d or 12h')
})

const pkg = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as {
  version: string
}

const cli = cac('pi-route')

cli.option('-c, --config <path>', 'Config file path (default: ~/.config/pi-route.yaml)')
cli.option('--auth-dir <dir>', 'Auth/credentials directory')

cli
  .command(
    'login <type> [name]',
    'Authenticate an OAuth provider (types: anthropic, openai-codex, google-antigravity)'
  )
  .action(
    async (
      type: string,
      name: string | undefined,
      options: { config?: string; authDir?: string }
    ) => {
      registerAllOAuthProviders()
      const provider = getOAuthProvider(type)
      if (!provider) throw usageError(`unknown OAuth provider: "${type}"`)

      const env = readEnvConfig(toOverrides(options))
      const creds: OAuthCredentials = await provider.login({
        onAuth: ({ url }: { url: string }) => {
          console.error(`Open in browser: ${url}`)
          tryOpen(url)
        },
        onPrompt: async () => '',
        onProgress: (msg: string) => console.error(`… ${msg}`)
      })

      const resolved = name ?? deriveName(type, creds)
      if (!resolved) {
        throw usageError(`name required for provider "${type}": pi-route login ${type} <name>`)
      }

      const credentialFile: CredentialFile = { ...creds, provider: type }
      await writeCredentials(env.authDir, resolved, credentialFile)
      console.log(`Logged in: ${type}/${resolved}`)
    }
  )

cli
  .command('serve', 'Start the HTTP server')
  .action(async (options: { config?: string; authDir?: string }) => {
    await import('./serve').then((m) => m.startServer(toOverrides(options)))
  })

cli
  .command('limits', 'Print a rate-limit snapshot as JSON')
  .action(async (options: { config?: string; authDir?: string }) => {
    registerAllOAuthProviders()
    const env = readEnvConfig(toOverrides(options))
    const { options: routerOptions, state: runtime } = await loadConfig(env.configPath, env.authDir)
    const catalog = buildCatalog(routerOptions)
    const state = createState(routerOptions, catalog, runtime, env.authDir)
    const snapshot = await collectLimitsSnapshot(state, createTel())
    console.log(JSON.stringify(snapshot, null, 2))
  })

const loadRouterOptions = async (options: { config?: string; authDir?: string }) => {
  const env = readEnvConfig(toOverrides(options))
  const { options: routerOptions } = await loadConfig(env.configPath, env.authDir)
  return routerOptions
}

cli
  .command('models [sub] [model]', 'List / show / install models')
  .option('--home-dir <dir>', 'Home directory for install (default: $HOME)')
  .option('--dry', 'Print planned writes without changing files')
  .action(
    async (
      sub: string | undefined,
      model: string | undefined,
      options: { config?: string; authDir?: string; homeDir?: string; dry?: boolean }
    ) => {
      const routerOptions = await loadRouterOptions(options)
      if (sub === 'show') {
        if (!model)
          throw usageError('models show requires a model id: pi-route models show <model>')
        console.log(JSON.stringify(showModel(routerOptions, model), null, 2))
        return
      }
      if (sub === 'install') {
        if (!model)
          throw usageError('models install requires a harness: pi-route models install <harness>')
        const KNOWN_HARNESSES: Record<string, true> = {
          claude: true,
          codex: true,
          qwen: true,
          opencode: true,
          omp: true,
          pi: true,
          openclaw: true
        }
        if (!KNOWN_HARNESSES[model]) throw usageError(`unknown models install harness: ${model}`)
        const setupOpts: { dry: boolean; homeDir?: string } = { dry: Boolean(options.dry) }
        if (options.homeDir) setupOpts.homeDir = options.homeDir
        const writes = await setupModels(routerOptions, model as Harness, setupOpts)
        if (options.dry) console.log(renderPlannedWrites(writes))
        return
      }
      if (sub !== undefined && sub !== 'list') {
        throw usageError(`unknown models subcommand: "${sub}" (expected: list | show | install)`)
      }
      const ids = listModelIds(routerOptions)
      if (ids.length > 0) console.log(ids.join('\n'))
    }
  )

cli
  .command('stats', 'Query telemetry from the OTel viewer')
  .option('--by <dim>', 'Group by: provider|model|day|session', { default: 'provider' })
  .option('--since <range>', 'Time range, e.g. 7d or 12h', { default: '7d' })
  .action(async (options: { by: string; since: string }) => {
    const parsed = StatsArgsSchema.safeParse({ by: options.by, since: options.since })
    if (!parsed.success) throw usageError(z.prettifyError(parsed.error))
    const by = parsed.data.by
    const rows = await runStats({ by, since: parsed.data.since })
    console.log(formatTable(by, rows))
  })

cli.command('query', 'Deprecated: use the OTel viewer UI').action(() => {
  const viewer =
    process.env.PI_ROUTE_VIEWER_URL ??
    `http://localhost:${process.env.PI_ROUTE_VIEWER_PORT ?? '8000'}`
  throw usageError(
    [
      'pi-route query is deprecated.',
      '',
      `Open the viewer UI: ${viewer}`,
      'Or run ad-hoc SQL against the viewer database:',
      '  duckdb ~/.cache/pi-route/otel.duckdb'
    ].join('\n')
  )
})

cli.help()
cli.version(pkg.version)

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const exitCodeFor = (err: unknown): number => {
  if (err instanceof ConfigError) return 3
  if (err instanceof Error && err.name === 'CACError') return 2 // cac's own + our usageError()
  return 1
}

try {
  const parsed = cli.parse(Bun.argv, { run: false })
  // help/version already printed by cac
  if (parsed.options.help || parsed.options.version) {
    process.exit(0)
  }
  if (!cli.matchedCommand) {
    if (parsed.args.length === 0) {
      cli.outputHelp()
      process.exit(0)
    }
    throw usageError(`unknown command: ${parsed.args[0]}`)
  }
  await cli.runMatchedCommand()
} catch (err) {
  process.stderr.write(`pi-route: ${errorMessage(err)}\n`)
  process.exit(exitCodeFor(err))
}

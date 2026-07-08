#!/usr/bin/env bun

// src/cli.ts

import { getOAuthProvider, type OAuthCredentials } from '@mariozechner/pi-ai/oauth'
import cac from 'cac'
import { z } from 'zod'

import { writeCredentials } from './auth/credentials'
import { deriveName } from './auth/name-derivers'
import { registerAllOAuthProviders } from './auth/register-all-oauth'
import { formatTable, runStats, type StatsBy } from './cli/stats'
import { type EnvPathOverrides, readEnvConfig } from './config/env'
import { ConfigError } from './config/errors'
import { loadConfig } from './config/loader'
import { collectLimitsSnapshot } from './limits'
import { buildCatalog } from './pipeline/catalog'
import { createState } from './state'
import { createTel } from './telemetry/tel'
import type { CredentialFile } from './types'

// cac throws CACError (err.name === 'CACError') for its own arg/option failures but
// does not export the class. Reuse the same shape for our usage errors so both map
// to exit 2 through one path — no bespoke error type.
const usageError = (message: string): never => {
  const err = new Error(message)
  err.name = 'CACError'
  throw err
}

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

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json()

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

cli.command('serve', 'Start the HTTP server').action(async () => {
  await import('./serve')
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

cli
  .command('stats', 'Query telemetry from the OTel viewer')
  .option('--by <dim>', 'Group by: provider|model|day|session', { default: 'provider' })
  .option('--since <range>', 'Time range, e.g. 7d or 12h', { default: '7d' })
  .action(async (options: { by: string; since: string }) => {
    const parsed = StatsArgsSchema.safeParse({ by: options.by, since: options.since })
    if (!parsed.success) throw usageError(z.prettifyError(parsed.error))
    const by = parsed.data.by as StatsBy
    const rows = await runStats({ by, since: parsed.data.since })
    console.log(formatTable(by, rows))
  })

cli.command('query', 'Deprecated: use the OTel viewer UI').action(() => {
  const viewer =
    process.env.PI_ROUTE_VIEWER_URL ??
    `http://localhost:${process.env.PI_ROUTE_VIEWER_PORT ?? '8000'}`
  usageError(
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
cli.version(pkg.version as string)

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err))

const exitCodeFor = (err: unknown): number => {
  if (err instanceof ConfigError) return 3
  if (err instanceof Error && err.name === 'CACError') return 2 // cac's own + our usageError()
  return 1
}

try {
  const parsed = cli.parse(Bun.argv, { run: false })
  if (parsed.options.help || parsed.options.version) {
    process.exit(0)
  }
  if (!cli.matchedCommand) {
    if (parsed.args.length === 0) {
      cli.outputHelp()
      process.exit(0)
    }
    usageError(`unknown command: ${parsed.args[0]}`)
  }
  await cli.runMatchedCommand()
} catch (err) {
  process.stderr.write(`pi-route: ${errorMessage(err)}\n`)
  process.exit(exitCodeFor(err))
}

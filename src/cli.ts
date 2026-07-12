#!/usr/bin/env bun

// src/cli.ts

import { getOAuthProvider, type OAuthCredentials } from '@mariozechner/pi-ai/oauth'
import cac from 'cac'
import { z } from 'zod'

import { refreshAndStore, writeCredentials } from './auth/credentials'
import { registerAllOAuthProviders } from './auth/register-all-oauth'
import { AGENTS } from './cli/agents'
import { listModelIds, renderPlannedWrites, setupModels, showModel } from './cli/models'
import { formatProviderList, removeCredential, upsertProviderBlock } from './cli/provider-config'
import { formatTable, runStats } from './cli/stats'
import { type EnvConfig, type EnvPathOverrides, readEnvConfig } from './config/env'
import { ConfigError } from './config/errors'
import { loadConfig } from './config/loader'
import { readRuntimeState } from './config/state'
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

cli.option(
  '-c, --config <path>',
  'Config file path (default: $XDG_CONFIG_HOME/pi-route/config.yaml)'
)
cli.option('--auth-dir <dir>', 'Auth/credentials directory')

type ProviderOpts = {
  config?: string
  authDir?: string
  url?: string
  key?: string
  keyEnv?: string
  type?: string
}

const providerAuth = async (
  env: EnvConfig,
  name: string,
  typeArg: string | undefined
): Promise<void> => {
  registerAllOAuthProviders()
  const oauthId = typeArg ?? name
  const provider = getOAuthProvider(oauthId)
  if (!provider) {
    throw usageError(
      `unknown OAuth provider type "${oauthId}" — pass one: pi-route provider ${name} auth <type>`
    )
  }
  const creds: OAuthCredentials = await provider.login({
    onAuth: ({ url }: { url: string }) => {
      console.error(`Open in browser: ${url}`)
      tryOpen(url)
    },
    onPrompt: async () => '',
    onProgress: (msg: string) => console.error(`… ${msg}`)
  })
  const credentialFile: CredentialFile = { ...creds, provider: oauthId }
  await writeCredentials(env.authDir, name, credentialFile)
  // OAuth ids map 1:1 to the config `type`, except antigravity (id google-antigravity).
  const configType = oauthId === 'google-antigravity' ? 'antigravity' : oauthId
  await upsertProviderBlock(env.configPath, name, { type: configType, account: name })
  console.log(`Logged in + registered provider "${name}" (${configType})`)
}

const providerSet = async (env: EnvConfig, name: string, opts: ProviderOpts): Promise<void> => {
  const type = opts.type ?? 'openai-compatible'
  if (type === 'openai-compatible' && !opts.url) {
    throw usageError('provider set: --url is required for openai-compatible providers')
  }
  // Literal --key wins; else write a $VAR reference (default $<NAME>_API_KEY).
  const apiKey = opts.key ?? `$${opts.keyEnv ?? `${name.toUpperCase()}_API_KEY`}`
  const block: Record<string, unknown> = {
    type,
    ...(opts.url ? { baseUrl: opts.url } : {}),
    apiKey
  }
  await upsertProviderBlock(env.configPath, name, block)
  console.log(`Registered provider "${name}" (${type})`)
}

const providerRefresh = async (env: EnvConfig, name: string): Promise<void> => {
  registerAllOAuthProviders()
  const { options, state: runtime } = await loadConfig(env.configPath, env.authDir)
  const state = createState(options, buildCatalog(options), runtime, env.authDir)
  await refreshAndStore(state, { credential: 'oauth' as const, name }, createTel())
  console.log(`Refreshed ${name}`)
}

const providerLogout = (env: EnvConfig, name: string): void => {
  const removed = removeCredential(env.authDir, name)
  console.log(removed ? `Removed credential ${name}` : `No credential file for ${name}`)
}

const printProviderList = async (env: EnvConfig): Promise<void> => {
  const { options } = await loadConfig(env.configPath, env.authDir)
  const runtime = await readRuntimeState(env.authDir)
  const invalid = new Set(
    Object.entries(runtime.accounts)
      .filter(([, v]) => v.isInvalid)
      .map(([k]) => k)
  )
  console.log(formatProviderList(options, invalid))
}

cli
  .command(
    'provider [...args]',
    'Manage providers: <name> auth [type] | <name> set --url … | list | <name> refresh | <name> logout'
  )
  .option('--url <url>', 'openai-compatible base URL (set)')
  .option('--key <key>', 'literal API key written to config (set)')
  .option('--key-env <name>', 'env var name, written as $NAME (set)')
  .option('--type <type>', 'provider type (set; default openai-compatible)')
  .action(async (args: string[], opts: ProviderOpts) => {
    const env = readEnvConfig(toOverrides(opts))
    if (args.length === 1 && args[0] === 'list') return void (await printProviderList(env))
    const [name, verb, typeArg] = args
    if (!name || !verb) {
      throw usageError(
        'usage: pi-route provider <name> <auth|set|refresh|logout>  |  pi-route provider list'
      )
    }
    switch (verb) {
      case 'auth':
        return void (await providerAuth(env, name, typeArg))
      case 'set':
        return void (await providerSet(env, name, opts))
      case 'refresh':
        return void (await providerRefresh(env, name))
      case 'logout':
        return void providerLogout(env, name)
      default:
        throw usageError(`unknown provider verb "${verb}" (expected auth|set|refresh|logout)`)
    }
  })

cli
  .command('serve', 'Start the HTTP server')
  .option('--watch', 'Reload config on file changes (also enabled by PI_ROUTE_WATCH=1)')
  .action(async (options: { config?: string; authDir?: string; watch?: boolean }) => {
    await import('./serve').then((m) =>
      m.startServer(toOverrides(options), { watch: options.watch === true })
    )
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

const agentNames = AGENTS.map((a) => a.name).join(', ')

cli
  .command('models [sub] [model]', `List / show / install models (install agents: ${agentNames})`)
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
        if (!model) {
          console.log(
            [
              'Available agents:',
              ...AGENTS.map((a) => `  ${a.name.padEnd(10)} ${a.description}`)
            ].join('\n')
          )
          return
        }
        if (!AGENTS.some((a) => a.name === model))
          throw usageError(`unknown models install agent: ${model}`)
        // Bake pi-route's own URL into client configs (clients don't uniformly
        // expand shell vars). The token is a secret — it stays in the client's
        // PI_ROUTE_API_KEY / ANTHROPIC_AUTH_TOKEN env var, never written to a file.
        const env = readEnvConfig(toOverrides(options))
        const host = env.host === '0.0.0.0' || env.host === '::' ? '127.0.0.1' : env.host
        const setupOpts: { dry: boolean; url: string; homeDir?: string } = {
          dry: Boolean(options.dry),
          url: `http://${host}:${env.port}`
        }
        if (options.homeDir) setupOpts.homeDir = options.homeDir
        const writes = await setupModels(routerOptions, model, setupOpts)
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

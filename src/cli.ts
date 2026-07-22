#!/usr/bin/env bun

// src/cli.ts

import type { ModelsRefreshOptions } from '@earendil-works/pi-ai'
import cac from 'cac'
import { z } from 'zod'

import { AGENTS } from './cli/agents'
import { generateCompletion } from './cli/completion'
import { usageError } from './cli/errors'
import { isTTY } from './cli/format'
import { stdinInteraction } from './cli/interaction'
import { findProviderSnapshot, formatLimits, formatLimitsDetail } from './cli/limits'
import {
  modelRows,
  renderModelDetail,
  renderModelList,
  renderPlannedWrites,
  setupModels,
  showModel
} from './cli/models'
import { formatProviderList, removeCredential, upsertProviderBlock } from './cli/provider-config'
import { formatTable, runStats } from './cli/stats'
import { dispatchVerb, type Verb } from './cli/verbs'
import { availableProviders } from './config/availability'
import { type EnvConfig, type EnvPathOverrides, readEnvConfig } from './config/env'
import { ConfigError, ConfigNotFoundError } from './config/errors'
import { loadConfig } from './config/loader'
import { credentialName } from './config/schema'
import { readRuntimeState } from './config/state'
import { collectLimitsSnapshot } from './limits'
import { buildModels } from './models/build'
import { buildCatalog, type ModelMeta } from './pipeline/catalog'
import { createState } from './state'
import type { Account, RouterOptions } from './types'

const toOverrides = (options: { config?: string; stateDir?: string }): EnvPathOverrides => {
  const overrides: EnvPathOverrides = {}
  if (options.config) overrides.configPath = options.config
  if (options.stateDir) overrides.stateDir = options.stateDir
  return overrides
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
  'Config file path (default: $XDG_CONFIG_HOME/pi-route.yml, or /etc/pi-route.yml as root)'
)
cli.option('--state-dir <dir>', 'Credentials/state directory')

type ProviderOpts = {
  config?: string
  stateDir?: string
  url?: string
  key?: string
  keyEnv?: string
  type?: string
  all?: boolean
  json?: boolean
}

// pi-ai ships OAuth flows for these; a bare `pi-route provider login anthropic`
// is only meaningful when the name IS one of them.
const OAUTH_TYPES = ['anthropic', 'openai-codex', 'antigravity']

// Resolution order: an explicit --type always wins; else the type already on
// record for this provider (so logging in again never clobbers it); else the
// provider name itself, but only when it is a known OAuth-capable type.
export const resolveLoginType = async (
  env: EnvConfig,
  name: string,
  explicit: string | undefined
): Promise<string> => {
  if (explicit) return explicit
  // Only "no config yet" falls through to name-based inference. A config that
  // exists but doesn't parse must surface here — otherwise the login below
  // would go on to write a provider block into a file nobody can load.
  const configured = await loadConfig(env.configPath, env.stateDir)
    .then((c) => c.options.providers[name]?.type)
    .catch((err) => {
      if (err instanceof ConfigNotFoundError) return undefined
      throw err
    })
  if (configured) return configured
  if (OAUTH_TYPES.includes(name)) return name
  throw usageError(`provider login ${name}: pass --type (one of: ${OAUTH_TYPES.join(', ')})`)
}

const providerLogin = async (
  env: EnvConfig,
  name: string,
  typeArg: string | undefined
): Promise<void> => {
  const configType = await resolveLoginType(env, name, typeArg)
  // Synthesize a one-provider config so the CredentialStore writes to the same
  // `<type>-<account>.json` file the loader resolves for a configured provider.
  const account: Account = { credential: 'oauth', name: credentialName(configType, name) }
  const options: RouterOptions = {
    providers: { [name]: { type: configType, account } },
    pipeline: [],
    expose: []
  }
  const models = buildModels(options, { stateDir: env.stateDir, authDir: env.stateDir })
  if (!models.getProvider(name)?.auth.oauth) {
    throw usageError(`provider type "${configType}" does not support OAuth login`)
  }
  await models.login(name, 'oauth', stdinInteraction())
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
  const { options } = await loadConfig(env.configPath, env.stateDir)
  const account = options.providers[name]?.account
  if (account?.credential !== 'oauth') {
    throw usageError(`provider "${name}" has no OAuth credential to refresh`)
  }
  const models = buildModels(options, { stateDir: env.stateDir, authDir: env.stateDir })
  const auth = await models.getAuth(name)
  if (!auth) throw usageError(`provider "${name}" is not authenticated`)
  console.log(`Refreshed ${name}`)
}

const providerLogout = async (env: EnvConfig, name: string): Promise<void> => {
  // The file is `<type>-<account>.json`; only the config knows the type, so resolve
  // the account's derived name (credentialName) rather than guessing from `name`.
  const { options } = await loadConfig(env.configPath, env.stateDir)
  const account = options.providers[name]?.account
  if (account?.credential !== 'oauth') {
    console.log(`No OAuth credential for ${name}`)
    return
  }
  const removed = removeCredential(env.stateDir, account.name)
  console.log(removed ? `Removed credential ${name}` : `No credential file for ${name}`)
}

const printProviderList = async (env: EnvConfig, all = false): Promise<void> => {
  const { options } = await loadConfig(env.configPath, env.stateDir)
  const runtime = await readRuntimeState(env.stateDir)
  const invalid = new Set(
    Object.entries(runtime.accounts)
      .filter(([, v]) => v.isInvalid)
      .map(([k]) => k)
  )
  const available = availableProviders(options, env.stateDir)
  const loggedOut = new Set(
    Object.entries(options.providers)
      .filter(([name, p]) => p.account.credential === 'oauth' && !available.has(name))
      .map(([name]) => name)
  )
  console.log(formatProviderList(options, { invalid, loggedOut, all }))
}

// A `name` filters `--json` down to that one provider, but keeps the
// `{ providers: [...] }` envelope — this snapshot shape is also served verbatim at
// `/v1/limits`, so the CLI and the HTTP endpoint must agree on what "the JSON" looks
// like regardless of how many providers are in it. Same lookup as the human view, so
// an unknown name fails the same way in both.
const printLimits = async (
  env: EnvConfig,
  name: string | undefined,
  json = false
): Promise<void> => {
  const { options, state: runtime } = await loadConfig(env.configPath, env.stateDir)
  const liveMeta = new Map<string, ModelMeta>()
  const models = buildModels(options, {
    stateDir: env.stateDir,
    authDir: env.stateDir,
    liveMeta
  })
  const catalog = buildCatalog(options, models, env.stateDir, liveMeta)
  const state = createState(options, catalog, models, runtime, env.stateDir)
  const snapshot = await collectLimitsSnapshot(state)
  if (json)
    console.log(
      JSON.stringify(
        name ? { providers: [findProviderSnapshot(snapshot, name)] } : snapshot,
        null,
        2
      )
    )
  else if (name) console.log(formatLimitsDetail(snapshot, name))
  else console.log(formatLimits(snapshot))
}

const PROVIDER_VERBS: Verb<ProviderOpts, EnvConfig>[] = [
  {
    name: 'list',
    description: 'List configured providers',
    flags: ['--all'],
    run: async (env, _arg, opts) => printProviderList(env, opts.all === true)
  },
  {
    name: 'limits',
    arg: '[name]',
    description: 'Show usage limits (one provider in detail)',
    flags: ['--json'],
    run: async (env, arg, opts) => printLimits(env, arg, opts.json)
  },
  {
    name: 'login',
    arg: '<name>',
    description: 'Log in via OAuth and register the provider',
    flags: ['--type'],
    run: async (env, arg, opts) => providerLogin(env, arg as string, opts.type)
  },
  {
    name: 'set',
    arg: '<name>',
    description: 'Register a key-based provider',
    flags: ['--url', '--key', '--key-env', '--type'],
    run: async (env, arg, opts) => providerSet(env, arg as string, opts)
  },
  {
    name: 'refresh',
    arg: '<name>',
    description: 'Refresh an OAuth credential now',
    flags: [],
    run: async (env, arg) => providerRefresh(env, arg as string)
  },
  {
    name: 'logout',
    arg: '<name>',
    description: 'Delete a stored credential',
    flags: [],
    run: async (env, arg) => providerLogout(env, arg as string)
  }
]

cli
  .command('provider [...args]', 'Manage providers (login, set, list, limits, refresh, logout)')
  .option('-u, --url <url>', 'openai-compatible base URL (set)')
  .option('-k, --key <key>', 'literal API key written to config (set)')
  .option('--key-env <name>', 'env var name, written as $NAME (set)')
  .option('-t, --type <type>', 'provider type (login, set)')
  .option('--all', 'Include disabled providers (list)')
  .option('--json', 'Print the raw JSON snapshot (limits)')
  .action(async (args: string[], opts: ProviderOpts) => {
    const env = readEnvConfig(toOverrides(opts))
    await dispatchVerb('provider', PROVIDER_VERBS, args, opts, env)
  })

cli
  .command('serve', 'Start the HTTP server')
  .option('--port <port>', 'Listen port (overrides PI_ROUTE_PORT)')
  .option('--host <host>', 'Listen host (overrides PI_ROUTE_HOST)')
  .option('--watch', 'Reload config on file changes (also enabled by PI_ROUTE_WATCH=1)')
  .action(
    async (options: {
      config?: string
      stateDir?: string
      port?: string
      host?: string
      watch?: boolean
    }) => {
      const overrides = toOverrides(options)
      if (options.port !== undefined) {
        const port = Number(options.port)
        if (!Number.isInteger(port))
          throw usageError(`--port must be an integer, got "${options.port}"`)
        overrides.port = port
      }
      if (options.host !== undefined) overrides.host = options.host
      await import('./serve').then((m) =>
        m.startServer(overrides, { watch: options.watch === true })
      )
    }
  )

const agentNames = AGENTS.map((a) => a.name).join(', ')

type ModelsOpts = {
  config?: string
  stateDir?: string
  homeDir?: string
  dry?: boolean
  json?: boolean
}

const loadModels = async (
  env: EnvConfig,
  refresh: ModelsRefreshOptions = { allowNetwork: false }
) => {
  const { options: routerOptions } = await loadConfig(env.configPath, env.stateDir)
  const liveMeta = new Map<string, ModelMeta>()
  const models = buildModels(routerOptions, {
    stateDir: env.stateDir,
    authDir: env.stateDir,
    liveMeta
  })
  await models.refresh(refresh)
  return { routerOptions, models, liveMeta }
}

// Defaults to an offline restore of the persisted overlays, which every
// listing/install path needs for accurate metadata. `liveMeta` is the same
// caller-owned sink app.ts uses: the catalog wrapper writes each provider's
// lossless parse into it during the restore, and the catalog built from these
// models must read it — otherwise a price the endpoint never stated shows as $0.
// The catalog is built here, once, so no downstream helper can forget the map.
const modelsAndOptions = async (
  env: EnvConfig,
  refresh: ModelsRefreshOptions = { allowNetwork: false }
) => {
  const { routerOptions, models, liveMeta } = await loadModels(env, refresh)
  return {
    routerOptions,
    models,
    catalog: buildCatalog(routerOptions, models, env.stateDir, liveMeta)
  }
}

const printModelsList = async (env: EnvConfig): Promise<void> => {
  const { routerOptions, models, catalog } = await modelsAndOptions(env)
  const rows = modelRows(routerOptions, catalog, models)
  if (rows.length > 0) console.log(renderModelList(rows, isTTY()))
}

const printModelShow = async (env: EnvConfig, id: string, json: boolean): Promise<void> => {
  const { routerOptions, models, catalog } = await modelsAndOptions(env)
  if (json) {
    console.log(JSON.stringify(showModel(routerOptions, catalog, models, id), null, 2))
  } else {
    console.log(renderModelDetail(routerOptions, catalog, models, id))
  }
}

const installModels = async (
  env: EnvConfig,
  agentName: string | undefined,
  opts: { homeDir?: string; dry?: boolean }
): Promise<void> => {
  const { routerOptions, models, catalog } = await modelsAndOptions(env)
  if (!agentName) {
    console.log(
      ['Available agents:', ...AGENTS.map((a) => `  ${a.name.padEnd(10)} ${a.description}`)].join(
        '\n'
      )
    )
    return
  }
  if (!AGENTS.some((a) => a.name === agentName))
    throw usageError(`unknown models install agent: ${agentName}`)
  // Bake pi-route's own URL into client configs (clients don't uniformly
  // expand shell vars). The token is a secret — it stays in the client's
  // PI_ROUTE_API_KEY / ANTHROPIC_AUTH_TOKEN env var, never written to a file.
  const host = env.host === '0.0.0.0' || env.host === '::' ? '127.0.0.1' : env.host
  const setupOpts: { dry: boolean; url: string; homeDir?: string } = {
    dry: Boolean(opts.dry),
    url: `http://${host}:${env.port}`
  }
  if (opts.homeDir) setupOpts.homeDir = opts.homeDir
  const writes = await setupModels(routerOptions, catalog, models, agentName, setupOpts)
  if (opts.dry) console.log(renderPlannedWrites(writes))
}

const refreshModels = async (env: EnvConfig): Promise<void> => {
  // Force a network fetch and persist; a running server picks the stores up at its
  // next 4h cycle or on restart. No catalog is built — this verb only counts models.
  const { routerOptions, models } = await loadModels(env, { force: true })
  for (const name of Object.keys(routerOptions.providers)) {
    console.log(`${name}: ${models.getModels(name).length}`)
  }
}

const MODELS_VERBS: Verb<ModelsOpts, EnvConfig>[] = [
  {
    name: 'list',
    description: 'List exposed models',
    flags: [],
    run: async (env) => printModelsList(env)
  },
  {
    name: 'show',
    arg: '<model>',
    description: 'Show a model detail block',
    flags: ['--json'],
    run: async (env, arg, opts) => printModelShow(env, arg as string, opts.json === true)
  },
  {
    name: 'install',
    arg: '[agent]',
    description: `Install agent configs (agents: ${agentNames})`,
    flags: ['--home-dir', '--dry'],
    run: async (env, arg, opts) =>
      installModels(env, arg, {
        ...(opts.homeDir ? { homeDir: opts.homeDir } : {}),
        ...(opts.dry !== undefined ? { dry: opts.dry } : {})
      })
  },
  {
    name: 'refresh',
    description: 'Force a network refresh of model metadata',
    flags: [],
    run: async (env) => refreshModels(env)
  }
]

cli
  .command(
    'models [...args]',
    `List / show / install / refresh models (install agents: ${agentNames})`
  )
  .option('--home-dir <dir>', 'Home directory for install (default: $HOME)')
  .option('--dry', 'Print planned writes without changing files')
  .option('--json', 'Print raw JSON (models show)')
  .action(async (args: string[], opts: ModelsOpts) => {
    const env = readEnvConfig(toOverrides(opts))
    await dispatchVerb('models', MODELS_VERBS, args.length > 0 ? args : ['list'], opts, env)
  })

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

cli
  .command('completion [shell]', 'Print a shell completion script (bash|zsh|fish)')
  .action((shell: string | undefined) => {
    if (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish') {
      throw usageError('usage: pi-route completion <bash|zsh|fish>')
    }
    console.log(
      generateCompletion(cli, shell, {
        provider: PROVIDER_VERBS.map((v) => v.name),
        models: MODELS_VERBS.map((v) => v.name)
      })
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

// Guarded so importing this module for its exports (e.g. resolveLoginType in
// tests) never triggers argv parsing or process.exit.
if (import.meta.main) {
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
}

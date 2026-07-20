#!/usr/bin/env bun

// src/cli.ts

import type { AuthEvent, AuthInteraction, AuthPrompt } from '@earendil-works/pi-ai'
import cac from 'cac'
import { z } from 'zod'

import { AGENTS } from './cli/agents'
import { generateCompletion } from './cli/completion'
import { isTTY } from './cli/format'
import { formatLimits } from './cli/limits'
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
import { type EnvConfig, type EnvPathOverrides, readEnvConfig } from './config/env'
import { ConfigError } from './config/errors'
import { loadConfig } from './config/loader'
import { credentialName } from './config/schema'
import { readRuntimeState } from './config/state'
import { collectLimitsSnapshot } from './limits'
import { buildModels } from './models/build'
import { buildCatalog } from './pipeline/catalog'
import { createState } from './state'
import type { Account, RouterOptions } from './types'

// cac tags its own arg/option errors with name 'CACError' (not exported). Reuse that
// name so self-raised usage errors share the exit-2 path — no bespoke error type.
const usageError = (message: string): Error =>
  Object.assign(new Error(message), { name: 'CACError' })

const toOverrides = (options: { config?: string; stateDir?: string }): EnvPathOverrides => {
  const overrides: EnvPathOverrides = {}
  if (options.config) overrides.configPath = options.config
  if (options.stateDir) overrides.stateDir = options.stateDir
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
  json?: boolean
}

// pi-ai login interaction over stdin/stdout: print auth URLs / progress, read a
// line for any prompt. Bun's global prompt() reads a single line synchronously.
const stdinInteraction = (): AuthInteraction => ({
  notify(event: AuthEvent): void {
    if (event.type === 'auth_url') {
      console.error(`Open in browser: ${event.url}`)
      if (event.instructions) console.error(event.instructions)
      tryOpen(event.url)
    } else if (event.type === 'device_code') {
      console.error(`Enter code ${event.userCode} at ${event.verificationUri}`)
    } else {
      console.error(`… ${event.message}`)
    }
  },
  async prompt(prompt: AuthPrompt): Promise<string> {
    return globalThis.prompt(prompt.message) ?? ''
  }
})

const providerAuth = async (
  env: EnvConfig,
  name: string,
  typeArg: string | undefined
): Promise<void> => {
  const configType = typeArg ?? name
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

const printProviderList = async (env: EnvConfig): Promise<void> => {
  const { options } = await loadConfig(env.configPath, env.stateDir)
  const runtime = await readRuntimeState(env.stateDir)
  const invalid = new Set(
    Object.entries(runtime.accounts)
      .filter(([, v]) => v.isInvalid)
      .map(([k]) => k)
  )
  console.log(formatProviderList(options, invalid))
}

const printLimits = async (env: EnvConfig, json = false): Promise<void> => {
  const { options, state: runtime } = await loadConfig(env.configPath, env.stateDir)
  const models = buildModels(options, { stateDir: env.stateDir, authDir: env.stateDir })
  const catalog = buildCatalog(options, models)
  const state = createState(options, catalog, models, runtime, env.stateDir)
  const snapshot = await collectLimitsSnapshot(state)
  if (json) console.log(JSON.stringify(snapshot, null, 2))
  else console.log(formatLimits(snapshot))
}

cli
  .command(
    'provider [...args]',
    'Manage providers: <name> auth [type] | <name> set --url … | list | limits | <name> refresh | <name> logout'
  )
  .option('--url <url>', 'openai-compatible base URL (set)')
  .option('--key <key>', 'literal API key written to config (set)')
  .option('--key-env <name>', 'env var name, written as $NAME (set)')
  .option('--type <type>', 'provider type (set; default openai-compatible)')
  .option('--json', 'Print the raw JSON snapshot instead of a table (limits)')
  .action(async (args: string[], opts: ProviderOpts) => {
    const env = readEnvConfig(toOverrides(opts))
    if (args.length === 1) {
      if (args[0] === 'list') return void (await printProviderList(env))
      if (args[0] === 'limits') return void (await printLimits(env, opts.json))
    }
    const [name, verb, typeArg] = args
    if (!name || !verb) {
      throw usageError(
        'usage: pi-route provider <name> <auth|set|refresh|logout>  |  pi-route provider <list|limits>'
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
        return void (await providerLogout(env, name))
      default:
        throw usageError(`unknown provider verb "${verb}" (expected auth|set|refresh|logout)`)
    }
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

const loadRouterOptions = async (options: { config?: string; stateDir?: string }) => {
  const env = readEnvConfig(toOverrides(options))
  const { options: routerOptions } = await loadConfig(env.configPath, env.stateDir)
  return routerOptions
}

const agentNames = AGENTS.map((a) => a.name).join(', ')

cli
  .command(
    'models [sub] [model]',
    `List / show / install / refresh models (install agents: ${agentNames})`
  )
  .option('--home-dir <dir>', 'Home directory for install (default: $HOME)')
  .option('--dry', 'Print planned writes without changing files')
  .option('--json', 'Print raw JSON (models show)')
  .action(
    async (
      sub: string | undefined,
      model: string | undefined,
      options: {
        config?: string
        stateDir?: string
        homeDir?: string
        dry?: boolean
        json?: boolean
      }
    ) => {
      const env = readEnvConfig(toOverrides(options))
      const routerOptions = await loadRouterOptions(options)
      const models = buildModels(routerOptions, { stateDir: env.stateDir, authDir: env.stateDir })
      if (sub === 'refresh') {
        // Force a network fetch and persist; a running server picks the stores up
        // at its next 4h cycle or on restart.
        await models.refresh({ force: true })
        for (const name of Object.keys(routerOptions.providers)) {
          console.log(`${name}: ${models.getModels(name).length}`)
        }
        return
      }
      await models.refresh({ allowNetwork: false }) // offline restore for accurate listings
      if (sub === 'show') {
        if (!model)
          throw usageError('models show requires a model id: pi-route models show <model>')
        if (options.json) {
          console.log(JSON.stringify(showModel(routerOptions, models, model), null, 2))
        } else {
          console.log(renderModelDetail(routerOptions, models, model))
        }
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
        const host = env.host === '0.0.0.0' || env.host === '::' ? '127.0.0.1' : env.host
        const setupOpts: { dry: boolean; url: string; homeDir?: string } = {
          dry: Boolean(options.dry),
          url: `http://${host}:${env.port}`
        }
        if (options.homeDir) setupOpts.homeDir = options.homeDir
        const writes = await setupModels(routerOptions, models, model, setupOpts)
        if (options.dry) console.log(renderPlannedWrites(writes))
        return
      }
      if (sub !== undefined && sub !== 'list') {
        throw usageError(
          `unknown models subcommand: "${sub}" (expected: list | show | install | refresh)`
        )
      }
      const rows = modelRows(routerOptions, models)
      if (rows.length > 0) console.log(renderModelList(rows, isTTY()))
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

cli
  .command('completion [shell]', 'Print a shell completion script (bash|zsh|fish)')
  .action((shell: string | undefined) => {
    if (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish') {
      throw usageError('usage: pi-route completion <bash|zsh|fish>')
    }
    console.log(generateCompletion(cli, shell))
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

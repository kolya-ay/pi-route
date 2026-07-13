import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'

const CLI = join(import.meta.dir, 'cli.ts')

const run = async (
  args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
  const proc = Bun.spawn(['bun', CLI, ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text()
  ])
  const exitCode = await proc.exited
  return { stdout, stderr, exitCode }
}

const tmp = (): string => mkdtempSync(join(tmpdir(), 'pi-route-'))

test('--help exits 0 and prints usage', async () => {
  const { stdout, exitCode } = await run(['--help'])
  expect(exitCode).toBe(0)
  expect(stdout).toContain('pi-route')
})

test('--version exits 0 and prints a version', async () => {
  const { stdout, exitCode } = await run(['--version'])
  expect(exitCode).toBe(0)
  expect(stdout).toMatch(/\d+\.\d+\.\d+/)
})

test('no command exits 0 and prints help', async () => {
  const { stdout, exitCode } = await run([])
  expect(exitCode).toBe(0)
  expect(stdout).toContain('pi-route')
})

test('unknown command exits 2', async () => {
  const { stderr, exitCode } = await run(['bogus'])
  expect(exitCode).toBe(2)
  expect(stderr).toContain('unknown command')
})

test('stats --by bogus exits 2 with a clear message', async () => {
  const { stderr, exitCode } = await run(['stats', '--by', 'bogus'])
  expect(exitCode).toBe(2)
  expect(stderr.toLowerCase()).toContain('by')
})

test('limits with a missing config exits 3', async () => {
  const dir = tmp()
  const { stderr, exitCode } = await run(['limits', '-c', join(dir, 'nope.yaml')])
  expect(exitCode).toBe(3)
  expect(stderr).toContain('Config file not found')
})

test('limits with malformed config exits 3', async () => {
  const dir = tmp()
  const path = join(dir, 'router.yaml')
  writeFileSync(path, 'providers: [unclosed')
  const { exitCode } = await run(['limits', '-c', path])
  expect(exitCode).toBe(3)
})

test('limits with a valid empty config exits 0 and prints JSON', async () => {
  const dir = tmp()
  const cfg = join(dir, 'router.yaml')
  writeFileSync(cfg, 'providers: {}\npipeline: {}\nexpose: []\n')
  const { stdout, exitCode } = await run(['limits', '-c', cfg, '--state-dir', join(dir, 'auth')])
  expect(exitCode).toBe(0)
  expect(() => JSON.parse(stdout)).not.toThrow()
})

const modelsConfig = (dir: string): string => {
  const cfg = join(dir, 'router.yaml')
  writeFileSync(
    cfg,
    `${[
      'providers:',
      '  cerebras:',
      '    type: cerebras',
      '    apiKey: x',
      'pipeline:',
      '  default:',
      '    match: exact',
      '    to: cerebras/llama3.1-8b',
      'expose:',
      '  - default'
    ].join('\n')}\n`
  )
  return cfg
}

test('models lists exposed model ids one per line', async () => {
  const dir = tmp()
  const cfg = modelsConfig(dir)
  const { stdout, exitCode } = await run(['models', '-c', cfg, '--state-dir', join(dir, 'auth')])
  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe('default')
})

test('models list matches models output', async () => {
  const dir = tmp()
  const cfg = modelsConfig(dir)
  const { stdout, exitCode } = await run([
    'models',
    'list',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth')
  ])
  expect(exitCode).toBe(0)
  expect(stdout.trim()).toBe('default')
})

test('models show prints JSON with id and projection keys', async () => {
  const dir = tmp()
  const cfg = modelsConfig(dir)
  const { stdout, exitCode } = await run([
    'models',
    'show',
    'default',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth')
  ])
  expect(exitCode).toBe(0)
  const parsed = JSON.parse(stdout) as Record<string, unknown>
  expect(parsed.id).toBe('default')
  expect(parsed).toHaveProperty('openai')
  expect(parsed).toHaveProperty('litellm')
  expect(parsed).toHaveProperty('modelsDev')
})

test('models show missing exits non-zero with a clear message', async () => {
  const dir = tmp()
  const cfg = modelsConfig(dir)
  const { stderr, exitCode } = await run([
    'models',
    'show',
    'nope',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth')
  ])
  expect(exitCode).not.toBe(0)
  expect(stderr).toContain('Model not exposed')
})

const setupConfig = (dir: string): string => {
  const cfg = join(dir, 'router.yaml')
  writeFileSync(
    cfg,
    `${[
      'providers:',
      '  cerebras:',
      '    type: cerebras',
      '    apiKey: x',
      'pipeline:',
      '  default:',
      '    match: exact',
      '    to:',
      '      - cerebras/llama3.1-8b',
      '      - cerebras/llama-3.3-70b',
      '  fast:',
      '    match: exact',
      '    to: cerebras/qwen-3-32b',
      'expose:',
      '  - default'
    ].join('\n')}\n`
  )
  return cfg
}

test('models install claude --dry prints a human table and writes nothing', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  const { stdout, exitCode } = await run([
    'models',
    'install',
    'claude',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home,
    '--dry'
  ])
  expect(exitCode).toBe(0)
  expect(() => JSON.parse(stdout)).toThrow() // not raw JSON anymore
  expect(stdout).toContain(join(home, '.claude', 'settings.json'))
  expect(stdout).toContain('create')
  expect(stdout).toContain('cerebras/llama3.1-8b')
  expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false)
  expect(stdout).toMatch(/\n {2}\+ /) // unified-diff addition lines
})

test('models install claude without pipeline.default fails', async () => {
  const dir = tmp()
  const cfg = join(dir, 'router.yaml')
  writeFileSync(
    cfg,
    `${[
      'providers:',
      '  cerebras:',
      '    type: cerebras',
      '    apiKey: x',
      'pipeline: {}',
      'expose: []'
    ].join('\n')}\n`
  )
  const { stderr, exitCode } = await run([
    'models',
    'install',
    'claude',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--dry'
  ])
  expect(exitCode).not.toBe(0)
  expect(stderr).toContain('default')
})

test('models install accepts a bare-list (non-exact) default pool', async () => {
  const dir = tmp()
  const cfg = join(dir, 'router.yaml')
  writeFileSync(
    cfg,
    `${[
      'providers:',
      '  cerebras:',
      '    type: cerebras',
      '    apiKey: x',
      'pipeline:',
      '  default:',
      '    - cerebras/llama3.1-8b',
      '    - cerebras/llama-3.3-70b',
      'expose:',
      '  - default'
    ].join('\n')}\n`
  )
  const { stdout, exitCode } = await run([
    'models',
    'install',
    'claude',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    join(dir, 'home'),
    '--dry'
  ])
  expect(exitCode).toBe(0)
  expect(stdout).toContain('cerebras/llama3.1-8b')
})

test('models install codex --dry writes config.toml + model_catalog_json', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  const { exitCode } = await run([
    'models',
    'install',
    'codex',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home,
    '--dry'
  ])
  expect(exitCode).toBe(0)
  // Read the files by re-running non-dry to assert structure precisely
  // (--dry output is human-readable after Task 9).
  await run([
    'models',
    'install',
    'codex',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  const toml = await Bun.file(join(home, '.codex', 'config.toml')).text()
  const catalogPath = join(home, '.codex', 'pi-route-catalog.json')
  expect(toml).toContain('model = "cerebras/llama3.1-8b"')
  expect(toml).toContain('[model_providers.piroute]')
  expect(toml).toContain('wire_api = "responses"')
  // Relative basename — codex resolves it against ~/.codex/, where we write the file.
  expect(toml).toContain('model_catalog_json = "pi-route-catalog.json"')
  expect(toml).toContain('env_key = "PI_ROUTE_API_KEY"')
  expect(toml).not.toContain('review_model')
  const catalog = JSON.parse(await Bun.file(catalogPath).text()) as {
    models: Array<{ slug: string }>
  }
  expect(catalog.models.map((e) => e.slug)).toEqual([
    'cerebras/llama3.1-8b',
    'cerebras/llama-3.3-70b',
    'cerebras/qwen-3-32b'
  ])
})

test('models install omp writes litellm discovery, all members, modelRoles.smol', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  await run([
    'models',
    'install',
    'omp',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  const modelsYml = await Bun.file(join(home, '.omp', 'agent', 'models.yml')).text()
  const models = Bun.YAML.parse(modelsYml) as {
    providers: {
      piroute: {
        discovery: { type: string }
        apiKey: string
        modelOverrides: Record<string, unknown>
      }
    }
  }
  expect(models.providers.piroute.discovery.type).toBe('litellm')
  // Token stays in env: apiKey is the env-var name, not a literal secret.
  expect(models.providers.piroute.apiKey).toBe('PI_ROUTE_API_KEY')
  expect(Object.keys(models.providers.piroute.modelOverrides)).toEqual([
    'cerebras/llama3.1-8b',
    'cerebras/llama-3.3-70b',
    'cerebras/qwen-3-32b'
  ])
  const configYml = await Bun.file(join(home, '.omp', 'agent', 'config.yml')).text()
  const config = Bun.YAML.parse(configYml) as {
    modelRoles: { default: string; smol: string; small?: string }
  }
  expect(config.modelRoles.default).toBe('piroute/cerebras/llama3.1-8b')
  expect(config.modelRoles.smol).toBe('piroute/cerebras/qwen-3-32b')
  expect(config.modelRoles.small).toBeUndefined()
})

test('models install pi writes modelOverrides for all members + defaultModel', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  await run([
    'models',
    'install',
    'pi',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  expect(existsSync(join(home, '.pi', 'agent', 'models.yml'))).toBe(false)
  const models = JSON.parse(await Bun.file(join(home, '.pi', 'agent', 'models.json')).text())
  expect(Object.keys(models.providers.piroute.modelOverrides)).toEqual([
    'cerebras/llama3.1-8b',
    'cerebras/llama-3.3-70b',
    'cerebras/qwen-3-32b'
  ])
  const settings = JSON.parse(await Bun.file(join(home, '.pi', 'agent', 'settings.json')).text())
  expect(settings.defaultModel).toBe('cerebras/llama3.1-8b')
  // Token stays in env: apiKey references ${PI_ROUTE_API_KEY}, no literal secret.
  expect(models.providers.piroute.apiKey).toBe('${PI_ROUTE_API_KEY}')
})

test('models install qwen writes all members as openai modelProviders array', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  await run([
    'models',
    'install',
    'qwen',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  const settings = JSON.parse(await Bun.file(join(home, '.qwen', 'settings.json')).text())
  expect(settings.providerProtocol.openai).toBe('openai')
  expect(settings.security.auth.selectedType).toBe('openai')
  expect(settings.modelProviders.openai.map((m: { id: string }) => m.id)).toEqual([
    'cerebras/llama3.1-8b',
    'cerebras/llama-3.3-70b',
    'cerebras/qwen-3-32b'
  ])
  expect(settings.model.name).toBe('cerebras/llama3.1-8b')
})

test('models install opencode writes provider models map + small_model', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  await run([
    'models',
    'install',
    'opencode',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  const oc = JSON.parse(await Bun.file(join(home, '.config', 'opencode', 'opencode.json')).text())
  expect(oc.model).toBe('pi-route/cerebras/llama3.1-8b')
  expect(oc.small_model).toBe('pi-route/cerebras/qwen-3-32b')
  expect(oc.provider['pi-route'].npm).toBe('@ai-sdk/openai-compatible')
  expect(Object.keys(oc.provider['pi-route'].models)).toEqual([
    'cerebras/llama3.1-8b',
    'cerebras/llama-3.3-70b',
    'cerebras/qwen-3-32b'
  ])
})

test('models install openclaw writes all members statically + wildcard', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  await run([
    'models',
    'install',
    'openclaw',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  const oc = JSON.parse(await Bun.file(join(home, '.openclaw', 'openclaw.json')).text())
  expect(oc.agents.defaults.models['piroute/*']).toBeDefined()
  expect(oc.agents.defaults.model.primary).toBe('piroute/cerebras/llama3.1-8b')
  // Token stays in env: apiKey references ${PI_ROUTE_API_KEY}, no literal secret.
  expect(oc.models.providers.piroute.apiKey).toBe('${PI_ROUTE_API_KEY}')
  expect(oc.models.providers.piroute.models.map((m: { id: string }) => m.id)).toEqual([
    'cerebras/llama3.1-8b',
    'cerebras/llama-3.3-70b',
    'cerebras/qwen-3-32b'
  ])
})

test('models install openclaw merges, preserving other providers and comments', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  const p = join(home, '.openclaw', 'openclaw.json')
  mkdirSync(join(home, '.openclaw'), { recursive: true })
  writeFileSync(
    p,
    `{
  // my openclaw config
  "models": { "mode": "merge", "providers": { "anthropic": { "api": "anthropic" } } },
  "agents": { "defaults": { "temperature": 0.7 } }
}
`
  )
  await run([
    'models',
    'install',
    'openclaw',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  const text = await Bun.file(p).text()
  expect(text).toContain('// my openclaw config') // JSONC comment survives the merge
  const parsed = parseJsonc(text)
  expect(parsed.models.providers.anthropic).toBeDefined() // foreign provider survives
  expect(parsed.models.providers.piroute).toBeDefined() // pi-route added
  expect(parsed.agents.defaults.temperature).toBe(0.7) // sibling key survives
  expect(parsed.agents.defaults.model.primary).toContain('piroute/')
})

test('models install unknown agent exits 2', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const { stderr, exitCode } = await run([
    'models',
    'install',
    'bogus',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--dry'
  ])
  expect(exitCode).toBe(2)
  expect(stderr.toLowerCase()).toContain('agent')
})

test('models install with no agent lists the available agents', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const { stdout, exitCode } = await run([
    'models',
    'install',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth')
  ])
  expect(exitCode).toBe(0)
  expect(stdout.toLowerCase()).toContain('available agents')
  // Anchor to the padded name column so 'pi' can't match inside 'pi-route'.
  for (const name of ['claude', 'codex', 'omp', 'opencode', 'openclaw', 'pi', 'qwen', 'zed']) {
    expect(stdout).toMatch(new RegExp(`\\n  ${name} `))
  }
})

test('models install dedups a model that is in both default and fast groups', async () => {
  const dir = tmp()
  const cfg = join(dir, 'router.yaml')
  writeFileSync(
    cfg,
    `${[
      'providers:',
      '  cerebras:',
      '    type: cerebras',
      '    apiKey: x',
      'pipeline:',
      '  default:',
      '    match: exact',
      '    to:',
      '      - cerebras/llama3.1-8b',
      '      - cerebras/shared-model',
      '  fast:',
      '    match: exact',
      '    to: cerebras/shared-model',
      'expose:',
      '  - default'
    ].join('\n')}\n`
  )
  const home = join(dir, 'home')
  await run([
    'models',
    'install',
    'claude',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  const settings = JSON.parse(await Bun.file(join(home, '.claude', 'settings.json')).text())
  // shared-model appears once, in first-occurrence order; fast slot still points at it
  expect(settings.availableModels).toEqual(['cerebras/llama3.1-8b', 'cerebras/shared-model'])
  expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('cerebras/shared-model')
})

test('models install claude (non-dry) writes availableModels + real main + haiku fast', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  await run([
    'models',
    'install',
    'claude',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  const settings = JSON.parse(await Bun.file(join(home, '.claude', 'settings.json')).text())
  expect(settings.model).toBe('cerebras/llama3.1-8b')
  expect(settings.availableModels).toEqual([
    'cerebras/llama3.1-8b',
    'cerebras/llama-3.3-70b',
    'cerebras/qwen-3-32b'
  ])
  expect(settings.env.ANTHROPIC_MODEL).toBe('cerebras/llama3.1-8b')
  expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('cerebras/qwen-3-32b')
  expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBeUndefined()
  expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBeUndefined()
  // Base URL is baked, but the token stays in the ambient ANTHROPIC_AUTH_TOKEN env var.
  expect(settings.env.ANTHROPIC_BASE_URL).toContain('http')
  expect(settings.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
})

test('models install claude merges into an existing settings.json, preserving comments and keys', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  const settingsPath = join(home, '.claude', 'settings.json')
  mkdirSync(join(home, '.claude'), { recursive: true })
  writeFileSync(
    settingsPath,
    `{
  // my hooks and perms
  "permissions": { "allow": ["Bash"] },
  "model": "old-model"
}
`
  )
  await run([
    'models',
    'install',
    'claude',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  const text = await Bun.file(settingsPath).text()
  expect(text).toContain('// my hooks and perms')
  expect(text).toContain('"permissions"')
  expect(text).toContain('"model": "cerebras/llama3.1-8b"')
  expect(text).toContain('"ANTHROPIC_BASE_URL"')
})

test('models install zed writes the pi-route provider, default_model, and edit predictions', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  await run([
    'models',
    'install',
    'zed',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  const settings = JSON.parse(await Bun.file(join(home, '.config', 'zed', 'settings.json')).text())
  const provider = settings.language_models.openai_compatible['pi-route']
  expect(provider.api_url).toContain('/v1')
  expect(provider.available_models.map((m: { name: string }) => m.name)).toEqual([
    'cerebras/llama3.1-8b',
    'cerebras/llama-3.3-70b',
    'cerebras/qwen-3-32b'
  ])
  // All four schema-required capability fields present (Zed warns "Missing property" otherwise).
  expect(provider.available_models[0].capabilities).toEqual({
    tools: true,
    images: false,
    parallel_tool_calls: false,
    prompt_cache_key: false
  })
  expect(settings.agent.default_model).toEqual({
    provider: 'pi-route',
    model: 'cerebras/llama3.1-8b',
    enable_thinking: false
  })
  expect(settings.edit_predictions.open_ai_compatible_api.model).toBe('cerebras/qwen-3-32b')
  expect(settings.edit_predictions.provider).toBe('open_ai_compatible_api')
  // The stale top-level `features` key is rejected by current Zed; never write it.
  expect(settings.features).toBeUndefined()
})

test('models install openclaw overwrites a legacy string agents.defaults.model', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  // Legacy shorthand: `model` is a string. The writer must replace it, not descend
  // into it (jsonc-parser throws "Can not add index to parent of type string").
  mkdirSync(join(home, '.openclaw'), { recursive: true })
  writeFileSync(
    join(home, '.openclaw', 'openclaw.json'),
    JSON.stringify({ agents: { defaults: { model: 'legacy/x' } } })
  )
  const { exitCode } = await run([
    'models',
    'install',
    'openclaw',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  expect(exitCode).toBe(0)
  const conf = parseJsonc(await Bun.file(join(home, '.openclaw', 'openclaw.json')).text())
  expect(conf.agents.defaults.model).toEqual({ primary: 'piroute/cerebras/llama3.1-8b' })
})

test('models install openclaw preserves sibling keys when model is an object', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  // Object form with a sibling the user set — must survive; only `primary` is ours.
  mkdirSync(join(home, '.openclaw'), { recursive: true })
  writeFileSync(
    join(home, '.openclaw', 'openclaw.json'),
    JSON.stringify({ agents: { defaults: { model: { primary: 'old/x', fallback: 'keep/me' } } } })
  )
  const { exitCode } = await run([
    'models',
    'install',
    'openclaw',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  expect(exitCode).toBe(0)
  const conf = parseJsonc(await Bun.file(join(home, '.openclaw', 'openclaw.json')).text())
  expect(conf.agents.defaults.model).toEqual({
    primary: 'piroute/cerebras/llama3.1-8b',
    fallback: 'keep/me'
  })
})

test('serve --port rejects a non-integer', async () => {
  const proc = Bun.spawn(['bun', CLI, 'serve', '--port', 'abc'], {
    stderr: 'pipe',
    env: { ...process.env, PI_ROUTE_CONFIG: '/nonexistent-on-purpose.yml' }
  })
  const err = await new Response(proc.stderr).text()
  await proc.exited
  expect(proc.exitCode).toBe(2)
  expect(err).toContain('--port must be an integer')
})

test('models install zed with no fast role omits edit_predictions and features', async () => {
  const dir = tmp()
  const cfg = modelsConfig(dir)
  const home = join(dir, 'home')
  await run([
    'models',
    'install',
    'zed',
    '-c',
    cfg,
    '--state-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  const settings = JSON.parse(await Bun.file(join(home, '.config', 'zed', 'settings.json')).text())
  expect(settings.language_models.openai_compatible['pi-route']).toBeDefined()
  expect(settings.edit_predictions).toBeUndefined()
  expect(settings.features).toBeUndefined()
})

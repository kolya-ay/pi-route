import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  const { stdout, exitCode } = await run(['limits', '-c', cfg, '--auth-dir', join(dir, 'auth')])
  expect(exitCode).toBe(0)
  expect(() => JSON.parse(stdout)).not.toThrow()
})

const modelsConfig = (dir: string): string => {
  const cfg = join(dir, 'router.yaml')
  writeFileSync(
    cfg,
    [
      'providers:',
      '  cerebras:',
      '    type: cerebras',
      '    account:',
      '      credential: key',
      '      key: x',
      'pipeline:',
      '  default:',
      '    match: exact',
      '    to: cerebras/llama3.1-8b',
      'expose:',
      '  - default'
    ].join('\n') + '\n'
  )
  return cfg
}

test('models lists exposed model ids one per line', async () => {
  const dir = tmp()
  const cfg = modelsConfig(dir)
  const { stdout, exitCode } = await run(['models', '-c', cfg, '--auth-dir', join(dir, 'auth')])
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
    '--auth-dir',
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
    '--auth-dir',
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
    '--auth-dir',
    join(dir, 'auth')
  ])
  expect(exitCode).not.toBe(0)
  expect(stderr).toContain('Model not exposed')
})

const setupConfig = (dir: string): string => {
  const cfg = join(dir, 'router.yaml')
  writeFileSync(
    cfg,
    [
      'providers:',
      '  cerebras:',
      '    type: cerebras',
      '    account:',
      '      credential: key',
      '      key: x',
      'pipeline:',
      '  default:',
      '    match: exact',
      '    to: cerebras/llama3.1-8b',
      '  small:',
      '    match: exact',
      '    to: cerebras/llama3.1-8b',
      'expose:',
      '  - default'
    ].join('\n') + '\n'
  )
  return cfg
}

test('models setup claude --dry prints planned writes and creates no files', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  const { stdout, exitCode } = await run([
    'models',
    'setup',
    'claude',
    '-c',
    cfg,
    '--auth-dir',
    join(dir, 'auth'),
    '--home-dir',
    home,
    '--dry'
  ])
  expect(exitCode).toBe(0)
  const writes = JSON.parse(stdout) as Array<{ path: string; action: string; content: string }>
  expect(writes.length).toBeGreaterThan(0)
  expect(writes[0]?.path).toBe(join(home, '.claude', 'settings.json'))
  const settings = JSON.parse(writes[0]!.content)
  expect(settings.model).toBe('sonnet')
  expect(settings.availableModels).toEqual(['sonnet', 'haiku'])
  expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('default')
  expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('small')
})

test('models setup claude --dry writes no files', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  await run([
    'models',
    'setup',
    'claude',
    '-c',
    cfg,
    '--auth-dir',
    join(dir, 'auth'),
    '--home-dir',
    home,
    '--dry'
  ])
  expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false)
})

test('models setup claude without pipeline.default fails', async () => {
  const dir = tmp()
  const cfg = join(dir, 'router.yaml')
  writeFileSync(
    cfg,
    [
      'providers:',
      '  cerebras:',
      '    type: cerebras',
      '    account:',
      '      credential: key',
      '      key: x',
      'pipeline: {}',
      'expose: []'
    ].join('\n') + '\n'
  )
  const { stderr, exitCode } = await run([
    'models',
    'setup',
    'claude',
    '-c',
    cfg,
    '--auth-dir',
    join(dir, 'auth'),
    '--dry'
  ])
  expect(exitCode).not.toBe(0)
  expect(stderr).toContain('default')
})

test('models setup codex --dry writes config.toml with provider block', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  const { stdout, exitCode } = await run([
    'models',
    'setup',
    'codex',
    '-c',
    cfg,
    '--auth-dir',
    join(dir, 'auth'),
    '--home-dir',
    home,
    '--dry'
  ])
  expect(exitCode).toBe(0)
  const writes = JSON.parse(stdout) as Array<{ path: string; content: string }>
  expect(writes[0]?.path).toBe(join(home, '.codex', 'config.toml'))
  expect(writes[0]!.content).toContain('model = "default"')
  expect(writes[0]!.content).toContain('[model_providers.piroute]')
  expect(writes[0]!.content).toContain('wire_api = "responses"')
  expect(writes[0]!.content).toContain('review_model = "small"')
})

test('models setup omp --dry writes discovery litellm and modelOverrides', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  const { stdout, exitCode } = await run([
    'models',
    'setup',
    'omp',
    '-c',
    cfg,
    '--auth-dir',
    join(dir, 'auth'),
    '--home-dir',
    home,
    '--dry'
  ])
  expect(exitCode).toBe(0)
  const writes = JSON.parse(stdout) as Array<{ path: string; content: string }>
  const modelsYml = writes.find((w) => w.path.endsWith('models.yml'))
  expect(modelsYml).toBeDefined()
  expect(modelsYml!.content).toContain('discovery:')
  expect(modelsYml!.content).toContain('type: litellm')
  expect(modelsYml!.content).toContain('modelOverrides:')
  const configYml = writes.find((w) => w.path.endsWith('config.yml'))
  expect(configYml).toBeDefined()
  expect(configYml!.content).toContain('modelRoles:')
  expect(configYml!.content).toContain('default:')
})

test('models setup pi --dry writes models.json not models.yml', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  const { stdout, exitCode } = await run([
    'models',
    'setup',
    'pi',
    '-c',
    cfg,
    '--auth-dir',
    join(dir, 'auth'),
    '--home-dir',
    home,
    '--dry'
  ])
  expect(exitCode).toBe(0)
  const writes = JSON.parse(stdout) as Array<{ path: string; content: string }>
  expect(writes.some((w) => w.path.endsWith('.pi/agent/models.json'))).toBe(true)
  expect(writes.some((w) => w.path.endsWith('.pi/agent/models.yml'))).toBe(false)
})

test('models setup qwen --dry writes openai modelProviders as array', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  const { stdout, exitCode } = await run([
    'models',
    'setup',
    'qwen',
    '-c',
    cfg,
    '--auth-dir',
    join(dir, 'auth'),
    '--home-dir',
    home,
    '--dry'
  ])
  expect(exitCode).toBe(0)
  const writes = JSON.parse(stdout) as Array<{ path: string; content: string }>
  const settings = JSON.parse(writes[0]!.content)
  expect(Array.isArray(settings.modelProviders.openai)).toBe(true)
  expect(settings.providerProtocol.openai).toBe('openai')
})

test('models setup opencode --dry writes static config without models fetch disable flag', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  const { stdout, exitCode } = await run([
    'models',
    'setup',
    'opencode',
    '-c',
    cfg,
    '--auth-dir',
    join(dir, 'auth'),
    '--home-dir',
    home,
    '--dry'
  ])
  expect(exitCode).toBe(0)
  const writes = JSON.parse(stdout) as Array<{ path: string; content: string }>
  const content = writes[0]!.content
  expect(content).toContain('pi-route/')
  expect(content).not.toContain('OPENCODE_DISABLE_MODELS_FETCH')
})

test('models setup openclaw --dry writes agents.defaults.models piroute wildcard', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  const { stdout, exitCode } = await run([
    'models',
    'setup',
    'openclaw',
    '-c',
    cfg,
    '--auth-dir',
    join(dir, 'auth'),
    '--home-dir',
    home,
    '--dry'
  ])
  expect(exitCode).toBe(0)
  const writes = JSON.parse(stdout) as Array<{ path: string; content: string }>
  const settings = JSON.parse(writes[0]!.content)
  expect(settings.agents.defaults.models['piroute/*']).toBeDefined()
})

test('models setup unknown engine exits 2', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const { stderr, exitCode } = await run([
    'models',
    'setup',
    'bogus',
    '-c',
    cfg,
    '--auth-dir',
    join(dir, 'auth'),
    '--dry'
  ])
  expect(exitCode).toBe(2)
  expect(stderr.toLowerCase()).toContain('engine')
})

test('models setup claude (non-dry) writes the settings file', async () => {
  const dir = tmp()
  const cfg = setupConfig(dir)
  const home = join(dir, 'home')
  await run([
    'models',
    'setup',
    'claude',
    '-c',
    cfg,
    '--auth-dir',
    join(dir, 'auth'),
    '--home-dir',
    home
  ])
  const settingsPath = join(home, '.claude', 'settings.json')
  expect(existsSync(settingsPath)).toBe(true)
  const settings = JSON.parse(await Bun.file(settingsPath).text())
  expect(settings.model).toBe('sonnet')
})

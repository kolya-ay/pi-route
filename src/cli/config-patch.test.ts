import { expect, test } from 'bun:test'
import { parse as parseToml } from 'smol-toml'
import { patchJson, patchToml, patchYaml } from './config-patch'

test('patchJson merges into a commented JSONC file, preserving comments and unrelated keys', () => {
  const existing = `{
  // user's own settings
  "permissions": { "allow": ["Bash"] },
  "model": "old-model"
}
`
  const out = patchJson(existing, [
    [['model'], 'new-model'],
    [['env', 'BASE_URL'], 'http://x/v1']
  ])
  expect(out).toContain("// user's own settings")
  expect(out).toContain('"permissions"')
  expect(out).toContain('"model": "new-model"')
  expect(out).toContain('"BASE_URL": "http://x/v1"')
})

test('patchJson creates a full document from empty input', () => {
  const out = patchJson('', [
    [['model'], 'm'],
    [['env', 'K'], 'v']
  ])
  const parsed = JSON.parse(out)
  expect(parsed).toEqual({ model: 'm', env: { K: 'v' } })
})

test('patchJson is idempotent on value replacement (byte-stable second pass)', () => {
  const first = patchJson('{ "model": "a" }\n', [[['model'], 'b']])
  const second = patchJson(first, [[['model'], 'b']])
  expect(second).toBe(first)
})

test('patchYaml merges into a commented YAML file, preserving comments and unrelated keys', () => {
  const existing = `# top of file
providers:
  other:            # keep me
    baseUrl: http://other
modelRoles:
  default: other/x
`
  const out = patchYaml(existing, [
    [['providers', 'piroute'], { baseUrl: 'http://pi/v1', api: 'openai-completions' }]
  ])
  expect(out).toContain('# top of file')
  expect(out).toContain('# keep me')
  expect(out).toContain('other:')
  expect(out).toContain('piroute:')
  expect(out).toContain('baseUrl: http://pi/v1')
})

test('patchYaml creates a block-style document from empty input', () => {
  const out = patchYaml('', [[['modelRoles', 'default'], 'piroute/x']])
  expect(out).toContain('modelRoles:')
  expect(out).toContain('default: piroute/x')
})

test('patchToml merges into an existing file, preserving other tables as data', () => {
  const existing = `model = "old"

[model_providers.other]
name = "other"
`
  const out = patchToml(existing, [
    [['model'], 'new'],
    [['model_providers', 'piroute'], { name: 'pi-route', wire_api: 'responses' }]
  ])
  const parsed = parseToml(out) as {
    model: string
    model_providers: { other?: unknown; piroute: { wire_api: string } }
  }
  expect(parsed.model).toBe('new')
  expect(parsed.model_providers.other).toBeDefined()
  expect(parsed.model_providers.piroute.wire_api).toBe('responses')
})

test('patchToml creates a document from empty input', () => {
  const out = patchToml('', [[['model'], 'm']])
  expect(parseToml(out)).toEqual({ model: 'm' })
})

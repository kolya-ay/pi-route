import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

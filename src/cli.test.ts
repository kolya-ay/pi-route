import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string | null = null

afterEach(async () => {
  if (dir) {
    await rm(dir, { recursive: true, force: true })
    dir = null
  }
})

describe('cli', () => {
  it('prints usage and exits 1 with no args', async () => {
    const proc = Bun.spawn(['bun', 'src/cli.ts'], {
      stderr: 'pipe',
      stdout: 'pipe'
    })
    const code = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(stderr).toContain('Usage:')
    expect(stderr).toContain('pi-route limits')
  })

  it('prints usage and exits 1 with unknown verb', async () => {
    const proc = Bun.spawn(['bun', 'src/cli.ts', 'foo', 'p1', 'a'], {
      stderr: 'pipe',
      stdout: 'pipe'
    })
    const code = await proc.exited
    const stderr = await new Response(proc.stderr).text()
    expect(code).toBe(1)
    expect(stderr).toContain('Usage:')
    expect(stderr).toContain('pi-route limits')
  })

  it('prints a limits snapshot as JSON and exits 0', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pi-route-cli-'))
    const configPath = join(dir, 'router.yaml')
    const authDir = join(dir, 'auth')
    await writeFile(
      configPath,
      `providers:\n  ignored:\n    type: openrouter\n    account:\n      credential: key\n      key: sk-test\n`
    )

    const env = { ...process.env }
    delete env.PI_ROUTE_CONFIG
    delete env.PI_ROUTE_AUTH

    const proc = Bun.spawn(
      ['bun', 'src/cli.ts', 'limits', '-c', configPath, '--auth-dir', authDir],
      {
        cwd: process.cwd(),
        env,
        stderr: 'pipe',
        stdout: 'pipe'
      }
    )
    const code = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({ providers: [] })
  })

  it('exits 1 when -c is missing a value', async () => {
    const proc = Bun.spawn(['bun', 'src/cli.ts', 'limits', '-c'], {
      cwd: process.cwd(),
      stderr: 'pipe',
      stdout: 'pipe'
    })
    const code = await proc.exited
    const stderr = await new Response(proc.stderr).text()

    expect(code).toBe(1)
    expect(stderr).toBe('Missing value for -c\n')
  })
})

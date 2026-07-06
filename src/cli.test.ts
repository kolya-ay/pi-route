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
    await writeFile(
      configPath,
      `providers:\n  ignored:\n    type: openrouter\n    account:\n      credential: key\n      key: sk-test\n`
    )

    const proc = Bun.spawn(['bun', 'src/cli.ts', 'limits'], {
      cwd: '/home/ay/.local/state/envrc/worktrees/ego/pi-router/limits-api',
      env: {
        ...process.env,
        PI_ROUTE_CONFIG: configPath,
        PI_ROUTE_AUTH: dir
      },
      stderr: 'pipe',
      stdout: 'pipe'
    })
    const code = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()

    expect(code).toBe(0)
    expect(stderr).toBe('')
    expect(JSON.parse(stdout)).toEqual({ providers: [] })
  })
})

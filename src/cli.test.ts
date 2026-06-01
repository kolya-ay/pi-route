import { describe, expect, it } from 'bun:test'

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
  })
})

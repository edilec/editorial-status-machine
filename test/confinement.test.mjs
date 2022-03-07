import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { isInside, resolveEventLog, resolveInput, runEditorialMachine } from '../src/index.mjs'
import { MACHINE, NOW, TO_PUBLISHED } from './support.mjs'

/**
 * Both halves of the path defect this catalog has shipped:
 *
 * - a symbolic link planted inside the root that resolves out of the tree must
 *   be refused, which lexical `../` checking never catches;
 * - a legitimate file reached through a *symlinked root* must be accepted,
 *   which comparing a realpath'd root against a merely-resolved target wrongly
 *   refuses. A false refusal is a bug too.
 */

async function sandbox(body) {
  // The temporary directory is realpath'd up front. Both sides of every
  // containment check are real paths -- that is the contract these functions
  // document -- and on a host whose temporary directory is itself a symlink
  // (macOS), handing them a raw path would test the wrong thing.
  const base = await realpath(await mkdtemp(join(tmpdir(), 'editorial-status-machine-paths-')))
  try {
    return await body(base)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

async function seed(root, { machineName = 'machine.json', commandsName = 'commands.json' } = {}) {
  await mkdir(root, { recursive: true })
  await writeFile(join(root, machineName), JSON.stringify(MACHINE), 'utf8')
  await writeFile(join(root, commandsName), JSON.stringify(TO_PUBLISHED), 'utf8')
}

test('isInside accepts the root itself and its descendants, and nothing else', () => {
  assert.equal(isInside('/a/b', '/a/b'), true)
  assert.equal(isInside('/a/b', '/a/b/c'), true)
  assert.equal(isInside('/a/b', '/a/bc'), false)
  assert.equal(isInside('/a/b', '/a'), false)
  assert.equal(isInside('/a/b', '/c'), false)
  assert.equal(isInside('/', '/a'), true)
})

test('a symlink inside the root that points outside it is refused unread', async () => {
  await sandbox(async (base) => {
    const root = join(base, 'root')
    const outside = join(base, 'outside')
    await seed(root)
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'secret.json'), JSON.stringify([]), 'utf8')
    await symlink(join(outside, 'secret.json'), join(root, 'escape.json'))

    await assert.rejects(
      resolveInput(root, 'escape.json', '--commands'),
      /resolves outside the input root/,
    )
    await assert.rejects(
      runEditorialMachine({ root, machine: 'machine.json', commands: 'escape.json', now: NOW }),
      /resolves outside the input root/,
    )
  })
})

test('a lexical traversal is refused too, but it is not what confinement rests on', async () => {
  await sandbox(async (base) => {
    const root = join(base, 'root')
    await seed(root)
    await writeFile(join(base, 'elsewhere.json'), JSON.stringify([]), 'utf8')
    await assert.rejects(resolveInput(root, '../elsewhere.json', '--commands'), /outside the input root/)
  })
})

test('a legitimate file reached through a symlinked root is accepted', async () => {
  await sandbox(async (base) => {
    const real = join(base, 'real-root')
    const link = join(base, 'linked-root')
    await seed(real)
    await symlink(real, link)

    // The root is a symlink; the files under it are entirely ordinary. Refusing
    // these would be the over-correction, and it is just as wrong.
    const rootReal = await realpath(link)
    const resolved = await resolveInput(rootReal, 'commands.json', '--commands')
    assert.equal(resolved.relative, 'commands.json')

    const { report } = await runEditorialMachine({
      root: link, machine: 'machine.json', commands: 'commands.json', now: NOW,
    })
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.applied, 3)
  })
})

test('a file inside a symlinked subdirectory of the root is accepted', async () => {
  await sandbox(async (base) => {
    const root = join(base, 'root')
    const inner = join(root, 'inner')
    await seed(root)
    await mkdir(inner, { recursive: true })
    await writeFile(join(inner, 'commands.json'), JSON.stringify(TO_PUBLISHED), 'utf8')
    await symlink(inner, join(root, 'link-to-inner'))

    const resolved = await resolveInput(root, 'link-to-inner/commands.json', '--commands')
    assert.equal(resolved.relative, 'inner/commands.json')
    const { report } = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'link-to-inner/commands.json', now: NOW,
    })
    assert.equal(report.status, 'pass')
  })
})

test('a finding never carries an absolute host path', async () => {
  await sandbox(async (base) => {
    const root = join(base, 'root')
    await seed(root)
    await writeFile(join(root, 'commands.json'), '[]', 'utf8')
    const { report } = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW,
    })
    assert.ok(report.findings.length > 0)
    for (const finding of report.findings) {
      assert.equal(finding.location.file.startsWith('/'), false, finding.location.file)
      assert.equal(finding.location.file.includes(base), false)
      assert.equal(JSON.stringify(finding).includes(base), false)
    }
  })
})

test('the event log is refused when it resolves inside the read-only input root', async () => {
  await sandbox(async (base) => {
    const root = join(base, 'root')
    await seed(root)
    await assert.rejects(resolveEventLog(root, join(root, 'events.jsonl')), /inside the input root/)
    await assert.rejects(
      runEditorialMachine({
        root, machine: 'machine.json', commands: 'commands.json', now: NOW,
        events: join(root, 'events.jsonl'),
      }),
      /inside the input root/,
    )
    // And outside it is fine.
    const outside = await resolveEventLog(root, join(base, 'events.jsonl'))
    assert.equal(outside, join(base, 'events.jsonl'))
  })
})

test('a symlinked parent cannot put the log back inside the root', async () => {
  await sandbox(async (base) => {
    const root = join(base, 'root')
    await seed(root)
    await mkdir(join(root, 'logs'), { recursive: true })
    await symlink(join(root, 'logs'), join(base, 'logs-link'))

    // Lexically `<base>/logs-link/events.jsonl` is outside the root. It is not.
    await assert.rejects(
      resolveEventLog(root, join(base, 'logs-link', 'events.jsonl')),
      /inside the input root/,
    )
  })
})

test('the log destination must be a file, and must have somewhere to live', async () => {
  await sandbox(async (base) => {
    const root = join(base, 'root')
    await seed(root)
    await mkdir(join(base, 'dir'), { recursive: true })
    await assert.rejects(resolveEventLog(root, join(base, 'dir')), /is a directory/)
    await assert.rejects(resolveEventLog(root, ''), /non-empty path/)
    await assert.rejects(resolveEventLog(root, '   '), /non-empty path/)
  })
})

test('a missing input is a configuration error, with nothing to report about', async () => {
  await sandbox(async (base) => {
    const root = join(base, 'root')
    await seed(root)
    await assert.rejects(
      runEditorialMachine({ root, machine: 'absent.json', commands: 'commands.json', now: NOW }),
      /--machine could not be resolved: ENOENT/,
    )
    await assert.rejects(
      runEditorialMachine({ root: join(base, 'absent'), machine: 'm.json', commands: 'c.json', now: NOW }),
      /Input root could not be read: ENOENT/,
    )
    await assert.rejects(
      runEditorialMachine({
        root: join(root, 'machine.json'), machine: 'm.json', commands: 'c.json', now: NOW,
      }),
      /Input root must be a directory/,
    )
  })
})

/**
 * The event log is the one path this tool writes to, and three separate things
 * can make it a different file from the one the caller named. Each hole gets a
 * case here, driven through the real binary, plus the destinations that must
 * keep working -- a guard that refuses everything passes every data-loss case
 * while making --events useless.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { link, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { CLI, NOW, TO_PUBLISHED, command, projectDirectory, workspace } from './support.mjs'

const run = promisify(execFile)

async function cli(args, cwd = projectDirectory) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

function args(root, events) {
  return [
    '--root', root,
    '--machine', 'machine.json',
    '--commands', 'commands.json',
    '--now', NOW,
    '--events', events,
  ]
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

test('a symbolic link at the destination is refused, and what it points at is untouched', async () => {
  await workspace(async ({ base, root }) => {
    const bystander = join(base, 'bystander.jsonl')
    await writeFile(bystander, '', 'utf8')
    await mkdir(join(base, 'logs'))
    await symlink(bystander, join(base, 'logs', 'events.jsonl'))

    const result = await cli(args(root, join(base, 'logs', 'events.jsonl')))
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '', 'a refused destination is a configuration error, with nothing to report')
    assert.match(result.stderr, /--events is a symbolic link/)
    assert.equal(await readFile(bystander, 'utf8'), '', 'not one byte through the link')
  }, { commands: TO_PUBLISHED })
})

test('a symbolic link at the destination pointing nowhere yet creates no file', async () => {
  await workspace(async ({ base, root }) => {
    await mkdir(join(base, 'logs'))
    await mkdir(join(base, 'outside'))
    await symlink(join(base, 'outside', 'not-yet.jsonl'), join(base, 'logs', 'events.jsonl'))

    const result = await cli(args(root, join(base, 'logs', 'events.jsonl')))
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--events is a symbolic link/)
    assert.deepEqual(await readdir(join(base, 'outside')), [], 'a link with no target creates the file it points at')
  }, { commands: TO_PUBLISHED })
})

test('a symlinked parent directory cannot carry the log into the read-only root', async () => {
  await workspace(async ({ base, root }) => {
    await mkdir(join(root, 'logs'))
    await symlink(join(root, 'logs'), join(base, 'logs-link'))

    // Lexically `<base>/logs-link/events.jsonl` is outside the root. It is not.
    const result = await cli(args(root, join(base, 'logs-link', 'events.jsonl')))
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /inside the input root/)
    assert.deepEqual(await readdir(join(root, 'logs')), [], 'nothing was written into the read-only root')
  }, { commands: TO_PUBLISHED })
})

test('a hard link to an input is refused: one device and inode is one file, whatever it is called', async () => {
  await workspace(async ({ base, root }) => {
    const input = join(root, 'commands.json')
    const before = await readFile(input, 'utf8')
    await link(input, join(base, 'events.jsonl'))

    const result = await cli(args(root, join(base, 'events.jsonl')))
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--events is the same file as an input/)
    assert.equal(await readFile(input, 'utf8'), before, 'the batch it was reading is byte for byte what it was')
  }, { commands: TO_PUBLISHED })
})

test('the destinations the log is for still work: a new file, a new directory, and a second append', async () => {
  await workspace(async ({ base, root, log }) => {
    const first = await cli(args(root, log))
    assert.equal(first.code, 0)
    assert.match(first.stderr, /appended 3 event\(s\) after 0 existing one\(s\)/)
    const afterFirst = await readFile(log, 'utf8')
    assert.equal(afterFirst.trimEnd().split('\n').length, 3)

    // A directory that does not exist yet is created for the log.
    const nested = join(base, 'deep', 'nested', 'events.jsonl')
    assert.equal(await exists(join(base, 'deep')), false)
    const made = await cli(args(root, nested))
    assert.equal(made.code, 0)
    assert.equal(await readFile(nested, 'utf8'), afterFirst)

    // And the tool appends onto its own previous output: the three commands
    // already in the log are recognised as retries, and only the new one is
    // added.
    await writeFile(
      join(root, 'commands.json'),
      `${JSON.stringify([...TO_PUBLISHED, command({
        commandId: 'c-retire', action: 'retire', actor: 'eve', at: '2026-03-04T09:00:00Z', expectedRevision: 3,
      })], null, 2)}\n`,
      'utf8',
    )
    const second = await cli(args(root, log))
    assert.equal(second.code, 0)
    assert.match(second.stderr, /appended 1 event\(s\) after 3 existing one\(s\)/)
    const afterSecond = await readFile(log, 'utf8')
    assert.ok(afterSecond.startsWith(afterFirst), 'the existing lines were not rewritten')
    assert.equal(afterSecond.trimEnd().split('\n').length, 4)
  }, { commands: TO_PUBLISHED })
})

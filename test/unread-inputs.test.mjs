import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { eventLines, runEditorialMachine } from '../src/index.mjs'
import { CLI, NOW, command, projectDirectory, workspace } from './support.mjs'

const run = promisify(execFile)

/**
 * A file that did not become text must stay unread -- not become empty text.
 *
 * `readText` answers `null` for every way a file can fail to be read, and the
 * caller turns that into `logTrusted = false`. Substituting `''` for any one of
 * those sentinels is the defect this file exists to kill: an event log that was
 * never read would then replay as an EMPTY log, the batch would be decided
 * against a blank projection, and commands already in that log would be applied
 * a second time and appended to the very file the run refused to read. The
 * headline guarantee -- a repeated command id appends no second event -- would
 * be broken by a bounded-out or unreadable log rather than by anything a caller
 * did wrong.
 *
 * So these tests never inspect the sentinel. They drive a real log through the
 * real entry point and the real binary, and assert what a reader can see: the
 * status, the exit code, the counts, and the bytes of the log afterwards.
 */

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

/** Ten commands, each opening a different document, so the log is comfortably the largest input. */
const TEN = Object.freeze(Array.from({ length: 10 }, (unused, index) => command({
  commandId: `seed-${index}`, document: `doc-${index}`,
})))

function rules(report) {
  return report.findings.map((item) => item.ruleId)
}

/** Seed a real log by running the tool and appending what it decided, as the CLI does. */
async function seedLog(root, log) {
  const first = await runEditorialMachine({
    root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
  })
  assert.equal(first.report.summary.applied, TEN.length)
  await appendFile(log, eventLines(first.newEvents), 'utf8')
  return readFile(log, 'utf8')
}

test('a log bounded out by maxFileBytes is unread evidence, not an empty log', async () => {
  await workspace(async ({ root, log }) => {
    const seeded = await seedLog(root, log)
    assert.equal(seeded.trimEnd().split('\n').length, 10)

    // Every other input must fit under the bound, so the log is the only file
    // the limit touches.
    const logBytes = (await stat(log)).size
    for (const name of ['machine.json', 'commands.json']) {
      assert.ok((await stat(join(root, name))).size < logBytes, `${name} must be smaller than the log`)
    }
    const limits = { maxFileBytes: logBytes - 1 }

    const result = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log, limits,
    })
    assert.equal(result.report.status, 'incomplete')
    assert.equal(result.report.summary.checked, 0, 'nothing may be decided against a log that was not read')
    assert.equal(result.report.summary.applied, 0)
    assert.equal(result.newEvents.length, 0)
    assert.equal(result.appendable, false)
    assert.deepEqual(rules(result.report).sort(), ['commands-not-evaluated', 'input-too-large'])

    const viaCli = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--now', NOW, '--events', log, '--json', '--max-file-bytes', String(logBytes - 1),
    ])
    assert.equal(viaCli.code, 2)
    assert.equal(JSON.parse(viaCli.stdout).status, 'incomplete')
    assert.equal(await readFile(log, 'utf8'), seeded, 'a log the run refused to read must not grow')
  }, { commands: TEN })
})

test('a log that cannot be read is unread evidence, not an empty log', async (t) => {
  await workspace(async ({ root, log }) => {
    const seeded = await seedLog(root, log)
    await chmod(log, 0o000)
    try {
      await readFile(log, 'utf8')
      t.skip('this process can read a mode-000 file, so the unreadable branch cannot be reached')
      return
    } catch {
      // The branch is reachable here: carry on.
    }

    const result = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
    })
    assert.equal(result.report.status, 'incomplete')
    assert.equal(result.report.summary.checked, 0)
    assert.equal(result.report.summary.applied, 0)
    assert.equal(result.newEvents.length, 0)
    assert.equal(result.appendable, false)
    assert.deepEqual(rules(result.report).sort(), ['commands-not-evaluated', 'input-unreadable'])

    const viaCli = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--now', NOW, '--events', log, '--json',
    ])
    assert.equal(viaCli.code, 2)
    assert.equal(JSON.parse(viaCli.stdout).status, 'incomplete')

    await chmod(log, 0o600)
    assert.equal(await readFile(log, 'utf8'), seeded, 'a log the run could not read must not grow')
  }, { commands: TEN })
})

test('the duplicate-command guarantee survives a log the run could not read', async () => {
  // The same batch, twice, with the log bounded out on the second run. Under a
  // sentinel that returned empty text instead of "unread", the second run would
  // re-apply all ten commands and append them a second time, so the log would
  // hold each command id twice -- the exact failure the idempotency guarantee
  // rules out.
  await workspace(async ({ root, log }) => {
    await seedLog(root, log)
    const logBytes = (await stat(log)).size

    const bounded = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--now', NOW, '--events', log, '--json', '--max-file-bytes', String(logBytes - 1),
    ])
    assert.equal(bounded.code, 2)

    const ids = (await readFile(log, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line).commandId)
    assert.equal(ids.length, 10)
    assert.equal(new Set(ids).size, ids.length, 'a command id was recorded twice')
  }, { commands: TEN })
})

test('a directory named as an input is reported unreadable, never read as empty text', async () => {
  await workspace(async ({ root, log }) => {
    await mkdir(join(root, 'not-a-file'), { recursive: true })
    await writeFile(join(root, 'not-a-file', 'keep.txt'), 'x', 'utf8')
    const { report } = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'not-a-file', now: NOW, events: log,
    })
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(rules(report).sort(), ['commands-not-evaluated', 'input-unreadable'])
    assert.equal(rules(report).includes('input-not-json'), false, 'a directory is unreadable, not empty JSON')
  }, { commands: TEN })
})

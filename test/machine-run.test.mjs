import assert from 'node:assert/strict'
import { appendFile, readFile } from 'node:fs/promises'
import test from 'node:test'

import { eventLines, runEditorialMachine } from '../src/index.mjs'
import { MACHINE, NOW, TO_PUBLISHED, command, workspace } from './support.mjs'

/** Run against a temporary workspace, appending the accepted events as the CLI would. */
async function run(commands, { machine = MACHINE, log = true, now = NOW, limits = {} } = {}) {
  return workspace(async ({ root, log: logPath }) => {
    const result = await runEditorialMachine({
      root,
      machine: 'machine.json',
      commands: 'commands.json',
      now,
      limits,
      ...(log ? { events: logPath } : {}),
    })
    return { ...result, logPath }
  }, { machine, commands })
}

function rules(report) {
  return report.findings.map((item) => item.ruleId)
}

test('a batch that walks the lifecycle passes and produces one event per command', async () => {
  const { report, newEvents, appendable } = await run(TO_PUBLISHED)
  assert.equal(report.status, 'pass')
  assert.deepEqual(rules(report), [])
  assert.equal(report.summary.checked, 3)
  assert.equal(report.summary.applied, 3)
  assert.equal(report.summary.rejected, 0)
  assert.equal(appendable, true)
  assert.deepEqual(newEvents.map((event) => event.to), ['review', 'approved', 'published'])
  assert.deepEqual(newEvents.map((event) => event.revision), [1, 2, 3])
})

test('the projected document is the one the events describe', async () => {
  const { documents } = await run(TO_PUBLISHED)
  assert.deepEqual(documents, [
    { document: 'post', state: 'published', revision: 3, scheduledFor: null, lastAt: '2026-03-03T09:00:00.000Z' },
  ])
})

test('replaying a command id inside one batch publishes once', async () => {
  const { report, newEvents } = await run([...TO_PUBLISHED, TO_PUBLISHED[2]])
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.applied, 3)
  assert.equal(report.summary.replayed, 1)
  assert.equal(newEvents.filter((event) => event.action === 'publish').length, 1)
  assert.deepEqual(rules(report), ['command-replayed'])
})

test('replaying a command id across two runs publishes once and appends nothing', async () => {
  await workspace(async ({ root, log }) => {
    const options = { root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log }

    const first = await runEditorialMachine(options)
    assert.equal(first.report.summary.applied, 3)
    await appendFile(log, eventLines(first.newEvents), 'utf8')
    const afterFirst = await readFile(log, 'utf8')

    const second = await runEditorialMachine(options)
    assert.equal(second.report.status, 'pass')
    assert.equal(second.report.summary.applied, 0)
    assert.equal(second.report.summary.replayed, 3)
    assert.equal(second.newEvents.length, 0)
    assert.equal(eventLines(second.newEvents), '')

    await appendFile(log, eventLines(second.newEvents), 'utf8')
    assert.equal(await readFile(log, 'utf8'), afterFirst, 'the log must be byte-identical after a replay')

    // The property in its plainest form.
    const published = afterFirst.trimEnd().split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.document === 'post' && event.to === 'published')
    assert.equal(published.length, 1)
    assert.equal(second.documents[0].revision, 3, 'a replay must not advance the revision')
  }, { commands: TO_PUBLISHED })
})

test('a retry is recognised even though its expectedRevision is long superseded', async () => {
  // This is the whole reason idempotency is settled before evaluation: by the
  // time the retry arrives the document is at revision 3, so re-evaluating it
  // would answer "stale" to a client that is behaving correctly.
  const { report } = await run([...TO_PUBLISHED, TO_PUBLISHED[0]])
  assert.deepEqual(rules(report), ['command-replayed'])
  assert.equal(rules(report).includes('transition-stale'), false)
  assert.equal(report.status, 'pass')
})

test('a note is prose, not part of a command\u2019s identity', async () => {
  const reworded = { ...TO_PUBLISHED[2], note: 'resending after a timeout' }
  const { report, newEvents } = await run([...TO_PUBLISHED, reworded])
  assert.equal(report.status, 'pass')
  assert.deepEqual(rules(report), ['command-replayed'])
  assert.equal(newEvents.length, 3)
})

test('a refused command id is decided again, not treated as applied', async () => {
  const refused = command({ commandId: 'c-x', actor: 'dana' })
  const { report, newEvents } = await run([refused, refused])
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['transition-unauthorized', 'transition-unauthorized'])
  assert.equal(report.summary.rejected, 2)
  assert.equal(report.summary.replayed, 0)
  assert.equal(newEvents.length, 0)
})

test('a used command id carrying different instructions is refused, not swallowed', async () => {
  const forged = { ...TO_PUBLISHED[2], actor: 'eve' }
  const { report, newEvents } = await run([...TO_PUBLISHED, forged])
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['command-replay-mismatch'])
  assert.equal(newEvents.length, 3)
})

test('an unauthorized command fails the run and appends no event', async () => {
  const { report, newEvents } = await run([command({ commandId: 'c-1', actor: 'dana' })])
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['transition-unauthorized'])
  assert.equal(report.summary.rejected, 1)
  assert.equal(report.summary.applied, 0)
  assert.equal(newEvents.length, 0)
})

test('a stale command fails the run and appends no event for itself', async () => {
  const { report, newEvents } = await run([
    command({ commandId: 'c-1' }),
    command({ commandId: 'c-2', action: 'approve', actor: 'bob', at: '2026-03-02T09:00:00Z', expectedRevision: 0 }),
  ])
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['transition-stale'])
  assert.equal(newEvents.length, 1)
  assert.equal(newEvents[0].action, 'submit')
})

test('a command that would skip a state fails the run', async () => {
  const { report, newEvents } = await run([
    command({ commandId: 'c-1', action: 'publish', actor: 'dana' }),
  ])
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['transition-invalid'])
  assert.equal(newEvents.length, 0)
})

test('decisions record what happened to every command, in batch order', async () => {
  const { decisions, report } = await run([
    ...TO_PUBLISHED,
    TO_PUBLISHED[2],
    command({ commandId: 'c-bad', document: 'post', action: 'retire', actor: 'alice', at: '2026-03-04T09:00:00Z', expectedRevision: 3 }),
  ])
  assert.deepEqual(decisions.map((item) => item.index), [0, 1, 2, 3, 4])
  assert.deepEqual(decisions.map((item) => item.outcome), ['applied', 'applied', 'applied', 'replayed', 'rejected'])
  assert.deepEqual(decisions.map((item) => item.ruleId), [null, null, null, 'command-replayed', 'transition-unauthorized'])
  assert.equal(decisions.length, report.summary.checked)
})

test('a bounded-out batch still reports how many commands the file held', async () => {
  const { report } = await run(TO_PUBLISHED, { limits: { maxCommands: 2 } })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.commands, 3, 'the count must not read as an empty batch')
  assert.equal(report.summary.checked, 0)
})

test('a run over a prior log continues from the state the log leaves behind', async () => {
  await workspace(async ({ root, log }) => {
    const first = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
    })
    await appendFile(log, eventLines(first.newEvents), 'utf8')
    assert.equal(first.documents[0].state, 'published')
    assert.equal(first.report.summary.priorEvents, 0)

    const second = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
    })
    assert.equal(second.report.summary.priorEvents, 3)
    assert.equal(second.documents[0].state, 'published')
    assert.equal(second.documents[0].revision, 3)
  }, { commands: TO_PUBLISHED })
})

test('a log whose chain is broken stops every command being decided', async () => {
  await workspace(async ({ root, log }) => {
    const options = { root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log }
    const first = await runEditorialMachine(options)
    await appendFile(log, eventLines(first.newEvents), 'utf8')

    const lines = (await readFile(log, 'utf8')).trimEnd().split('\n')
    const tampered = JSON.parse(lines[0])
    tampered.actor = 'mallory'
    const before = `${[JSON.stringify(tampered), ...lines.slice(1)].join('\n')}\n`
    await workspaceWrite(log, before)

    const second = await runEditorialMachine(options)
    assert.equal(second.report.status, 'incomplete')
    assert.equal(second.report.summary.checked, 0)
    assert.equal(second.appendable, false, 'nothing may be appended to a log that did not verify')
    assert.equal(second.newEvents.length, 0)
    assert.ok(rules(second.report).includes('event-chain-broken'))
    assert.ok(rules(second.report).includes('commands-not-evaluated'))
    assert.equal(await readFile(log, 'utf8'), before, 'the log must be untouched')
  }, { commands: TO_PUBLISHED })
})

async function workspaceWrite(path, text) {
  const { writeFile } = await import('node:fs/promises')
  await writeFile(path, text, 'utf8')
}

test('a machine that will not compile leaves every command undecided', async () => {
  const { report, appendable } = await run(TO_PUBLISHED, {
    machine: { ...structuredClone(MACHINE), initialState: 'limbo' },
  })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(appendable, false)
  assert.ok(rules(report).includes('machine-initial-unknown'))
  assert.ok(rules(report).includes('commands-not-evaluated'))
})

test('an empty batch is incomplete, never a pass on no evidence', async () => {
  const { report } = await run([])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.equal(report.summary.errors, 0, 'the flag, not an error finding, is what stops this passing')
  assert.deepEqual(rules(report), ['no-commands'])
})

test('one batch, two clocks: only the injected clock changes the outcome', async () => {
  const commands = [
    ...TO_PUBLISHED.slice(0, 2),
    command({
      commandId: 'c-schedule', action: 'schedule', actor: 'dana',
      at: '2026-03-03T09:00:00Z', expectedRevision: 2, scheduledFor: '2026-03-20T00:00:00Z',
    }),
    command({
      commandId: 'c-publish-early', action: 'publish', actor: 'dana',
      at: '2026-03-04T09:00:00Z', expectedRevision: 3,
    }),
  ]

  // Identical bytes on disk. The schedule is valid in both runs -- it is
  // judged against the command's own instant -- and only whether it has come
  // due changes, which is the injected clock's job and nothing else's.
  const early = await run(commands, { now: '2026-03-10T12:00:00Z' })
  assert.equal(early.report.status, 'fail')
  assert.deepEqual(rules(early.report), ['publish-before-schedule'])
  assert.equal(early.documents[0].state, 'scheduled')

  const late = await run(commands, { now: '2026-03-25T12:00:00Z' })
  assert.equal(late.report.status, 'pass')
  assert.deepEqual(rules(late.report), [])
  assert.equal(late.documents[0].state, 'published')
})

test('the API reads and never writes', async () => {
  await workspace(async ({ root, log }) => {
    const machineBefore = await readFile(`${root}/machine.json`, 'utf8')
    const commandsBefore = await readFile(`${root}/commands.json`, 'utf8')

    const result = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
    })
    assert.equal(result.newEvents.length, 3)

    assert.equal(await readFile(`${root}/machine.json`, 'utf8'), machineBefore)
    assert.equal(await readFile(`${root}/commands.json`, 'utf8'), commandsBefore)
    await assert.rejects(readFile(log, 'utf8'), /ENOENT/, 'the log must not have been created by the API')
  }, { commands: TO_PUBLISHED })
})

test('an unknown option, an unknown limit and a missing clock are configuration errors', async () => {
  await workspace(async ({ root }) => {
    const base = { root, machine: 'machine.json', commands: 'commands.json', now: NOW }
    await assert.rejects(runEditorialMachine({ ...base, verbose: true }), /Unknown option "verbose"/)
    await assert.rejects(runEditorialMachine({ ...base, limits: { maxCommand: 5 } }), /Unknown limit "maxCommand"/)
    await assert.rejects(runEditorialMachine({ ...base, limits: { maxCommands: 0 } }), /positive integer/)
    await assert.rejects(runEditorialMachine({ ...base, now: undefined }), /clock is required/)
    await assert.rejects(runEditorialMachine({ ...base, now: '2026-02-31T00:00:00Z' }), /clock is required/)
    await assert.rejects(runEditorialMachine({ ...base, root: undefined }), /input root is required/)
  }, { commands: TO_PUBLISHED })
})

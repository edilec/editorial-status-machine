import assert from 'node:assert/strict'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, eventLines, runEditorialMachine, validateLimits } from '../src/index.mjs'
import { MACHINE, NOW, TO_PUBLISHED, command, workspace } from './support.mjs'

/**
 * Every limit documented is enforced here, and every enforcement is asserted to
 * produce `incomplete` rather than `fail`. That distinction is what makes these
 * tests mutation-sensitive: deleting the `incomplete = true` beside a limit
 * leaves the finding in place and the exit code at 1, and every assertion below
 * would still be looking for `incomplete`.
 */

async function run(commands, { machine = MACHINE, limits = {}, log = null } = {}) {
  return workspace(async ({ root, log: logPath }) => runEditorialMachine({
    root,
    machine: 'machine.json',
    commands: 'commands.json',
    now: NOW,
    limits,
    ...(log === null ? {} : { events: logPath }),
  }), { machine, commands, ...(log === null ? {} : { files: { 'events.jsonl': log } }) })
}

function rules(report) {
  return report.findings.map((item) => item.ruleId)
}

test('validateLimits refuses an unknown name and a non-positive value', () => {
  assert.deepEqual({ ...validateLimits({}) }, { ...DEFAULT_LIMITS })
  assert.equal(validateLimits({ maxCommands: 7 }).maxCommands, 7)
  assert.throws(() => validateLimits({ maxCommand: 7 }), /Unknown limit "maxCommand"/)
  assert.throws(() => validateLimits({ maxCommands: 0 }), /positive integer/)
  assert.throws(() => validateLimits({ maxCommands: 1.5 }), /positive integer/)
  assert.throws(() => validateLimits({ maxCommands: '7' }), /positive integer/)
  assert.throws(() => validateLimits(null), /must be an object/)
  assert.throws(() => validateLimits([]), /must be an object/)
})

test('maxCommands stops the batch being decided at all', async () => {
  const report = (await run(TO_PUBLISHED, { limits: { maxCommands: 2 } })).report
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.deepEqual(rules(report).sort(), ['commands-not-evaluated', 'too-many-commands'])
})

test('maxDocuments leaves the rest of the batch undecided rather than truncating quietly', async () => {
  const commands = [
    command({ commandId: 'c-a', document: 'a' }),
    command({ commandId: 'c-b', document: 'b' }),
    command({ commandId: 'c-c', document: 'c' }),
  ]
  const { report, newEvents } = await run(commands, { limits: { maxDocuments: 2 } })
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.applied, 2)
  assert.equal(report.summary.checked, 2, 'the commands after the bound are undecided, not passed')
  assert.ok(rules(report).includes('too-many-documents'))
  assert.equal(newEvents.length, 2)
})

/** Seed a log with one applied command per named document, as the CLI would. */
async function seedDocuments(root, log, documents) {
  await writeFile(
    join(root, 'commands.json'),
    JSON.stringify(documents.map((name) => command({ commandId: `seed-${name}`, document: name }))),
    'utf8',
  )
  const first = await runEditorialMachine({
    root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
  })
  assert.equal(first.report.summary.applied, documents.length)
  await appendFile(log, eventLines(first.newEvents), 'utf8')
}

test('maxDocuments counts the documents the log already projects', async () => {
  // The bound is on the documents this run holds state for, and the log is
  // where most of them come from. A run whose log alone is over the bound must
  // not report a pass about it.
  await workspace(async ({ root, log }) => {
    const names = ['doc-a', 'doc-b', 'doc-c', 'doc-d', 'doc-e']
    await seedDocuments(root, log, names)

    const result = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
      limits: { maxDocuments: 2 },
    })
    assert.equal(result.report.status, 'incomplete')
    assert.equal(result.report.summary.checked, 0, 'nothing may be decided against a projection left unused')
    assert.equal(result.report.summary.applied, 0)
    assert.equal(result.report.summary.documents, 0)
    assert.equal(result.appendable, false)
    assert.equal(result.newEvents.length, 0)
    assert.deepEqual(rules(result.report).sort(), ['commands-not-evaluated', 'too-many-documents'])
    assert.match(
      result.report.findings.find((item) => item.ruleId === 'too-many-documents').message,
      /log projects 5 documents, above the maxDocuments limit of 2/,
    )

    // And at the bound itself the same log is used normally.
    const within = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
      limits: { maxDocuments: names.length },
    })
    assert.equal(within.report.status, 'pass')
    assert.equal(within.report.summary.replayed, names.length)
    assert.equal(within.report.summary.documents, names.length)
  }, { commands: TO_PUBLISHED })
})

test('a document the log projects fills the bound for the batch that follows', async () => {
  // The batch-side counter starts from the log's documents. Starting it empty
  // would let a run holding maxDocuments documents already accept a command
  // opening one more, and report a pass.
  await workspace(async ({ root, log }) => {
    await seedDocuments(root, log, ['doc-a', 'doc-b'])
    await writeFile(
      join(root, 'commands.json'),
      JSON.stringify([command({ commandId: 'c-new', document: 'doc-c' })]),
      'utf8',
    )

    const result = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
      limits: { maxDocuments: 2 },
    })
    assert.equal(result.report.status, 'incomplete')
    assert.equal(result.report.summary.applied, 0, 'the new document must not be opened past the bound')
    assert.equal(result.report.summary.checked, 0)
    assert.equal(result.newEvents.length, 0)
    assert.ok(rules(result.report).includes('too-many-documents'), rules(result.report).join(','))
    assert.match(
      result.report.findings.find((item) => item.ruleId === 'too-many-documents').message,
      /document number 3, above the maxDocuments limit of 2/,
    )

    // One more room and the same command is applied, so the bound is what
    // refused it and nothing else.
    const roomier = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
      limits: { maxDocuments: 3 },
    })
    assert.equal(roomier.report.status, 'pass')
    assert.equal(roomier.report.summary.applied, 1)
  }, { commands: TO_PUBLISHED })
})

test('maxFileBytes refuses to read an oversized input', async () => {
  const report = (await run(TO_PUBLISHED, { limits: { maxFileBytes: 40 } })).report
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.checked, 0)
  assert.ok(rules(report).includes('input-too-large'))
})

test('maxEvents refuses to replay an oversized log', async () => {
  await workspace(async ({ root, log }) => {
    const options = { root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log }
    const first = await runEditorialMachine(options)
    await appendFile(log, eventLines(first.newEvents), 'utf8')

    const bounded = await runEditorialMachine({ ...options, limits: { maxEvents: 2 } })
    assert.equal(bounded.report.status, 'incomplete')
    assert.equal(bounded.report.summary.checked, 0)
    assert.equal(bounded.appendable, false)
    assert.ok(rules(bounded.report).includes('too-many-events'))
  }, { commands: TO_PUBLISHED })
})

test('the machine limits are reported by name and leave the run incomplete', async () => {
  for (const [limits, ruleId] of [
    [{ maxStates: 3 }, 'too-many-states'],
    [{ maxTransitions: 3 }, 'too-many-transitions'],
    [{ maxActors: 2 }, 'too-many-actors'],
  ]) {
    const { report } = await run(TO_PUBLISHED, { limits })
    assert.equal(report.status, 'incomplete', ruleId)
    assert.equal(report.summary.checked, 0, ruleId)
    assert.ok(rules(report).includes(ruleId), `${ruleId} not in ${rules(report)}`)
  }
})

test('an identifier above the documented 200 characters is refused', async () => {
  const { report } = await run([command({ document: 'd'.repeat(201) })])
  assert.equal(report.status, 'fail')
  assert.deepEqual(rules(report), ['identifier-invalid'])

  const ok = await run([command({ document: 'd'.repeat(200) })])
  assert.equal(ok.report.status, 'pass')
})

test('every limit the docs list is enforced somewhere in the source', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = [
    await readFile(new URL('../src/index.mjs', import.meta.url), 'utf8'),
    await readFile(new URL('../src/machine.mjs', import.meta.url), 'utf8'),
    await readFile(new URL('../src/events.mjs', import.meta.url), 'utf8'),
  ].join('\n')
  for (const name of Object.keys(DEFAULT_LIMITS)) {
    // A limit accepted by the CLI and never compared against anything is the
    // "documented limit never enforced" defect; every name must be read back.
    const uses = source.split(`limits.${name}`).length - 1
    assert.ok(uses >= 1, `${name} is declared but never compared against anything`)
  }
})

test('an input that is a directory rather than a file is reported, not assumed empty', async () => {
  await workspace(async ({ root, log }) => {
    await mkdir(join(root, 'nested'), { recursive: true })
    await writeFile(join(root, 'nested', 'keep.txt'), 'x', 'utf8')
    const { report } = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'nested', now: NOW, events: log,
    })
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
    assert.ok(rules(report).includes('input-unreadable'))
  }, { commands: TO_PUBLISHED })
})

test('an input that is not UTF-8, or not JSON, is reported and nothing is inferred from it', async () => {
  await workspace(async ({ root, log }) => {
    await writeFile(join(root, 'commands.json'), Buffer.from([0x5b, 0xff, 0x5d]))
    const notUtf8 = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
    })
    assert.equal(notUtf8.report.status, 'incomplete')
    assert.ok(rules(notUtf8.report).includes('input-not-utf8'))

    await writeFile(join(root, 'commands.json'), '[ not json', 'utf8')
    const notJson = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
    })
    assert.equal(notJson.report.status, 'incomplete')
    assert.ok(rules(notJson.report).includes('input-not-json'))
  }, { commands: TO_PUBLISHED })
})

test('the machine definition is decoded as strictly as the data is', async () => {
  // One tool in this catalog hardened its data path and left its configuration
  // path lossy. Both paths go through the same strict decoder here.
  await workspace(async ({ root, log }) => {
    await writeFile(join(root, 'machine.json'), Buffer.from([0x7b, 0xc3, 0x28, 0x7d]))
    const { report, appendable } = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
    })
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
    assert.equal(appendable, false)
    assert.ok(rules(report).includes('input-not-utf8'))
  }, { commands: TO_PUBLISHED })
})

test('a command file that is not a JSON array is refused', async () => {
  await workspace(async ({ root, log }) => {
    await writeFile(join(root, 'commands.json'), JSON.stringify({ commands: [] }), 'utf8')
    const { report } = await runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW, events: log,
    })
    assert.equal(report.status, 'incomplete')
    assert.ok(rules(report).includes('commands-not-an-array'))
  }, { commands: TO_PUBLISHED })
})

import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

import { validateCommand } from '../src/commands.mjs'
import { GENESIS_HASH, eventHash, parseEventLog, serializeEvent } from '../src/events.mjs'
import { DEFAULT_LIMITS, formatReport, runEditorialMachine } from '../src/index.mjs'
import { actionsFrom, compileMachine } from '../src/machine.mjs'
import { parseInstant } from '../src/text.mjs'
import { MACHINE, NOW, TO_PUBLISHED, command, workspace } from './support.mjs'

/**
 * Ordering, pinned by the order that comes out.
 *
 * `test/determinism.test.mjs` scans the shipped source for `localeCompare`.
 * That scan is worth keeping and is not a determinism test: swapping a call
 * site for a collator spelled any other way -- `Intl.Collator`, or
 * `a['locale' + 'Compare'](b)` -- passes the scan and leaves the emitted order
 * dependent on the ICU data of whichever machine ran the tool.
 *
 * So every case below chooses values whose order genuinely differs between
 * UTF-16 code units and collation, pushes them through the real path, and
 * asserts the exact order that comes out. `Zeta` before `alpha` is the
 * workhorse: `Z` is U+005A and `a` is U+0061, so code units put `Zeta` first,
 * while every collation puts it last.
 *
 * One tie-break cannot be pinned this way and is called out rather than
 * quietly skipped: the final `message` comparison in the findings sort. No
 * input reaches it, because two findings that agree on file, command index,
 * pointer and rule id also carry the same message. It is there for stability
 * if that ever stops being true.
 */

const CODE_UNIT_ORDER = Object.freeze(['Zeta', 'a_b', 'ab', 'alpha'])
const COLLATED_ORDER = Object.freeze(['a_b', 'ab', 'alpha', 'Zeta'])

test('the fixtures really do order differently under collation', () => {
  // The premise every case below rests on, checked against the host's own ICU
  // data rather than asserted from memory. If these two agreed, the cases
  // would prove nothing.
  const collated = [...CODE_UNIT_ORDER].sort((left, right) => left.localeCompare(right))
  assert.deepEqual(collated, [...COLLATED_ORDER])
  assert.notDeepEqual(collated, [...CODE_UNIT_ORDER])
})

/** A tiny machine whose four actions and four roles are the ordering fixtures. */
const ORDERED_MACHINE = Object.freeze({
  schemaVersion: '1',
  name: 'ordering-lifecycle',
  initialState: 'draft',
  roles: [...CODE_UNIT_ORDER],
  states: [{ id: 'draft' }, { id: 'done', terminal: true }],
  actors: [{ id: 'alice', roles: ['alpha'] }],
  transitions: CODE_UNIT_ORDER.map((action) => ({
    from: 'draft', action, to: 'done', roles: ['alpha'],
  })),
})

test('a machine lists its roles and actions by code unit', () => {
  const { machine, problems } = compileMachine(structuredClone(ORDERED_MACHINE), DEFAULT_LIMITS)
  assert.deepEqual(problems, [])
  assert.deepEqual([...machine.roles], [...CODE_UNIT_ORDER])
  assert.deepEqual([...machine.actions], [...CODE_UNIT_ORDER])
  assert.deepEqual(actionsFrom(machine, 'draft'), [...CODE_UNIT_ORDER])
})

test('the actions offered in a finding are listed by code unit', async () => {
  // actionsFrom reaches the report through the evidence of a refusal, which is
  // the only place a reader sees that order.
  const { report } = await workspace(
    async ({ root }) => runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW,
    }),
    {
      machine: ORDERED_MACHINE,
      commands: [command({ action: 'nope', actor: 'alice', document: 'post' })],
    },
  )
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['action-unknown'])
  assert.equal(report.findings[0].evidence, `available from "draft": ${CODE_UNIT_ORDER.join(', ')}`)
})

test('an unknown machine key is reported in code-unit order', () => {
  const value = { ...structuredClone(MACHINE), Zeta: 1, alpha: 2, a_b: 3, ab: 4 }
  const { problems } = compileMachine(value, DEFAULT_LIMITS)
  const keys = problems.filter((item) => item.ruleId === 'machine-key-unknown').map((item) => item.pointer)
  assert.deepEqual(keys, CODE_UNIT_ORDER.map((name) => `/${name}`))
})

test('an unknown command key is reported in code-unit order, before and after the report sort', async () => {
  const raw = { ...command(), Zeta: 1, alpha: 2, a_b: 3, ab: 4 }
  const { problems } = validateCommand(raw, 0, parseInstant(NOW).ms)
  assert.deepEqual(
    problems.map((item) => item.pointer),
    CODE_UNIT_ORDER.map((name) => `/commands/0/${name}`),
    'validateCommand reports its key problems in code-unit order',
  )

  const { report } = await workspace(
    async ({ root }) => runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW,
    }),
    { commands: [raw] },
  )
  assert.deepEqual(
    report.findings.map((item) => item.location.pointer),
    CODE_UNIT_ORDER.map((name) => `/commands/0/${name}`),
    'the findings sort orders pointers by code unit',
  )
})

test('an unknown event field is reported in code-unit order', () => {
  const machine = compileMachine(structuredClone(MACHINE), DEFAULT_LIMITS).machine
  const body = {
    seq: 1,
    commandId: 'c-1',
    document: 'post',
    action: 'submit',
    from: 'draft',
    to: 'review',
    actor: 'alice',
    at: '2026-03-01T09:00:00.000Z',
    revision: 1,
    scheduledFor: null,
    commandHash: '0'.repeat(64),
  }
  const line = JSON.parse(serializeEvent({ ...body, hash: eventHash(GENESIS_HASH, body) }))
  for (const key of CODE_UNIT_ORDER) line[key] = 1

  const { problems, trusted } = parseEventLog(`${JSON.stringify(line)}\n`, { machine, maxEvents: 100 })
  assert.equal(trusted, false)
  assert.deepEqual(
    problems.map((item) => item.pointer),
    CODE_UNIT_ORDER.map((name) => `/events/0/${name}`),
  )
})

test('machine shape warnings are reported state by state in code-unit order', () => {
  const value = structuredClone(MACHINE)
  value.states = [...value.states, ...CODE_UNIT_ORDER.map((id) => ({ id }))]
  const { machine, problems } = compileMachine(value, DEFAULT_LIMITS)
  assert.notEqual(machine, null)
  assert.deepEqual(
    problems.map((item) => `${item.pointer} ${item.ruleId}`),
    CODE_UNIT_ORDER.flatMap((id) => [
      `/states/${id} machine-state-unreachable`,
      `/states/${id} machine-state-stranded`,
    ]),
  )
})

test('the projected documents are listed by code unit, in the report and in the human lines', async () => {
  const { documents, report, machineName } = await workspace(
    async ({ root }) => runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW,
    }),
    {
      commands: CODE_UNIT_ORDER.map((name, index) => command({
        commandId: `c-${index}`, document: name,
      })),
    },
  )
  assert.equal(report.status, 'pass')
  assert.deepEqual(documents.map((row) => row.document), [...CODE_UNIT_ORDER])

  const lines = formatReport(report, { machineName, documents }).trimEnd().split('\n')
  assert.deepEqual(lines.slice(3).map((line) => line.trim().split(' ')[0]), [...CODE_UNIT_ORDER])
})

test('findings are ordered across files by code unit, the event log among them', async () => {
  // Three files in one report: a machine named so it sorts FIRST by code unit
  // and LAST by collation, a command batch, and the log under its logical name.
  const machine = { ...structuredClone(MACHINE), states: [...structuredClone(MACHINE.states), { id: 'limbo' }] }
  const { report } = await workspace(async ({ root, log }) => {
    await writeFile(join(root, 'Zeta.json'), JSON.stringify(machine), 'utf8')
    await writeFile(join(root, 'alpha.json'), JSON.stringify(TO_PUBLISHED), 'utf8')
    await writeFile(log, 'not json\n', 'utf8')
    return runEditorialMachine({
      root, machine: 'Zeta.json', commands: 'alpha.json', now: NOW, events: log,
    })
  }, { machine: null, commands: null })

  assert.equal(report.status, 'incomplete')
  assert.deepEqual(
    report.findings.map((item) => `${item.location.file} ${item.ruleId}`),
    [
      'Zeta.json machine-state-stranded',
      'Zeta.json machine-state-unreachable',
      'alpha.json commands-not-evaluated',
      'event-log event-line-invalid',
    ],
  )
})

test('two findings on one pointer are ordered by rule id, not by the order they were found', async () => {
  // Both carry file `commands.json`, index 0 and pointer `/`, so only the rule
  // id can separate them -- and the batch problem is recorded second, so
  // insertion order would put it last.
  const { report } = await workspace(async ({ root }) => {
    await writeFile(join(root, 'commands.json'), '[ broken', 'utf8')
    return runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW,
    })
  }, { commands: TO_PUBLISHED })

  assert.deepEqual(
    report.findings.map((item) => [item.location.file, item.location.pointer, item.ruleId]),
    [
      ['commands.json', '/', 'commands-not-evaluated'],
      ['commands.json', '/', 'input-not-json'],
    ],
  )
})

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import test from 'node:test'
import { promisify } from 'node:util'

import { runEditorialMachine } from '../src/index.mjs'
import { CLI, MACHINE, NOW, TO_PUBLISHED, command, workspace } from './support.mjs'

const run = promisify(execFile)

/**
 * Severity, pinned by what a run DOES rather than by what a table says.
 *
 * `test/severity-table.test.mjs` asserts the table against the documented
 * catalog and again rule by rule. All three are declarations, so a coordinated
 * edit to the three of them agrees with itself and passes: forty of the
 * fifty-two `error` rules could be downgraded to `warning` that way with the
 * whole suite green, turning a refused command into exit 0 -- an unauthorized
 * publish, a stale overwrite or a command from the future reported as a pass.
 *
 * Nothing in this file imports RULE_SEVERITY, reads the catalog or names a
 * severity. Each case below drives a real input through the real entry point
 * and the real binary and asserts the observable outcome: the rule the run
 * reported, the status, and the exit code. A downgrade changes those, so no
 * edit to a declaration can satisfy them.
 *
 * Every rule here is one whose severity DECIDES the outcome: the batch was
 * decided, so `fail` rests on that rule and nothing else. The error rules not
 * listed -- the `machine-*` compilation failures, the `event-*` log failures,
 * `input-*`, `commands-not-an-array` and the `too-many-*` bounds -- all leave
 * the run `incomplete` by the flag rather than by their severity, so their
 * severity cannot change a status or an exit code and no behavioural test can
 * pin it. Those keep the table, the catalog, the rule-by-rule pin, and (for the
 * machine ones) the invariant in `test/machine.test.mjs` that every fatal
 * compilation problem carries a rule the table marks as an error.
 */

/** A machine with one extra transition that requires a schedule from a state that sets none. */
function machineWithRelease() {
  const machine = structuredClone(MACHINE)
  machine.transitions = [
    ...machine.transitions,
    { from: 'approved', action: 'release', to: 'published', roles: ['publisher'], requiresSchedule: true },
  ]
  return machine
}

function withoutRevision() {
  const raw = command()
  delete raw.expectedRevision
  return raw
}

const SUBMIT_THEN_APPROVE = [
  command({ commandId: 'c-1', action: 'submit', actor: 'alice', at: '2026-03-02T09:00:00Z', expectedRevision: 0 }),
  command({ commandId: 'c-2', action: 'approve', actor: 'bob', at: '2026-03-03T09:00:00Z', expectedRevision: 1 }),
]

/** Each entry: the rule, the batch that provokes exactly it, and the machine to judge against. */
const REFUSALS = Object.freeze([
  ['action-unknown', [command({ action: 'teleport' })]],
  ['actor-unknown', [command({ actor: 'mallory' })]],
  ['command-in-future', [command({ at: '2026-06-01T09:00:00Z' })]],
  ['command-invalid', [42]],
  ['command-key-unknown', [{ ...command(), sidecar: true }]],
  ['command-out-of-order', [
    command({ commandId: 'c-1', at: '2026-03-02T09:00:00Z' }),
    command({ commandId: 'c-2', action: 'approve', actor: 'bob', at: '2026-03-01T09:00:00Z', expectedRevision: 1 }),
  ]],
  ['command-replay-mismatch', [...TO_PUBLISHED, { ...TO_PUBLISHED[2], actor: 'eve' }]],
  ['command-revision-invalid', [command({ expectedRevision: -1 })]],
  ['command-revision-missing', [withoutRevision()]],
  ['identifier-invalid', [command({ document: 'post id ' })]],
  ['publish-before-schedule', [
    ...SUBMIT_THEN_APPROVE,
    command({
      commandId: 'c-3', action: 'schedule', actor: 'dana', at: '2026-03-04T09:00:00Z',
      expectedRevision: 2, scheduledFor: '2026-04-01T00:00:00Z',
    }),
    command({
      commandId: 'c-4', action: 'publish', actor: 'dana', at: '2026-03-05T09:00:00Z', expectedRevision: 3,
    }),
  ]],
  ['schedule-in-past', [
    ...SUBMIT_THEN_APPROVE,
    command({
      commandId: 'c-3', action: 'schedule', actor: 'dana', at: '2026-03-04T09:00:00Z',
      expectedRevision: 2, scheduledFor: '2026-03-04T08:00:00Z',
    }),
  ]],
  ['schedule-missing', [
    ...SUBMIT_THEN_APPROVE,
    command({ commandId: 'c-3', action: 'release', actor: 'dana', at: '2026-03-04T09:00:00Z', expectedRevision: 2 }),
  ], machineWithRelease()],
  ['schedule-target-missing', [
    ...SUBMIT_THEN_APPROVE,
    command({ commandId: 'c-3', action: 'schedule', actor: 'dana', at: '2026-03-04T09:00:00Z', expectedRevision: 2 }),
  ]],
  ['schedule-target-unexpected', [command({ scheduledFor: '2026-04-01T00:00:00Z' })]],
  ['timestamp-invalid', [command({ at: 'yesterday' })]],
  ['transition-invalid', [command({ action: 'publish', actor: 'dana' })]],
  ['transition-stale', [command({ expectedRevision: 2 })]],
  ['transition-unauthorized', [command({ actor: 'dana' })]],
])

async function cli(root, extra = []) {
  const args = [
    CLI, '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
    '--now', NOW, '--json', ...extra,
  ]
  try {
    const { stdout } = await run(process.execPath, args)
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.code, stdout: error.stdout }
  }
}

test('every rule that refuses a command fails the run and exits 1', async () => {
  for (const [ruleId, commands, machine = MACHINE] of REFUSALS) {
    await workspace(async ({ root }) => {
      const { report } = await runEditorialMachine({
        root, machine: 'machine.json', commands: 'commands.json', now: NOW,
      })
      // Exactly one finding, so `fail` rests on this rule and nothing else.
      assert.deepEqual(report.findings.map((item) => item.ruleId), [ruleId], ruleId)
      assert.equal(report.status, 'fail', `${ruleId} did not fail the run`)
      assert.equal(report.summary.rejected, 1, ruleId)
      assert.ok(report.summary.checked > 0, ruleId)

      const viaCli = await cli(root)
      assert.equal(viaCli.code, 1, `${ruleId} did not exit 1`)
      assert.equal(JSON.parse(viaCli.stdout).status, 'fail', ruleId)
    }, { machine, commands })
  }
})

test('a run that refused a command is never reported as a pass', async () => {
  // The same property stated once over every refusal above: rejected > 0 and
  // status pass must not occur together, whatever any table says.
  for (const [ruleId, commands, machine = MACHINE] of REFUSALS) {
    await workspace(async ({ root }) => {
      const { report } = await runEditorialMachine({
        root, machine: 'machine.json', commands: 'commands.json', now: NOW,
      })
      assert.ok(report.summary.rejected > 0, ruleId)
      assert.notEqual(report.status, 'pass', `${ruleId}: a refused command reached a green run`)
      assert.ok(report.summary.errors > 0, `${ruleId}: a refusal with no error in the report`)
    }, { machine, commands })
  }
})

test('the rules that must not fail a run keep their runs green', async () => {
  // The other direction, and just as load-bearing: upgrading any of these
  // turns a correct client -- one retrying, or one whose machine merely has an
  // odd shape -- into a failed build.
  const cases = [
    ['command-replayed', [...TO_PUBLISHED, TO_PUBLISHED[0]], MACHINE, ['command-replayed']],
    [
      'machine shape warnings',
      TO_PUBLISHED,
      { ...structuredClone(MACHINE), states: [...structuredClone(MACHINE.states), { id: 'limbo' }] },
      ['machine-state-stranded', 'machine-state-unreachable'],
    ],
    [
      'machine-duplicate-entry',
      TO_PUBLISHED,
      { ...structuredClone(MACHINE), roles: ['author', 'author', 'editor', 'publisher', 'archivist'] },
      ['machine-duplicate-entry'],
    ],
  ]

  for (const [label, commands, machine, expected] of cases) {
    await workspace(async ({ root }) => {
      const { report } = await runEditorialMachine({
        root, machine: 'machine.json', commands: 'commands.json', now: NOW,
      })
      assert.deepEqual(report.findings.map((item) => item.ruleId).sort(), expected, label)
      assert.equal(report.status, 'pass', `${label} must not fail the run`)
      assert.equal(report.summary.errors, 0, label)

      const viaCli = await cli(root)
      assert.equal(viaCli.code, 0, `${label} did not exit 0`)
    }, { machine, commands })
  }
})

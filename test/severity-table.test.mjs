import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'

import { DEFAULT_LIMITS, RULE_SEVERITY, createFinding } from '../src/index.mjs'
import { projectDirectory } from './support.mjs'

/**
 * Severity decides whether a run fails or passes, so it is the one thing in
 * this tool most worth pinning. Fifty-eight construction sites each carrying
 * their own literal is exactly the shape that drifts silently; these tests
 * assert the single table, the documented catalog and the shipped source all
 * agree, in both directions.
 */

const SOURCE_FILES = ['src/index.mjs', 'src/machine.mjs', 'src/events.mjs', 'src/commands.mjs']

function readProjectFile(relativePath) {
  return readFile(resolve(projectDirectory, relativePath), 'utf8')
}

async function documentedSeverities() {
  const text = await readProjectFile('docs/lifecycle-rules.md')
  const rows = [...text.matchAll(/\|\s*`([a-z0-9-]+)`\s*\|\s*(error|warning|info)\s*\|/g)]
  return Object.fromEntries(rows.map((row) => [row[1], row[2]]))
}

test('the documented rule catalog matches the severity table exactly', async () => {
  const documented = await documentedSeverities()

  assert.equal(Object.keys(documented).length, 58)
  assert.deepEqual(
    Object.keys(documented).sort(),
    Object.keys(RULE_SEVERITY).sort(),
    'docs/lifecycle-rules.md and RULE_SEVERITY list different rules',
  )
  assert.deepEqual(documented, { ...RULE_SEVERITY })
})

test('every rule-shaped literal in the source is in the severity table', async () => {
  const source = (await Promise.all(SOURCE_FILES.map(readProjectFile))).join('\n')
  // Every kebab-case string literal in the source is a rule id, apart from the
  // two named below. Scanning all of them rather than only the `ruleId:`
  // spelling means a typo at any construction site -- including the ones that
  // hand a rule id to a problem constructor -- is caught here rather than at
  // runtime by a thrown error nobody triggered.
  const NOT_RULES = new Set(['editorial-status-machine', 'event-log'])
  const literals = new Set(
    [...source.matchAll(/'([a-z0-9]+(?:-[a-z0-9]+)+)'/g)].map((match) => match[1]),
  )

  assert.ok(literals.size >= 58, `the rule scan found suspiciously few literals: ${literals.size}`)
  for (const literal of literals) {
    if (NOT_RULES.has(literal)) continue
    assert.ok(Object.hasOwn(RULE_SEVERITY, literal), `${literal} is used in the source but missing from RULE_SEVERITY`)
  }
  for (const ruleId of Object.keys(RULE_SEVERITY)) {
    assert.ok(literals.has(ruleId), `${ruleId} is in the table but appears nowhere in the source`)
  }
})

test('no severity literal is written at a finding construction site', async () => {
  // A `severity:` beside a `ruleId:` is the defect this table exists to
  // prevent: it lets one rule be downgraded without the table, the docs or a
  // test noticing.
  for (const path of SOURCE_FILES) {
    const source = await readProjectFile(path)
    assert.equal(
      /severity:\s*'(error|warning|info)'/.test(source),
      false,
      `${path} writes a severity literal instead of reading RULE_SEVERITY`,
    )
  }
})

test('an unknown rule id throws rather than defaulting to something harmless', () => {
  assert.throws(
    () => createFinding({ ruleId: 'not-a-rule', message: 'x', file: 'a', pointer: '/' }),
    /not in RULE_SEVERITY/,
  )
})

test('every rule severity is pinned here, rule by rule', () => {
  // The table and the documented catalog are asserted against each other, so a
  // coordinated edit to both agrees with itself and passes. This is the third
  // copy, written out by hand: a downgrade has to walk past an expectation that
  // shares no source with either of them. Downgrading any `error` below turns a
  // refusal into a green build -- an unauthorized publish, a stale overwrite, a
  // skipped state or an altered log still reaching status pass.
  assert.deepEqual({ ...RULE_SEVERITY }, {
    'action-unknown': 'error',
    'actor-unknown': 'error',
    'command-in-future': 'error',
    'command-invalid': 'error',
    'command-key-unknown': 'error',
    'command-out-of-order': 'error',
    'command-replay-mismatch': 'error',
    'command-replayed': 'info',
    'command-revision-invalid': 'error',
    'command-revision-missing': 'error',
    'commands-not-an-array': 'error',
    'commands-not-evaluated': 'warning',
    'event-chain-broken': 'error',
    'event-command-duplicate': 'error',
    'event-field-invalid': 'error',
    'event-line-invalid': 'error',
    'event-out-of-order': 'error',
    'event-revision-broken': 'error',
    'event-sequence-broken': 'error',
    'event-state-mismatch': 'error',
    'event-state-unknown': 'error',
    'event-transition-unknown': 'error',
    'identifier-invalid': 'error',
    'input-not-json': 'error',
    'input-not-utf8': 'error',
    'input-too-large': 'error',
    'input-unreadable': 'error',
    'machine-actor-duplicate': 'error',
    'machine-duplicate-entry': 'warning',
    'machine-field-invalid': 'error',
    'machine-initial-unknown': 'error',
    'machine-invalid': 'error',
    'machine-key-unknown': 'error',
    'machine-role-unknown': 'error',
    'machine-schedule-contradiction': 'error',
    'machine-schema-version': 'error',
    'machine-state-duplicate': 'error',
    'machine-state-stranded': 'warning',
    'machine-state-unknown': 'error',
    'machine-state-unreachable': 'warning',
    'machine-transition-duplicate': 'error',
    'machine-transition-no-roles': 'error',
    'no-commands': 'warning',
    'publish-before-schedule': 'error',
    'schedule-in-past': 'error',
    'schedule-missing': 'error',
    'schedule-target-missing': 'error',
    'schedule-target-unexpected': 'error',
    'timestamp-invalid': 'error',
    'too-many-actors': 'error',
    'too-many-commands': 'error',
    'too-many-documents': 'error',
    'too-many-events': 'error',
    'too-many-states': 'error',
    'too-many-transitions': 'error',
    'transition-invalid': 'error',
    'transition-stale': 'error',
    'transition-unauthorized': 'error',
  })
})

test('the three refusals the tool exists to separate are all errors', () => {
  for (const ruleId of ['transition-unauthorized', 'transition-stale', 'transition-invalid']) {
    assert.equal(RULE_SEVERITY[ruleId], 'error', `${ruleId} must fail a run`)
  }
  // And the one outcome that must NOT fail a run, because a correct client
  // retrying is not an error.
  assert.equal(RULE_SEVERITY['command-replayed'], 'info')
})

test('every table entry uses a severity the report contract defines', () => {
  for (const [ruleId, severity] of Object.entries(RULE_SEVERITY)) {
    assert.ok(['error', 'warning', 'info'].includes(severity), `${ruleId} has severity ${severity}`)
  }
  assert.equal(Object.isFrozen(RULE_SEVERITY), true)
})

test('the documented limits are the shipped limits, and the CLI offers each flag', async () => {
  const text = await readProjectFile('docs/lifecycle-rules.md')
  const rows = [...text.matchAll(/\|\s*`(max[A-Za-z]+)`\s*\|\s*`(--[a-z-]+)`\s*\|\s*(\d+)\s*\|/g)]
  const documented = Object.fromEntries(rows.map((row) => [row[1], Number(row[3])]))

  assert.equal(rows.length, Object.keys(DEFAULT_LIMITS).length)
  assert.deepEqual(documented, { ...DEFAULT_LIMITS })

  const cli = await readProjectFile('bin/editorial-status-machine.mjs')
  for (const row of rows) {
    assert.equal(cli.includes(`['${row[2]}', '${row[1]}']`), true, `${row[2]} is documented but not wired to ${row[1]}`)
    assert.equal(cli.includes(`${row[2]} `), true, `${row[2]} is documented but not in --help`)
  }
  assert.equal(Object.isFrozen(DEFAULT_LIMITS), true)
})

test('the README names every guarantee the suite proves', async () => {
  const readme = await readProjectFile('README.md')
  for (const phrase of [
    'appends no second event',
    'Roles come from the machine',
    'not reachable',
    'append-only',
    'frozen table',
    'Limits and non-goals',
  ]) {
    assert.ok(readme.includes(phrase), `README does not state: ${phrase}`)
  }
})

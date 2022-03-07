import assert from 'node:assert/strict'
import test from 'node:test'

import { EVALUATION_ORDER, evaluateCommand, validateCommand } from '../src/commands.mjs'
import { DEFAULT_LIMITS, RULE_SEVERITY } from '../src/index.mjs'
import { initialDocument } from '../src/events.mjs'
import { compileMachine } from '../src/machine.mjs'
import { parseInstant } from '../src/text.mjs'
import { MACHINE, NOW, command } from './support.mjs'

const machine = compileMachine(structuredClone(MACHINE), DEFAULT_LIMITS).machine
const nowMs = parseInstant(NOW).ms

/** Validate then evaluate, the way the tool does. */
function decide(raw, document = initialDocument(machine)) {
  const validated = validateCommand(raw, 0, nowMs)
  if (!validated.ok) return { ok: false, shape: validated.problems.map((item) => item.ruleId) }
  return evaluateCommand(machine, document, validated.command, nowMs)
}

function at(state, overrides = {}) {
  return { ...initialDocument(machine), state, ...overrides }
}

test('a well-formed command from the initial state is accepted', () => {
  const verdict = decide(command())
  assert.equal(verdict.ok, true)
  assert.equal(verdict.to, 'review')
  assert.equal(verdict.scheduledFor, null)
})

test('an unauthorized transition fails, and says so specifically', () => {
  const verdict = decide(command({ actor: 'dana' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ruleId, 'transition-unauthorized')
  assert.equal(RULE_SEVERITY[verdict.ruleId], 'error')
  assert.match(verdict.evidence, /author/)
})

test('a stale transition fails, and is not confused with an invalid one', () => {
  // The action is available and the actor may perform it: only the revision
  // is wrong, so nothing else can be responsible for the refusal.
  const verdict = decide(command({ expectedRevision: 0 }), at('draft', { revision: 4 }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ruleId, 'transition-stale')
  assert.match(verdict.message, /revision 4 is current/)
  assert.equal(decide(command({ expectedRevision: 4 }), at('draft', { revision: 4 })).ok, true)
})

test('an invalid transition fails: a state cannot be skipped', () => {
  const verdict = decide(command({ action: 'publish', actor: 'dana' }))
  assert.equal(verdict.ok, false)
  assert.equal(verdict.ruleId, 'transition-invalid')
  assert.match(verdict.evidence, /submit/)
})

test('the three refusals are three distinct rules, never collapsed into one', () => {
  const unauthorized = decide(command({ actor: 'dana' }))
  const stale = decide(command({ expectedRevision: 3 }))
  const invalid = decide(command({ action: 'publish', actor: 'dana' }))
  const ids = [unauthorized.ruleId, stale.ruleId, invalid.ruleId]

  assert.deepEqual(ids, ['transition-unauthorized', 'transition-stale', 'transition-invalid'])
  assert.equal(new Set(ids).size, 3)
  for (const id of ids) assert.equal(RULE_SEVERITY[id], 'error')
})

test('authorisation is decided before staleness, as documented', () => {
  // Both apply: dana may not submit, and revision 7 is not current. The actor
  // is told what is wrong with the actor, not handed the revision history.
  const verdict = decide(command({ actor: 'dana', expectedRevision: 7 }))
  assert.equal(verdict.ruleId, 'transition-unauthorized')
  assert.ok(
    EVALUATION_ORDER.indexOf('transition-unauthorized') < EVALUATION_ORDER.indexOf('transition-stale'),
  )
})

test('an invalid transition is decided before authorisation', () => {
  // eve may not publish and publish is unavailable from draft. The lifecycle
  // answer comes first: no role change would make this command work.
  const verdict = decide(command({ action: 'publish', actor: 'eve' }))
  assert.equal(verdict.ruleId, 'transition-invalid')
  assert.ok(
    EVALUATION_ORDER.indexOf('transition-invalid') < EVALUATION_ORDER.indexOf('transition-unauthorized'),
  )
})

test('an unregistered actor holds nothing and is refused before anything else', () => {
  const verdict = decide(command({ actor: 'mallory' }))
  assert.equal(verdict.ruleId, 'actor-unknown')
  assert.equal(EVALUATION_ORDER[0], 'actor-unknown')
})

test('an action no transition declares is separated from one merely unavailable here', () => {
  assert.equal(decide(command({ action: 'archive' })).ruleId, 'action-unknown')
  assert.equal(decide(command({ action: 'approve', actor: 'bob' })).ruleId, 'transition-invalid')
})

test('a command cannot carry the roles it is judged against', () => {
  // Not "the roles are ignored" -- the key is refused outright, so a caller
  // cannot even believe it supplied them.
  const verdict = decide({ ...command({ actor: 'dana' }), roles: ['author'] })
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.shape, ['command-key-unknown'])
})

test('a command cannot name the state it would like to reach', () => {
  const verdict = decide({ ...command(), to: 'published' })
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.shape, ['command-key-unknown'])
})

test('expectedRevision is required, and must be a non-negative integer', () => {
  const { expectedRevision, ...without } = command()
  assert.equal(expectedRevision, 0)
  assert.deepEqual(decide(without).shape, ['command-revision-missing'])

  assert.deepEqual(decide(command({ expectedRevision: -1 })).shape, ['command-revision-invalid'])
  assert.deepEqual(decide(command({ expectedRevision: 1.5 })).shape, ['command-revision-invalid'])
  assert.deepEqual(decide(command({ expectedRevision: '0' })).shape, ['command-revision-invalid'])
})

test('every shape problem is reported at once, and stops evaluation', () => {
  const verdict = decide({ commandId: 'c-1', document: '', action: 'submit', actor: 42, at: 'yesterday' })
  assert.equal(verdict.ok, false)
  assert.deepEqual(verdict.shape.sort(), ['command-revision-missing', 'identifier-invalid', 'identifier-invalid', 'timestamp-invalid'])
})

test('a command timestamped after the injected clock is refused', () => {
  assert.deepEqual(decide(command({ at: '2026-03-11T00:00:00Z' })).shape, ['command-in-future'])
  // Exactly the clock is fine: the run decides "now".
  assert.equal(decide(command({ at: NOW })).ok, true)
})

test('a command timestamped before the document’s last event is refused', () => {
  const document = at('draft', { lastAt: '2026-03-05T00:00:00Z', lastAtMs: Date.UTC(2026, 2, 5) })
  assert.equal(decide(command({ at: '2026-03-01T09:00:00Z' }), document).ruleId, 'command-out-of-order')
  assert.equal(decide(command({ at: '2026-03-05T00:00:00Z' }), document).ok, true)
})

test('a scheduling transition requires a schedule, and a plain one refuses to hold one', () => {
  const approved = at('approved', { revision: 2 })
  const schedule = command({ action: 'schedule', actor: 'dana', expectedRevision: 2 })

  assert.equal(decide(schedule, approved).ruleId, 'schedule-target-missing')
  assert.equal(decide({ ...schedule, scheduledFor: '2026-04-01T00:00:00Z' }, approved).ok, true)

  const publish = command({ action: 'publish', actor: 'dana', expectedRevision: 2, scheduledFor: '2026-04-01T00:00:00Z' })
  assert.equal(decide(publish, approved).ruleId, 'schedule-target-unexpected')
})

test('a schedule is judged against the instant the command was issued', () => {
  const approved = at('approved', { revision: 2 })
  const schedule = (when) => command({
    action: 'schedule', actor: 'dana', expectedRevision: 2,
    at: '2026-03-02T09:00:00Z', scheduledFor: when,
  })
  assert.equal(decide(schedule('2026-03-01T00:00:00Z'), approved).ruleId, 'schedule-in-past')
  assert.equal(decide(schedule('2026-03-02T09:00:00Z'), approved).ruleId, 'schedule-in-past')
  assert.equal(decide(schedule('2026-03-02T09:00:01Z'), approved).ok, true)

  // Already due by the run's clock is still a valid schedule: the decision is
  // judged when it was made, so replaying this batch a year later decides it
  // the same way. Comparing against NOW instead would refuse this.
  assert.ok(parseInstant('2026-03-03T00:00:00Z').ms < nowMs)
  assert.equal(decide(schedule('2026-03-03T00:00:00Z'), approved).ok, true)
})

test('publishing a scheduled document before its instant is refused, after it is allowed', () => {
  const publish = command({ action: 'publish', actor: 'dana', expectedRevision: 3 })

  const early = at('scheduled', { revision: 3, scheduledFor: '2026-03-20T00:00:00Z' })
  assert.equal(decide(publish, early).ruleId, 'publish-before-schedule')

  const due = at('scheduled', { revision: 3, scheduledFor: '2026-03-01T00:00:00Z' })
  assert.equal(decide(publish, due).ok, true)

  const never = at('scheduled', { revision: 3, scheduledFor: null })
  assert.equal(decide(publish, never).ruleId, 'schedule-missing')
})

test('a terminal state has no way out, whatever the actor holds', () => {
  const retired = at('retired', { revision: 6 })
  for (const action of ['submit', 'approve', 'publish', 'revise', 'retire']) {
    const verdict = decide(command({ action, actor: 'dana', expectedRevision: 6 }), retired)
    assert.equal(verdict.ok, false, `${action} must not leave a terminal state`)
    assert.equal(verdict.ruleId, 'transition-invalid')
  }
})

test('EVALUATION_ORDER lists only rules the severity table knows', () => {
  assert.ok(EVALUATION_ORDER.length >= 10)
  for (const ruleId of EVALUATION_ORDER) {
    assert.ok(Object.hasOwn(RULE_SEVERITY, ruleId), `${ruleId} is not in RULE_SEVERITY`)
  }
  assert.equal(new Set(EVALUATION_ORDER).size, EVALUATION_ORDER.length)
})

test('validateCommand refuses a command that is not an object without inspecting it', () => {
  for (const value of [null, [], 'submit', 7]) {
    const result = validateCommand(value, 0, nowMs)
    assert.equal(result.ok, false)
    assert.deepEqual(result.problems.map((item) => item.ruleId), ['command-invalid'])
  }
})

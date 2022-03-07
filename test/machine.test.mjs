import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS, RULE_SEVERITY } from '../src/index.mjs'
import {
  actionsFrom, compileMachine, hasAction, isAuthorized, lookupTransition,
} from '../src/machine.mjs'
import { MACHINE } from './support.mjs'

function compile(overrides = {}, limits = DEFAULT_LIMITS) {
  return compileMachine({ ...structuredClone(MACHINE), ...overrides }, limits)
}

function ruleIds(problems) {
  return problems.map((item) => item.ruleId).sort()
}

test('a well-formed machine compiles with no problem at all', () => {
  const { machine, problems } = compile()
  assert.deepEqual(problems, [])
  assert.equal(machine.name, 'test-lifecycle')
  assert.equal(machine.initialState, 'draft')
  assert.equal(machine.states.size, 6)
  assert.equal(machine.transitions.length, 9)
  assert.deepEqual(machine.roles, ['archivist', 'author', 'editor', 'publisher'])
})

test('a command names an action and the machine decides the destination', () => {
  const { machine } = compile()
  assert.equal(lookupTransition(machine, 'draft', 'submit').to, 'review')
  assert.equal(lookupTransition(machine, 'draft', 'publish'), null)
  assert.equal(lookupTransition(machine, 'approved', 'publish').to, 'published')
  assert.deepEqual(actionsFrom(machine, 'review'), ['approve', 'reject'])
  assert.deepEqual(actionsFrom(machine, 'retired'), [])
  assert.equal(hasAction(machine, 'publish'), true)
  assert.equal(hasAction(machine, 'archive'), false)
})

test('authorisation reads the registry and nothing the caller supplies', () => {
  const { machine } = compile()
  const submit = lookupTransition(machine, 'draft', 'submit')
  const approve = lookupTransition(machine, 'review', 'approve')

  assert.equal(isAuthorized(machine, 'alice', submit), true)
  assert.equal(isAuthorized(machine, 'bob', submit), true)
  assert.equal(isAuthorized(machine, 'dana', submit), false)
  assert.equal(isAuthorized(machine, 'alice', approve), false)
  assert.equal(isAuthorized(machine, 'bob', approve), true)
  // An actor the registry does not know holds nothing, whatever it claims.
  assert.equal(isAuthorized(machine, 'mallory', submit), false)
})

test('an unknown key anywhere in the machine is fatal, not ignored', () => {
  for (const [label, value] of [
    ['top level', { requireSchedule: true }],
    ['state', { states: [{ id: 'draft', terminl: true }] }],
    ['actor', { actors: [{ id: 'alice', role: ['author'] }] }],
    ['transition', {
      transitions: [{ from: 'draft', action: 'submit', to: 'review', roles: ['author'], setsSchedul: true }],
    }],
  ]) {
    const { machine, problems } = compile(value)
    assert.equal(machine, null, `${label}: an unknown key must be fatal`)
    assert.ok(ruleIds(problems).includes('machine-key-unknown'), `${label}: ${ruleIds(problems)}`)
  }
})

test('an empty role list on a transition is refused, not read as "anyone"', () => {
  const transitions = structuredClone(MACHINE.transitions)
  transitions[0].roles = []
  const { machine, problems } = compile({ transitions })
  assert.equal(machine, null)
  assert.ok(ruleIds(problems).includes('machine-transition-no-roles'))
})

test('a transition naming an undeclared state or role is fatal', () => {
  const withState = compile({
    transitions: [{ from: 'draft', action: 'submit', to: 'limbo', roles: ['author'] }],
  })
  assert.equal(withState.machine, null)
  assert.ok(ruleIds(withState.problems).includes('machine-state-unknown'))

  const withRole = compile({
    transitions: [{ from: 'draft', action: 'submit', to: 'review', roles: ['overlord'] }],
  })
  assert.equal(withRole.machine, null)
  assert.ok(ruleIds(withRole.problems).includes('machine-role-unknown'))
})

test('an actor holding an undeclared role is fatal', () => {
  const { machine, problems } = compile({ actors: [{ id: 'alice', roles: ['overlord'] }] })
  assert.equal(machine, null)
  assert.ok(ruleIds(problems).includes('machine-role-unknown'))
})

test('two transitions from one state under one action are ambiguous and fatal', () => {
  const transitions = [
    { from: 'draft', action: 'submit', to: 'review', roles: ['author'] },
    { from: 'draft', action: 'submit', to: 'approved', roles: ['author'] },
  ]
  const { machine, problems } = compile({ transitions })
  assert.equal(machine, null)
  assert.ok(ruleIds(problems).includes('machine-transition-duplicate'))
})

test('a duplicate state id and a duplicate actor id are both fatal', () => {
  const states = [...structuredClone(MACHINE.states), { id: 'draft' }]
  assert.equal(compile({ states }).machine, null)
  assert.ok(ruleIds(compile({ states }).problems).includes('machine-state-duplicate'))

  const actors = [...structuredClone(MACHINE.actors), { id: 'alice', roles: ['editor'] }]
  assert.equal(compile({ actors }).machine, null)
  assert.ok(ruleIds(compile({ actors }).problems).includes('machine-actor-duplicate'))
})

test('setsSchedule and requiresSchedule on one transition contradict each other', () => {
  const { machine, problems } = compile({
    transitions: [{
      from: 'draft', action: 'submit', to: 'review', roles: ['author'],
      setsSchedule: true, requiresSchedule: true,
    }],
  })
  assert.equal(machine, null)
  assert.ok(ruleIds(problems).includes('machine-schedule-contradiction'))
})

test('an initialState the machine does not declare is fatal', () => {
  const { machine, problems } = compile({ initialState: 'limbo' })
  assert.equal(machine, null)
  assert.ok(ruleIds(problems).includes('machine-initial-unknown'))
})

test('the wrong schemaVersion is fatal', () => {
  assert.equal(compile({ schemaVersion: '2' }).machine, null)
  assert.equal(compile({ schemaVersion: 1 }).machine, null)
  assert.ok(ruleIds(compile({ schemaVersion: '2' }).problems).includes('machine-schema-version'))
})

test('an identifier carrying a control character is refused at the door', () => {
  const { machine, problems } = compile({ states: [{ id: 'dr\naft' }, { id: 'review' }] })
  assert.equal(machine, null)
  assert.ok(ruleIds(problems).includes('identifier-invalid'))
})

test('a stranded, unreachable state is a warning and still compiles', () => {
  const states = [...structuredClone(MACHINE.states), { id: 'legal-hold' }]
  const { machine, problems } = compile({ states })
  assert.notEqual(machine, null, 'shape warnings must not abandon a usable machine')
  assert.deepEqual(ruleIds(problems), ['machine-state-stranded', 'machine-state-unreachable'])
  for (const item of problems) assert.equal(item.fatal, false)
})

test('a terminal state with no way out is neither stranded nor unreachable', () => {
  const { problems } = compile()
  assert.equal(problems.length, 0, 'retired is terminal and reachable, so it must be silent')
})

test('every fatal problem carries a rule the severity table marks as an error', () => {
  // Fatality and severity are different axes -- one abandons the run, the
  // other decides the exit code. A fatal problem reported as a warning would
  // abandon the machine while reporting nothing that fails the build.
  const cases = [
    { requireSchedule: true },
    { initialState: 'limbo' },
    { schemaVersion: '2' },
    { transitions: [{ from: 'draft', action: 'submit', to: 'review', roles: [] }] },
    { actors: [{ id: 'alice', roles: ['overlord'] }] },
    { states: [{ id: 'dr\naft' }] },
    { states: 'not-an-array' },
  ]
  let seen = 0
  for (const override of cases) {
    for (const item of compile(override).problems) {
      if (!item.fatal) continue
      seen += 1
      assert.equal(RULE_SEVERITY[item.ruleId], 'error', `${item.ruleId} is fatal but not an error`)
    }
  }
  assert.ok(seen >= 7, `expected several fatal problems across the cases, saw ${seen}`)
})

test('the state, transition and actor limits are enforced when compiling', () => {
  const many = (count, make) => Array.from({ length: count }, (unused, index) => make(index))

  const states = compile({ states: many(5, (index) => ({ id: `s${index}` })) }, { ...DEFAULT_LIMITS, maxStates: 4 })
  assert.equal(states.machine, null)
  assert.ok(ruleIds(states.problems).includes('too-many-states'))

  const transitions = compile({}, { ...DEFAULT_LIMITS, maxTransitions: 4 })
  assert.equal(transitions.machine, null)
  assert.ok(ruleIds(transitions.problems).includes('too-many-transitions'))

  const actors = compile({}, { ...DEFAULT_LIMITS, maxActors: 3 })
  assert.equal(actors.machine, null)
  assert.ok(ruleIds(actors.problems).includes('too-many-actors'))
})

test('a machine that is not an object is refused without inspection', () => {
  for (const value of [null, [], 'machine', 42]) {
    const { machine, problems } = compileMachine(value, DEFAULT_LIMITS)
    assert.equal(machine, null)
    assert.deepEqual(ruleIds(problems), ['machine-invalid'])
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'

import { DEFAULT_LIMITS } from '../src/index.mjs'
import {
  GENESIS_HASH, buildEvent, canonicalEventBody, commandHash, eventHash,
  initialDocument, parseEventLog, serializeEvent,
} from '../src/events.mjs'
import { compileMachine } from '../src/machine.mjs'
import { parseInstant } from '../src/text.mjs'
import { MACHINE, command } from './support.mjs'

/** Mirror what the tool does to an accepted command: instants are canonical. */
function canonical(value) {
  return value === null || value === undefined ? null : parseInstant(value).canonical
}

const machine = compileMachine(structuredClone(MACHINE), DEFAULT_LIMITS).machine

/** Build a valid log from a list of {action, actor, at, document} steps. */
function log(steps) {
  const documents = new Map()
  let previousHash = GENESIS_HASH
  const events = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const state = documents.get(step.document ?? 'post') ?? initialDocument(machine)
    const transition = machine.byFrom.get(state.state).get(step.action)
    const event = buildEvent({
      seq: index + 1,
      previousHash,
      command: command({
        commandId: `c-${index + 1}`,
        document: step.document ?? 'post',
        action: step.action,
        actor: step.actor,
        at: canonical(step.at),
        expectedRevision: state.revision,
        scheduledFor: canonical(step.scheduledFor),
      }),
      transition,
      revision: state.revision + 1,
      scheduledFor: transition.setsSchedule ? canonical(step.scheduledFor) : null,
    })
    events.push(event)
    previousHash = event.hash
    documents.set(step.document ?? 'post', {
      state: transition.to,
      revision: event.revision,
      scheduledFor: event.scheduledFor,
      lastAt: event.at,
      lastAtMs: Date.parse(event.at),
    })
  }
  return `${events.map(serializeEvent).join('\n')}\n`
}

const THREE_STEPS = [
  { action: 'submit', actor: 'alice', at: '2026-03-01T09:00:00Z' },
  { action: 'approve', actor: 'bob', at: '2026-03-02T09:00:00Z' },
  { action: 'publish', actor: 'dana', at: '2026-03-03T09:00:00Z' },
]

function replay(text, overrides = {}) {
  return parseEventLog(text, { machine, maxEvents: DEFAULT_LIMITS.maxEvents, ...overrides })
}

function tokenStateFixture() {
  const secret = 'token=SYNTHETIC_SECRET_CANARY'
  const compiled = compileMachine({
    schemaVersion: '1', name: 'token-state', initialState: secret,
    roles: ['editor'], actors: [{ id: 'alice', roles: ['editor'] }],
    states: [{ id: secret }, { id: 'reviewed' }, { id: 'done', terminal: true }],
    transitions: [
      { from: secret, action: 'advance', to: 'reviewed', roles: ['editor'] },
      { from: secret, action: 'finish', to: 'done', roles: ['editor'] },
      { from: 'reviewed', action: 'finish', to: 'done', roles: ['editor'] },
    ],
  }, DEFAULT_LIMITS)
  assert.notEqual(compiled.machine, null)
  const first = {
    seq: 1, commandId: 'c-1', document: 'doc-a', action: 'advance',
    from: secret, to: 'reviewed', actor: 'alice',
    at: '2026-03-01T09:00:00.000Z', revision: 1, scheduledFor: null,
    commandHash: 'a'.repeat(64),
  }
  first.hash = eventHash(GENESIS_HASH, first)
  return { secret, machine: compiled.machine, first }
}

test('an empty log replays to nothing and is trusted', () => {
  const result = replay('')
  assert.equal(result.trusted, true)
  assert.deepEqual(result.problems, [])
  assert.equal(result.events.length, 0)
  assert.equal(result.documents.size, 0)
})

test('a valid log replays into the projection the events describe', () => {
  const result = replay(log(THREE_STEPS))
  assert.deepEqual(result.problems, [])
  assert.equal(result.trusted, true)
  assert.equal(result.events.length, 3)
  assert.deepEqual(result.documents.get('post'), {
    state: 'published',
    revision: 3,
    scheduledFor: null,
    lastAt: '2026-03-03T09:00:00.000Z',
    lastAtMs: Date.UTC(2026, 2, 3, 9),
  })
  assert.deepEqual([...result.byCommandId.keys()], ['c-1', 'c-2', 'c-3'])
})

test('the chain hash covers field values, so editing any one of them breaks it', () => {
  const lines = log(THREE_STEPS).trimEnd().split('\n')
  const tampered = JSON.parse(lines[1])
  tampered.actor = 'mallory'
  const text = `${[lines[0], JSON.stringify(tampered), lines[2]].join('\n')}\n`

  const result = replay(text)
  assert.equal(result.trusted, false)
  assert.deepEqual(result.problems.map((item) => item.ruleId), ['event-chain-broken'])
  // Verification stops at the break: nothing after an altered line is believed.
  assert.equal(result.events.length, 1)
})

test('removing a line from the middle is caught by the sequence, not only the hash', () => {
  const lines = log(THREE_STEPS).trimEnd().split('\n')
  const result = replay(`${[lines[0], lines[2]].join('\n')}\n`)
  assert.equal(result.trusted, false)
  assert.ok(result.problems.some((item) => item.ruleId === 'event-sequence-broken'))
})

test('reordering two lines is caught', () => {
  const lines = log(THREE_STEPS).trimEnd().split('\n')
  const result = replay(`${[lines[1], lines[0], lines[2]].join('\n')}\n`)
  assert.equal(result.trusted, false)
  assert.ok(result.problems.some((item) => item.ruleId === 'event-sequence-broken'))
})

test('a hash over a positional body does not depend on key order in the line', () => {
  const [line] = log(THREE_STEPS).trimEnd().split('\n')
  const parsed = JSON.parse(line)
  const reordered = Object.fromEntries(Object.entries(parsed).reverse())
  assert.notDeepEqual(Object.keys(parsed), Object.keys(reordered))
  assert.equal(canonicalEventBody(reordered), canonicalEventBody(parsed))
  assert.equal(eventHash(GENESIS_HASH, reordered), parsed.hash)
})

test('a log line that is not JSON, or not an object, is reported', () => {
  assert.ok(replay('not json\n').problems.some((item) => item.ruleId === 'event-line-invalid'))
  assert.ok(replay('[1,2]\n').problems.some((item) => item.ruleId === 'event-line-invalid'))
  assert.ok(replay('\n').problems.some((item) => item.ruleId === 'event-line-invalid'))
  assert.equal(replay('not json\n').trusted, false)
})

test('an unknown or missing event field is reported rather than ignored', () => {
  const [line] = log(THREE_STEPS).trimEnd().split('\n')

  const extra = { ...JSON.parse(line), approvedBy: 'mallory' }
  assert.ok(replay(`${JSON.stringify(extra)}\n`).problems.some((item) => item.ruleId === 'event-field-invalid'))

  const missing = JSON.parse(line)
  delete missing.commandHash
  assert.ok(replay(`${JSON.stringify(missing)}\n`).problems.some((item) => item.ruleId === 'event-field-invalid'))
})

test('a log recording a transition the machine no longer declares is refused', () => {
  const lines = log(THREE_STEPS).trimEnd().split('\n')
  const gone = ['published', 'retired']
  const narrowed = compileMachine({
    ...structuredClone(MACHINE),
    transitions: structuredClone(MACHINE.transitions)
      .filter((item) => !gone.includes(item.to) && !gone.includes(item.from)),
    states: structuredClone(MACHINE.states).filter((item) => !gone.includes(item.id)),
  }, DEFAULT_LIMITS).machine
  assert.notEqual(narrowed, null, 'the narrowed machine must itself be valid')

  const result = parseEventLog(`${lines.join('\n')}\n`, { machine: narrowed, maxEvents: 100 })
  assert.equal(result.trusted, false)
  assert.ok(result.problems.some((item) => item.ruleId === 'event-state-unknown'))
})

test('a log line whose destination contradicts the machine is refused', () => {
  // Both states are declared, the chain is recomputed and verifies, the action
  // exists from that state: the ONLY thing wrong is where the machine says the
  // action leads. Dropping the destination half of this check lets anyone who
  // can write the log project a document into any state -- `published`
  // included -- and the tool then judges commands against that forged state.
  const [line] = log(THREE_STEPS).trimEnd().split('\n')
  const forged = JSON.parse(line)
  assert.deepEqual([forged.from, forged.action, forged.to], ['draft', 'submit', 'review'])
  forged.to = 'published'
  forged.hash = eventHash(GENESIS_HASH, forged)

  const result = replay(`${JSON.stringify(forged)}\n`)
  assert.equal(result.trusted, false)
  assert.deepEqual(result.problems.map((item) => item.ruleId), ['event-transition-unknown'])
  assert.equal(result.problems[0].evidence, 'draft --submit--> published')
  assert.equal(result.documents.size, 0, 'nothing may be projected from a line the machine contradicts')
  assert.equal(result.events.length, 0)
  // The chain itself is intact: the hash was recomputed over the forged body,
  // so nothing but the machine disagreement can be responsible for the refusal.
  assert.equal(result.problems.some((item) => item.ruleId === 'event-chain-broken'), false)
  assert.equal(result.problems.some((item) => item.ruleId === 'event-state-unknown'), false)
})

test('a log whose replay disagrees with an event’s "from" is refused', () => {
  // A log built for a different document history: seq 2 starts from review,
  // but nothing put this document there.
  const text = log([THREE_STEPS[0]]).trimEnd()
  const second = JSON.parse(log(THREE_STEPS).trimEnd().split('\n')[1])
  second.document = 'other'
  second.hash = eventHash(JSON.parse(text).hash, second)
  const result = replay(`${text}\n${JSON.stringify(second)}\n`)
  assert.equal(result.trusted, false)
  assert.ok(result.problems.some((item) => item.ruleId === 'event-state-mismatch'))
})

test('a replay mismatch never describes two different accepted states as the same state', () => {
  const compiled = compileMachine({
    schemaVersion: '1', name: 'space-distinction', initialState: 'review ready',
    roles: ['editor'], actors: [{ id: 'alice', roles: ['editor'] }],
    states: [{ id: 'review ready' }, { id: 'review  ready' }, { id: 'done', terminal: true }],
    transitions: [
      { from: 'review ready', action: 'advance', to: 'review  ready', roles: ['editor'] },
      { from: 'review ready', action: 'finish', to: 'done', roles: ['editor'] },
      { from: 'review  ready', action: 'finish', to: 'done', roles: ['editor'] },
    ],
  }, DEFAULT_LIMITS)
  assert.notEqual(compiled.machine, null)
  const first = {
    seq: 1, commandId: 'c-1', document: 'doc-a', action: 'advance',
    from: 'review ready', to: 'review  ready', actor: 'alice',
    at: '2026-03-01T09:00:00.000Z', revision: 1, scheduledFor: null,
    commandHash: 'a'.repeat(64),
  }
  first.hash = eventHash(GENESIS_HASH, first)
  const good = parseEventLog(`${serializeEvent(first)}\n`, { machine: compiled.machine, maxEvents: 2 })
  assert.equal(good.trusted, true)
  assert.deepEqual(good.problems, [])

  const second = {
    ...first, seq: 2, commandId: 'c-2', action: 'finish', to: 'done',
    at: '2026-03-02T09:00:00.000Z', revision: 2, commandHash: 'b'.repeat(64),
  }
  second.hash = eventHash(first.hash, second)
  const mismatch = parseEventLog(`${serializeEvent(first)}\n${serializeEvent(second)}\n`,
    { machine: compiled.machine, maxEvents: 2 })
  assert.equal(mismatch.trusted, false)
  assert.deepEqual(mismatch.problems.map(({ ruleId }) => ruleId), ['event-state-mismatch'])
  assert.match(mismatch.problems[0].message, /differs from the replayed state/i)
  assert.match(mismatch.problems[0].message, /inspect \/events\/1\/from/i)
  assert.equal(mismatch.problems[0].message.includes('review ready'), false)
  assert.equal(mismatch.problems[0].pointer, '/events/1/from')
})

test('replay mismatch does not reveal hidden state suffixes through code-unit evidence', () => {
  const prefix = `${'a'.repeat(55)}token=`
  const red = `${prefix}RED`
  const blue = `${prefix}BLUE`
  const green = `${prefix}GREEN`
  const compiled = compileMachine({
    schemaVersion: '1', name: 'bounded-state-identity', initialState: red,
    roles: ['editor'], actors: [{ id: 'alice', roles: ['editor'] }],
    states: [{ id: red }, { id: blue }, { id: green }, { id: 'done', terminal: true }],
    transitions: [
      { from: red, action: 'advance', to: blue, roles: ['editor'] },
      { from: red, action: 'finish', to: 'done', roles: ['editor'] },
      { from: green, action: 'finish', to: 'done', roles: ['editor'] },
    ],
  }, DEFAULT_LIMITS)
  assert.notEqual(compiled.machine, null)
  const first = {
    seq: 1, commandId: 'c-1', document: 'doc-a', action: 'advance', from: red, to: blue,
    actor: 'alice', at: '2026-03-01T09:00:00.000Z', revision: 1, scheduledFor: null,
    commandHash: 'a'.repeat(64),
  }
  first.hash = eventHash(GENESIS_HASH, first)
  const good = parseEventLog(`${serializeEvent(first)}\n`, { machine: compiled.machine, maxEvents: 2 })
  assert.equal(good.trusted, true)
  assert.deepEqual(good.problems, [])

  const mismatchMessages = []
  for (const from of [red, green]) {
    const second = {
      ...first, seq: 2, commandId: 'c-2', action: 'finish', from, to: 'done',
      at: '2026-03-02T09:00:00.000Z', revision: 2, commandHash: 'b'.repeat(64),
    }
    second.hash = eventHash(first.hash, second)
    const result = parseEventLog(`${serializeEvent(first)}\n${serializeEvent(second)}\n`,
      { machine: compiled.machine, maxEvents: 2 })
    assert.equal(result.trusted, false)
    assert.deepEqual(result.problems.map(({ ruleId }) => ruleId), ['event-state-mismatch'])
    assert.match(result.problems[0].message, /differs from the replayed state/i)
    assert.equal(result.problems[0].message.includes(prefix), false)
    assert.equal(result.problems[0].pointer, '/events/1/from')
    mismatchMessages.push(result.problems[0].message)
  }
  assert.equal(mismatchMessages[0], mismatchMessages[1])
})

test('a short accepted state ID is never echoed by event-state-mismatch', () => {
  const { secret, machine: tokenMachine, first } = tokenStateFixture()
  const good = parseEventLog(`${serializeEvent(first)}\n`, { machine: tokenMachine, maxEvents: 2 })
  assert.equal(good.trusted, true)
  assert.deepEqual(good.problems, [])
  const second = {
    ...first, seq: 2, commandId: 'c-2', action: 'finish', to: 'done',
    at: '2026-03-02T09:00:00.000Z', revision: 2, commandHash: 'b'.repeat(64),
  }
  second.hash = eventHash(first.hash, second)
  const result = parseEventLog(`${serializeEvent(first)}\n${serializeEvent(second)}\n`,
    { machine: tokenMachine, maxEvents: 2 })
  assert.equal(result.trusted, false)
  assert.deepEqual(result.problems.map(({ ruleId }) => ruleId), ['event-state-mismatch'])
  assert.equal(JSON.stringify(result.problems).includes(secret), false)
  assert.equal(result.problems[0].pointer, '/events/1/from')
  assert.match(result.problems[0].message, /inspect \/events\/1\/from/i)
})

test('a revision that does not follow the one before it is refused', () => {
  const lines = log(THREE_STEPS).trimEnd().split('\n')
  const second = JSON.parse(lines[1])
  assert.equal(second.revision, 2)
  second.revision = 3
  second.hash = eventHash(JSON.parse(lines[0]).hash, second)

  const result = replay(`${lines[0]}\n${JSON.stringify(second)}\n`)
  assert.equal(result.trusted, false)
  assert.ok(result.problems.some((item) => item.ruleId === 'event-revision-broken'))
  // A gap in the revisions is how an event that was never recorded hides: the
  // optimistic-concurrency check rests on the revision being the count of
  // events, so the chain alone -- which still verifies -- is not enough.
  assert.equal(result.problems.some((item) => item.ruleId === 'event-chain-broken'), false)
  assert.equal(result.documents.size, 1)
  assert.equal(result.documents.get('post').revision, 1)
})

test('a document whose events move backwards in time is refused', () => {
  const lines = log(THREE_STEPS).trimEnd().split('\n')
  const second = JSON.parse(lines[1])
  second.at = '2026-02-01T09:00:00.000Z'
  second.hash = eventHash(JSON.parse(lines[0]).hash, second)

  const result = replay(`${lines[0]}\n${JSON.stringify(second)}\n`)
  assert.equal(result.trusted, false)
  assert.ok(result.problems.some((item) => item.ruleId === 'event-out-of-order'))
  // The chain still verifies: only the times are wrong, so the hash alone
  // would have let this through.
  assert.equal(result.problems.some((item) => item.ruleId === 'event-chain-broken'), false)
})

test('a log that records one command id twice is refused', () => {
  const lines = log(THREE_STEPS).trimEnd().split('\n')
  const second = JSON.parse(lines[1])
  second.commandId = 'c-1'
  second.hash = eventHash(JSON.parse(lines[0]).hash, second)
  const result = replay(`${lines[0]}\n${JSON.stringify(second)}\n`)
  assert.equal(result.trusted, false)
  assert.ok(result.problems.some((item) => item.ruleId === 'event-command-duplicate'))
})

test('the maxEvents limit stops the log being replayed at all', () => {
  const result = replay(log(THREE_STEPS), { maxEvents: 2 })
  assert.equal(result.trusted, false)
  assert.deepEqual(result.problems.map((item) => item.ruleId), ['too-many-events'])
  assert.equal(result.events.length, 0)
  assert.equal(result.documents.size, 0)
})

test('a scheduling event records its schedule and a later transition clears it', () => {
  const scheduled = replay(log([
    { action: 'submit', actor: 'alice', at: '2026-03-01T09:00:00Z' },
    { action: 'approve', actor: 'bob', at: '2026-03-02T09:00:00Z' },
    { action: 'schedule', actor: 'dana', at: '2026-03-03T09:00:00Z', scheduledFor: '2026-04-01T00:00:00Z' },
  ]))
  assert.equal(scheduled.documents.get('post').scheduledFor, '2026-04-01T00:00:00.000Z')

  const unscheduled = replay(log([
    { action: 'submit', actor: 'alice', at: '2026-03-01T09:00:00Z' },
    { action: 'approve', actor: 'bob', at: '2026-03-02T09:00:00Z' },
    { action: 'schedule', actor: 'dana', at: '2026-03-03T09:00:00Z', scheduledFor: '2026-04-01T00:00:00Z' },
    { action: 'unschedule', actor: 'dana', at: '2026-03-04T09:00:00Z' },
  ]))
  assert.equal(unscheduled.documents.get('post').scheduledFor, null)
})

test('commandHash separates two commands that differ in any judged field', () => {
  const base = command({ commandId: 'c-1' })
  const hash = commandHash(base)
  assert.notEqual(hash, commandHash(command({ commandId: 'c-1', actor: 'bob' })))
  assert.notEqual(hash, commandHash(command({ commandId: 'c-1', action: 'approve' })))
  assert.notEqual(hash, commandHash(command({ commandId: 'c-1', document: 'other' })))
  assert.notEqual(hash, commandHash(command({ commandId: 'c-1', at: '2026-03-02T09:00:00Z' })))
  assert.notEqual(hash, commandHash(command({ commandId: 'c-1', expectedRevision: 1 })))
  assert.notEqual(hash, commandHash(command({ commandId: 'c-1', scheduledFor: '2026-04-01T00:00:00Z' })))
  // The command id itself is not hashed: the hash answers "is this the same
  // instruction", and the id is the question, not part of the answer.
  assert.equal(hash, commandHash(command({ commandId: 'c-2' })))
})

test('serializeEvent writes one line with the documented field order', () => {
  const [line] = log(THREE_STEPS).trimEnd().split('\n')
  assert.equal(line.includes('\n'), false)
  assert.deepEqual(Object.keys(JSON.parse(line)), [
    'seq', 'commandId', 'document', 'action', 'from', 'to',
    'actor', 'at', 'revision', 'scheduledFor', 'commandHash', 'hash',
  ])
})

test('this module cannot touch a file, so it cannot rewrite an event', async () => {
  const { readFile } = await import('node:fs/promises')
  const source = await readFile(new URL('../src/events.mjs', import.meta.url), 'utf8')
  assert.equal(/from 'node:fs/.test(source), false, 'events.mjs must not import a filesystem API')
  for (const forbidden of ['writeFile', 'appendFile', 'truncate', 'unlink', 'rename', '.splice(']) {
    assert.equal(source.includes(forbidden), false, `events.mjs must not use ${forbidden}`)
  }
  // The events array is built by pushing verified lines in file order and is
  // never re-ordered; only key names are sorted, for deterministic reporting.
  assert.equal(source.includes('events.sort'), false)
  assert.equal(source.includes('.sort(byCodeUnit)'), true)
})

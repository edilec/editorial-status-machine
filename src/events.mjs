/**
 * The append-only event log, and the projection built by replaying it.
 *
 * An editorial log is the answer to "why is this published, and who said so".
 * Three properties make that answer worth anything, and all three are enforced
 * here rather than assumed:
 *
 * 1. **Append-only.** This module produces new lines and nothing else. There
 *    is no function that rewrites, reorders or removes an event, and the CLI
 *    opens the log for append.
 * 2. **Tamper-evident.** Each event carries a SHA-256 over the previous hash
 *    and its own canonical body, so an edited or removed line breaks the chain
 *    at that point and every line after it. A log whose chain does not verify
 *    is unknown evidence: the run is `incomplete` and nothing is appended to
 *    it.
 * 3. **Replayable.** The current state of every document is derived from the
 *    log, never stored beside it. There is no second copy to disagree.
 *
 * Nothing here reads the clock. Timestamps arrive in the events.
 */

import { createHash } from 'node:crypto'

import { byCodeUnit, excerpt, isIdentifier, isPlainObject, parseFailureDetail, parseInstant } from './text.mjs'

export const GENESIS_HASH = '0'.repeat(64)
export const EVENT_KEYS = Object.freeze([
  'seq', 'commandId', 'document', 'action', 'from', 'to',
  'actor', 'at', 'revision', 'scheduledFor', 'commandHash', 'hash',
])

const HEX_64 = /^[0-9a-f]{64}$/

/**
 * The bytes a hash covers, as a positional array.
 *
 * An array rather than an object on purpose: `JSON.stringify` of an object
 * follows insertion order, so a hash over an object would depend on the order
 * a field happened to be assigned. A tamper-evidence scheme that changes its
 * answer when a field moves in the source is not tamper-evidence.
 */
export function canonicalEventBody(event) {
  return JSON.stringify([
    event.seq,
    event.commandId,
    event.document,
    event.action,
    event.from,
    event.to,
    event.actor,
    event.at,
    event.revision,
    event.scheduledFor ?? null,
    event.commandHash,
  ])
}

export function eventHash(previousHash, event) {
  return createHash('sha256').update(previousHash, 'utf8').update('\n', 'utf8')
    .update(canonicalEventBody(event), 'utf8').digest('hex')
}

/**
 * The identity of a command, for idempotency.
 *
 * Two commands sharing an id must be the same command. This hash is what makes
 * "the same" checkable: a replay whose fields differ from the recorded event is
 * a different instruction wearing a used id, and it is refused rather than
 * treated as a duplicate to swallow.
 */
export function commandHash(command) {
  return createHash('sha256').update(JSON.stringify([
    command.document,
    command.action,
    command.actor,
    command.at,
    command.expectedRevision,
    command.scheduledFor ?? null,
  ]), 'utf8').digest('hex')
}

/** Serialise one event as a single JSON line, fields in the documented order. */
export function serializeEvent(event) {
  return JSON.stringify({
    seq: event.seq,
    commandId: event.commandId,
    document: event.document,
    action: event.action,
    from: event.from,
    to: event.to,
    actor: event.actor,
    at: event.at,
    revision: event.revision,
    scheduledFor: event.scheduledFor ?? null,
    commandHash: event.commandHash,
    hash: event.hash,
  })
}

/** Build the next event for an accepted command, sealing it with the chain hash. */
export function buildEvent({ seq, previousHash, command, transition, revision, scheduledFor }) {
  const body = {
    seq,
    commandId: command.commandId,
    document: command.document,
    action: command.action,
    from: transition.from,
    to: transition.to,
    actor: command.actor,
    at: command.at,
    revision,
    scheduledFor: scheduledFor ?? null,
    commandHash: commandHash(command),
  }
  return Object.freeze({ ...body, hash: eventHash(previousHash, body) })
}

/** The state a document starts from before any event has touched it. */
export function initialDocument(machine) {
  return { state: machine.initialState, revision: 0, scheduledFor: null, lastAt: null, lastAtMs: null }
}

function fault(ruleId, pointer, message, extra = {}) {
  return { ruleId, pointer, message, ...extra }
}

function fieldProblem(line, field, message, evidence) {
  return fault(
    'event-field-invalid',
    `/events/${line - 1}/${field}`,
    `Event on line ${line}: ${message}`,
    evidence === undefined ? {} : { evidence: excerpt(evidence, 80) },
  )
}

function firstDifferentUnit(left, right) {
  let offset = 0
  while (offset < left.length && offset < right.length && left.charCodeAt(offset) === right.charCodeAt(offset)) offset += 1
  return offset
}

function unitAt(value, offset) {
  return offset < value.length ? `U+${value.charCodeAt(offset).toString(16).toUpperCase().padStart(4, '0')}` : '<end>'
}

/**
 * Parse, verify and replay a log.
 *
 * Every problem found here makes the run `incomplete`: if the log cannot be
 * trusted, the current state of every document in it is unknown, and a command
 * judged against an unknown state is not judged at all. The catalog's worst
 * defect class is exactly this -- evidence that was never obtained reported as
 * a result -- so there is no partial-trust path. Either the whole log verifies
 * or the projection is refused.
 */
export function parseEventLog(text, { machine, maxEvents }) {
  const problems = []
  const events = []
  const documents = new Map()
  const byCommandId = new Map()

  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  if (lines.length > maxEvents) {
    problems.push(fault(
      'too-many-events',
      '/events',
      `The log holds ${lines.length} lines, above the maxEvents limit of ${maxEvents}; it was not replayed and no state was derived from it.`,
      { suggestion: 'Raise --max-events, or start a new log from a compacted snapshot.' },
    ))
    return { events, documents, byCommandId, problems, trusted: false }
  }

  let previousHash = GENESIS_HASH

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const number = index + 1
    const pointer = `/events/${index}`

    let value
    try {
      value = JSON.parse(line)
    } catch (error) {
      problems.push(fault(
        'event-line-invalid',
        pointer,
        `Line ${number} is not a JSON object: ${excerpt(parseFailureDetail(error), 80)}.`,
      ))
      continue
    }
    if (!isPlainObject(value)) {
      problems.push(fault('event-line-invalid', pointer, `Line ${number} is not a JSON object.`))
      continue
    }

    let broken = false
    for (const key of Object.keys(value).sort(byCodeUnit)) {
      if (!EVENT_KEYS.includes(key)) {
        problems.push(fieldProblem(number, excerpt(key, 60), `key "${excerpt(key, 60)}" is not part of the event schema.`))
        broken = true
      }
    }
    for (const key of EVENT_KEYS) {
      if (!Object.hasOwn(value, key)) {
        problems.push(fieldProblem(number, key, `field "${key}" is missing.`))
        broken = true
      }
    }
    if (broken) continue

    for (const field of ['commandId', 'document', 'action', 'from', 'to', 'actor']) {
      if (!isIdentifier(value[field])) {
        problems.push(fieldProblem(number, field, `field "${field}" is not a usable identifier.`,
          typeof value[field] === 'string' ? value[field] : JSON.stringify(value[field]) ?? 'undefined'))
        broken = true
      }
    }
    for (const field of ['commandHash', 'hash']) {
      if (typeof value[field] !== 'string' || !HEX_64.test(value[field])) {
        problems.push(fieldProblem(number, field, `field "${field}" must be 64 lowercase hexadecimal characters.`))
        broken = true
      }
    }
    for (const field of ['seq', 'revision']) {
      if (!Number.isInteger(value[field]) || value[field] < 1) {
        problems.push(fieldProblem(number, field, `field "${field}" must be an integer of at least 1.`))
        broken = true
      }
    }
    const at = parseInstant(value.at)
    if (!at.ok) {
      problems.push(fieldProblem(number, 'at', 'field "at" is not an ISO-8601 UTC instant such as 2026-03-01T09:00:00Z.',
        typeof value.at === 'string' ? value.at : JSON.stringify(value.at) ?? 'undefined'))
      broken = true
    }
    let scheduled = null
    if (value.scheduledFor !== null) {
      scheduled = parseInstant(value.scheduledFor)
      if (!scheduled.ok) {
        problems.push(fieldProblem(number, 'scheduledFor',
          'field "scheduledFor" must be null or an ISO-8601 UTC instant.',
          typeof value.scheduledFor === 'string' ? value.scheduledFor : JSON.stringify(value.scheduledFor) ?? 'undefined'))
        broken = true
      }
    }
    if (broken) continue

    if (value.seq !== index + 1) {
      problems.push(fault(
        'event-sequence-broken',
        pointer,
        `Line ${number} carries seq ${value.seq}; a log must number its events from 1 with no gap, so a line has been removed, reordered or inserted.`,
      ))
      continue
    }

    const expectedHash = eventHash(previousHash, value)
    if (expectedHash !== value.hash) {
      problems.push(fault(
        'event-chain-broken',
        pointer,
        `Line ${number} does not match the hash chain; this event or an earlier one has been altered since it was written.`,
        { suggestion: 'Restore the log from its authoritative copy. This tool never rewrites a log to make it verify.' },
      ))
      return { events, documents, byCommandId, problems, trusted: false }
    }
    previousHash = value.hash

    // The log is verified against the machine it will be judged with. A state
    // or action the machine no longer declares means the projection cannot be
    // interpreted, which is unknown evidence rather than an old-but-fine log.
    if (!machine.states.has(value.from) || !machine.states.has(value.to)) {
      problems.push(fault(
        'event-state-unknown',
        pointer,
        `Line ${number} moves "${excerpt(value.document, 60)}" between states the machine does not declare.`,
        { evidence: `${excerpt(value.from, 40)} -> ${excerpt(value.to, 40)}` },
      ))
      continue
    }
    const transition = machine.byFrom.get(value.from)?.get(value.action) ?? null
    if (transition === null || transition.to !== value.to) {
      problems.push(fault(
        'event-transition-unknown',
        pointer,
        `Line ${number} records a transition the machine does not declare, so the log and the machine disagree about the lifecycle.`,
        { evidence: `${excerpt(value.from, 40)} --${excerpt(value.action, 40)}--> ${excerpt(value.to, 40)}` },
      ))
      continue
    }

    if (byCommandId.has(value.commandId)) {
      problems.push(fault(
        'event-command-duplicate',
        pointer,
        `Line ${number} replays command id "${excerpt(value.commandId, 60)}", which line ${byCommandId.get(value.commandId).seq} already recorded; the log itself applied one command twice.`,
      ))
      continue
    }

    const current = documents.get(value.document) ?? initialDocument(machine)
    if (current.state !== value.from) {
      const fromShown = excerpt(value.from, 40)
      const currentShown = excerpt(current.state, 40)
      const offset = fromShown === currentShown ? firstDifferentUnit(value.from, current.state) : null
      const distinction = offset === null ? '' : ` The raw UTF-16 offset ${offset}: ${unitAt(value.from, offset)} versus ${unitAt(current.state, offset)}.`
      problems.push(fault(
        'event-state-mismatch',
        pointer,
        `Line ${number} moves "${excerpt(value.document, 60)}" from "${fromShown}", but replaying the log leaves it in "${currentShown}".${distinction}`,
      ))
      continue
    }
    if (value.revision !== current.revision + 1) {
      problems.push(fault(
        'event-revision-broken',
        pointer,
        `Line ${number} carries revision ${value.revision} for "${excerpt(value.document, 60)}"; replaying the log expects ${current.revision + 1}.`,
      ))
      continue
    }
    if (current.lastAtMs !== null && at.ms < current.lastAtMs) {
      problems.push(fault(
        'event-out-of-order',
        pointer,
        `Line ${number} is timestamped before the previous event for "${excerpt(value.document, 60)}"; an append-only log cannot move backwards in time.`,
        { evidence: `${excerpt(value.at, 40)} < ${excerpt(current.lastAt, 40)}` },
      ))
      continue
    }

    const event = Object.freeze({ ...value, scheduledFor: value.scheduledFor })
    events.push(event)
    byCommandId.set(value.commandId, event)
    documents.set(value.document, {
      state: value.to,
      revision: value.revision,
      scheduledFor: transition.setsSchedule ? value.scheduledFor : null,
      lastAt: value.at,
      lastAtMs: at.ms,
    })
  }

  return { events, documents, byCommandId, problems, trusted: problems.length === 0 }
}

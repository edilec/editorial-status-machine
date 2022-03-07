/**
 * Commands: what a caller asks for, and whether the machine allows it.
 *
 * A command names an action and an actor. It never names a destination state
 * it may reach, and it never names the roles it holds. Both of those come from
 * the machine, which is why a command cannot skip a state and cannot authorise
 * itself.
 *
 * The three refusals the caller most needs to tell apart stay separate, with
 * their own rule ids, because they call for completely different responses:
 *
 * - `transition-unauthorized` -- the actor exists but holds no role this
 *   transition allows. Ask someone else; retrying changes nothing.
 * - `transition-stale` -- the command was written against a revision that is
 *   no longer current. Someone else moved the document first; re-read and
 *   decide again. This is optimistic concurrency, and collapsing it into
 *   "invalid" would turn a lost update into a shrug.
 * - `transition-invalid` -- the action is not available from the state the
 *   document is actually in. The lifecycle says no; no retry and no role
 *   fixes it.
 *
 * Nothing here reads the clock: `nowMs` is passed in.
 */

import {
  actionsFrom, hasAction, isAuthorized, lookupTransition,
} from './machine.mjs'
import { byCodeUnit, excerpt, isIdentifier, isPlainObject, parseInstant } from './text.mjs'

export const COMMAND_KEYS = Object.freeze([
  'commandId', 'document', 'action', 'actor', 'at', 'expectedRevision', 'scheduledFor', 'note',
])

const REQUIRED_IDENTIFIERS = Object.freeze(['commandId', 'document', 'action', 'actor'])

function fault(ruleId, pointer, message, extra = {}) {
  return { ruleId, pointer, message, ...extra }
}

/**
 * Shape checks: everything decidable from the command and the injected clock
 * alone, before the machine or the log is consulted.
 *
 * Every shape problem is reported -- a command with three broken fields should
 * not need three runs to fix -- and a command with any shape problem is
 * rejected without being evaluated further. Judging a half-read command
 * against the lifecycle is how an unchecked command gets through.
 */
export function validateCommand(value, index, nowMs) {
  const pointer = `/commands/${index}`
  const problems = []
  if (!isPlainObject(value)) {
    problems.push(fault('command-invalid', pointer, 'A command must be a JSON object.'))
    return { ok: false, problems, command: null }
  }

  for (const key of Object.keys(value).sort(byCodeUnit)) {
    if (!COMMAND_KEYS.includes(key)) {
      problems.push(fault(
        'command-key-unknown',
        `${pointer}/${excerpt(key, 60)}`,
        `Key "${excerpt(key, 60)}" is not part of the command schema and was not interpreted.`,
        { suggestion: `Remove it, or correct it to one of: ${COMMAND_KEYS.join(', ')}.` },
      ))
    }
  }

  for (const field of REQUIRED_IDENTIFIERS) {
    if (!isIdentifier(value[field])) {
      problems.push(fault(
        'identifier-invalid',
        `${pointer}/${field}`,
        `Field "${field}" is not a usable identifier: it must be a non-empty, trimmed string of at most 200 characters with no control characters.`,
        {
          evidence: excerpt(
            typeof value[field] === 'string' ? value[field] : JSON.stringify(value[field]) ?? 'undefined',
            60,
          ),
        },
      ))
    }
  }

  if (!Object.hasOwn(value, 'expectedRevision')) {
    problems.push(fault(
      'command-revision-missing',
      `${pointer}/expectedRevision`,
      'Command declares no expectedRevision. A transition with no revision to check against cannot be stale, which is another way of saying it can silently overwrite someone else’s decision.',
      { suggestion: 'Read the document’s current revision and send it as expectedRevision.' },
    ))
  } else if (!Number.isInteger(value.expectedRevision) || value.expectedRevision < 0) {
    problems.push(fault(
      'command-revision-invalid',
      `${pointer}/expectedRevision`,
      'expectedRevision must be an integer of at least 0.',
      { evidence: excerpt(JSON.stringify(value.expectedRevision) ?? 'undefined', 40) },
    ))
  }

  const at = parseInstant(value.at)
  if (!at.ok) {
    problems.push(fault(
      'timestamp-invalid',
      `${pointer}/at`,
      'Field "at" must be an ISO-8601 UTC instant such as 2026-03-01T09:00:00Z. Local offsets are refused: a log that mixes them has no single order.',
      { evidence: excerpt(typeof value.at === 'string' ? value.at : JSON.stringify(value.at) ?? 'undefined', 40) },
    ))
  } else if (at.ms > nowMs) {
    problems.push(fault(
      'command-in-future',
      `${pointer}/at`,
      'Command is timestamped after the clock this run was given, so it claims to have happened in the future.',
      { evidence: excerpt(at.canonical, 40) },
      ))
  }

  let scheduledFor = null
  if (value.scheduledFor !== undefined && value.scheduledFor !== null) {
    const parsed = parseInstant(value.scheduledFor)
    if (!parsed.ok) {
      problems.push(fault(
        'timestamp-invalid',
        `${pointer}/scheduledFor`,
        'Field "scheduledFor" must be null or an ISO-8601 UTC instant.',
        {
          evidence: excerpt(
            typeof value.scheduledFor === 'string' ? value.scheduledFor : JSON.stringify(value.scheduledFor) ?? 'undefined',
            40,
          ),
        },
      ))
    } else {
      scheduledFor = parsed
    }
  }

  if (problems.length > 0) return { ok: false, problems, command: null }

  return {
    ok: true,
    problems,
    command: Object.freeze({
      commandId: value.commandId,
      document: value.document,
      action: value.action,
      actor: value.actor,
      at: at.canonical,
      atMs: at.ms,
      expectedRevision: value.expectedRevision,
      scheduledFor: scheduledFor === null ? null : scheduledFor.canonical,
      scheduledForMs: scheduledFor === null ? null : scheduledFor.ms,
    }),
  }
}

/**
 * Decide one structurally valid command against the machine and the document's
 * current projection.
 *
 * The check order below is documented and fixed, so the reason a command was
 * refused never depends on which branch happened to run first. Authorisation
 * is checked before staleness deliberately: an actor who may not perform a
 * transition should be told that, not handed the document's revision history
 * as a consolation prize.
 *
 * Idempotency is NOT decided here. A command whose id is already in the log is
 * a replay, and a replay is settled before this function is reached -- which
 * is the only reason a second `publish` with the same command id cannot
 * publish a second time. Evaluating it again would find it stale, which is the
 * wrong answer to "you already did this".
 */
export function evaluateCommand(machine, document, command, nowMs) {
  if (!machine.actors.has(command.actor)) {
    return {
      ok: false,
      ruleId: 'actor-unknown',
      message: `Actor "${excerpt(command.actor, 60)}" is not in the machine’s actor registry, so the roles it holds are unknown.`,
      suggestion: 'Register the actor with its roles, or correct the actor id. Roles are never taken from the command itself.',
    }
  }

  if (!hasAction(machine, command.action)) {
    return {
      ok: false,
      ruleId: 'action-unknown',
      message: `Action "${excerpt(command.action, 60)}" is not declared by any transition in this machine.`,
      evidence: `available from "${excerpt(document.state, 40)}": ${actionsFrom(machine, document.state).map((item) => excerpt(item, 40)).join(', ') || 'none'}`,
    }
  }

  const transition = lookupTransition(machine, document.state, command.action)
  if (transition === null) {
    return {
      ok: false,
      ruleId: 'transition-invalid',
      message: `Action "${excerpt(command.action, 60)}" is not available from state "${excerpt(document.state, 40)}", so this command would skip a state the lifecycle requires.`,
      evidence: `available from "${excerpt(document.state, 40)}": ${actionsFrom(machine, document.state).map((item) => excerpt(item, 40)).join(', ') || 'none'}`,
      suggestion: 'Walk the declared transitions in order, or add the transition to the machine if the lifecycle really allows it.',
    }
  }

  if (!isAuthorized(machine, command.actor, transition)) {
    return {
      ok: false,
      ruleId: 'transition-unauthorized',
      message: `Actor "${excerpt(command.actor, 60)}" holds no role that may perform "${excerpt(command.action, 40)}" from "${excerpt(document.state, 40)}".`,
      evidence: `allowed roles: ${transition.roles.map((role) => excerpt(role, 40)).join(', ')}`,
      suggestion: 'Have an actor holding one of those roles issue the command.',
    }
  }

  if (command.expectedRevision !== document.revision) {
    return {
      ok: false,
      ruleId: 'transition-stale',
      message: `Command expects revision ${command.expectedRevision} of "${excerpt(command.document, 60)}", but revision ${document.revision} is current; the document moved after this command was written.`,
      suggestion: 'Re-read the document, decide again against the current revision, and issue a new command with a new command id.',
    }
  }

  if (document.lastAtMs !== null && command.atMs < document.lastAtMs) {
    return {
      ok: false,
      ruleId: 'command-out-of-order',
      message: `Command is timestamped before the last recorded event for "${excerpt(command.document, 60)}"; an append-only log cannot move backwards in time.`,
      evidence: `${excerpt(command.at, 40)} < ${excerpt(document.lastAt, 40)}`,
    }
  }

  if (transition.setsSchedule && command.scheduledFor === null) {
    return {
      ok: false,
      ruleId: 'schedule-target-missing',
      message: `Transition "${excerpt(command.action, 40)}" sets a publication schedule, so the command must carry a scheduledFor instant.`,
    }
  }
  if (!transition.setsSchedule && command.scheduledFor !== null) {
    return {
      ok: false,
      ruleId: 'schedule-target-unexpected',
      message: `Transition "${excerpt(command.action, 40)}" does not set a publication schedule, so a scheduledFor instant would be silently discarded.`,
      suggestion: 'Remove scheduledFor, or use the transition that sets a schedule.',
    }
  }
  /**
   * A schedule is judged against the instant the command was issued, not
   * against the run's clock.
   *
   * "In the past" means the schedule had already passed when someone chose it.
   * Judging it against `now` instead would make the same batch decide
   * differently depending on when it is replayed, and would retroactively
   * invalidate a schedule that was perfectly sensible when it was set. The
   * run's clock decides the other half -- whether a schedule has come due --
   * which is `publish-before-schedule` below.
   */
  if (transition.setsSchedule && command.scheduledForMs <= command.atMs) {
    return {
      ok: false,
      ruleId: 'schedule-in-past',
      message: 'scheduledFor is not after the instant the command was issued, so the schedule would already have come due the moment it was set.',
      evidence: `${excerpt(command.scheduledFor, 40)} <= ${excerpt(command.at, 40)}`,
    }
  }

  if (transition.requiresSchedule) {
    if (document.scheduledFor === null) {
      return {
        ok: false,
        ruleId: 'schedule-missing',
        message: `Transition "${excerpt(command.action, 40)}" may only run against a scheduled document, and "${excerpt(command.document, 60)}" carries no schedule.`,
      }
    }
    const due = parseInstant(document.scheduledFor)
    if (!due.ok || due.ms > nowMs) {
      return {
        ok: false,
        ruleId: 'publish-before-schedule',
        message: `"${excerpt(command.document, 60)}" is scheduled for ${excerpt(document.scheduledFor, 40)}, which the clock this run was given has not yet reached.`,
        suggestion: 'Wait for the scheduled instant, or unschedule the document first.',
      }
    }
  }

  return {
    ok: true,
    transition,
    to: transition.to,
    scheduledFor: transition.setsSchedule ? command.scheduledFor : null,
  }
}

/** The documented order in which `evaluateCommand` refuses a command. */
export const EVALUATION_ORDER = Object.freeze([
  'actor-unknown',
  'action-unknown',
  'transition-invalid',
  'transition-unauthorized',
  'transition-stale',
  'command-out-of-order',
  'schedule-target-missing',
  'schedule-target-unexpected',
  'schedule-in-past',
  'schedule-missing',
  'publish-before-schedule',
])

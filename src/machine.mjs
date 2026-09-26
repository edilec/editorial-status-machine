/**
 * The state machine definition: states, transitions, roles, actors.
 *
 * The machine is declared as data, in a file, and compiled here. Two things
 * are deliberate:
 *
 * 1. Actor roles come from the machine's registry and from nowhere else. A
 *    command names an actor; it never carries the actor's roles. If a command
 *    could declare the roles it is judged against, authorisation would be a
 *    formality the caller fills in for itself.
 * 2. A command names an action, not a destination state. The machine decides
 *    the destination, so there is no expressible command that skips a state --
 *    the only way to reach `published` is to walk a transition that ends
 *    there, performed by a role the machine allows.
 *
 * Nothing here reads the filesystem, the clock or the environment.
 */

import { byCodeUnit, excerpt, isIdentifier, isPlainObject } from './text.mjs'

export const MACHINE_KEYS = Object.freeze([
  'schemaVersion', 'name', 'initialState', 'states', 'roles', 'actors', 'transitions',
])
export const STATE_KEYS = Object.freeze(['id', 'description', 'terminal'])
export const TRANSITION_KEYS = Object.freeze([
  'from', 'action', 'to', 'roles', 'setsSchedule', 'requiresSchedule', 'description',
])
export const ACTOR_KEYS = Object.freeze(['id', 'roles', 'description'])

export const MACHINE_SCHEMA_VERSION = '1'

/**
 * A problem carries `fatal` as well as a rule id.
 *
 * Severity says what a finding does to the exit code; `fatal` says whether the
 * machine can still be used to judge a command. They are different questions,
 * so they are recorded separately -- and a test asserts that every fatal
 * problem's rule is an `error`, because a fatal problem that only warned would
 * abandon the run while reporting nothing that fails it.
 */
function problem(ruleId, pointer, message, extra = {}) {
  return { ruleId, pointer, message, fatal: true, ...extra }
}

function warn(ruleId, pointer, message, extra = {}) {
  return { ruleId, pointer, message, fatal: false, ...extra }
}

function checkKeys(value, allowed, pointer, problems, ruleId) {
  for (const key of Object.keys(value).sort(byCodeUnit)) {
    if (!allowed.includes(key)) {
      problems.push(problem(
        ruleId,
        `${pointer}/${excerpt(key, 60)}`,
        `Key "${excerpt(key, 60)}" is not part of the machine schema and was not interpreted.`,
        { suggestion: `Remove it, or correct it to one of: ${allowed.join(', ')}.` },
      ))
    }
  }
}

function readIdentifierList(value, pointer, problems, label) {
  if (!Array.isArray(value)) {
    problems.push(problem('machine-field-invalid', pointer, `${label} must be an array.`))
    return null
  }
  const out = []
  const seen = new Set()
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    if (!isIdentifier(entry)) {
      problems.push(problem(
        'identifier-invalid',
        `${pointer}/${index}`,
        `${label} entry is not a usable identifier: it must be non-empty, at most 200 characters, and render unchanged; collapsing whitespace and invisible characters are not valid identities.`,
        { evidence: excerpt(typeof entry === 'string' ? entry : JSON.stringify(entry) ?? 'undefined', 60) },
      ))
      continue
    }
    if (seen.has(entry)) {
      problems.push(warn(
        'machine-duplicate-entry',
        `${pointer}/${index}`,
        `${label} lists "${excerpt(entry, 60)}" more than once; the repeat was ignored.`,
      ))
      continue
    }
    seen.add(entry)
    out.push(entry)
  }
  return out
}

function readBoolean(value, pointer, problems, label, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    problems.push(problem('machine-field-invalid', pointer, `${label} must be true or false.`))
    return fallback
  }
  return value
}

/**
 * Compile a parsed machine definition.
 *
 * Returns the compiled machine and every problem found. The machine is `null`
 * whenever a fatal problem was recorded: a half-understood transition table is
 * not something to judge a publish command against, and guessing at one is the
 * shape of defect that lets an unchecked command through.
 */
export function compileMachine(value, limits) {
  const problems = []
  if (!isPlainObject(value)) {
    problems.push(problem('machine-invalid', '/', 'The machine definition must be a JSON object.'))
    return { machine: null, problems }
  }
  checkKeys(value, MACHINE_KEYS, '', problems, 'machine-key-unknown')

  if (value.schemaVersion !== MACHINE_SCHEMA_VERSION) {
    problems.push(problem(
      'machine-schema-version',
      '/schemaVersion',
      `Machine schemaVersion must be the string "${MACHINE_SCHEMA_VERSION}".`,
      { evidence: excerpt(JSON.stringify(value.schemaVersion) ?? 'undefined', 40) },
    ))
  }

  const name = typeof value.name === 'string' && value.name.trim() !== '' ? value.name : null
  if (name === null) {
    problems.push(problem('machine-field-invalid', '/name', 'Machine name must be a non-empty string.'))
  }

  const roles = readIdentifierList(value.roles ?? [], '/roles', problems, 'roles')
  const roleSet = new Set(roles ?? [])

  // States -------------------------------------------------------------
  const states = new Map()
  if (!Array.isArray(value.states)) {
    problems.push(problem('machine-field-invalid', '/states', 'states must be an array of state objects.'))
  } else if (value.states.length > limits.maxStates) {
    problems.push(problem(
      'too-many-states',
      '/states',
      `Machine declares ${value.states.length} states, above the maxStates limit of ${limits.maxStates}; it was not compiled.`,
      { suggestion: 'Raise --max-states or split the lifecycle.' },
    ))
  } else {
    for (let index = 0; index < value.states.length; index += 1) {
      const entry = value.states[index]
      const pointer = `/states/${index}`
      if (!isPlainObject(entry)) {
        problems.push(problem('machine-field-invalid', pointer, 'Each state must be an object with an id.'))
        continue
      }
      checkKeys(entry, STATE_KEYS, pointer, problems, 'machine-key-unknown')
      if (!isIdentifier(entry.id)) {
        problems.push(problem(
          'identifier-invalid',
          `${pointer}/id`,
          'State id is not a usable identifier.',
          { evidence: excerpt(typeof entry.id === 'string' ? entry.id : JSON.stringify(entry.id) ?? 'undefined', 60) },
        ))
        continue
      }
      if (states.has(entry.id)) {
        problems.push(problem(
          'machine-state-duplicate',
          `${pointer}/id`,
          `State "${excerpt(entry.id, 60)}" is declared more than once.`,
        ))
        continue
      }
      const terminal = readBoolean(entry.terminal, `${pointer}/terminal`, problems, 'terminal', false)
      states.set(entry.id, { id: entry.id, terminal })
    }
    if (states.size === 0) problems.push(problem('machine-field-invalid', '/states', 'The machine declares no state.'))
  }

  // Actors -------------------------------------------------------------
  const actors = new Map()
  if (!Array.isArray(value.actors)) {
    problems.push(problem('machine-field-invalid', '/actors', 'actors must be an array of actor objects.'))
  } else if (value.actors.length > limits.maxActors) {
    problems.push(problem(
      'too-many-actors',
      '/actors',
      `Machine declares ${value.actors.length} actors, above the maxActors limit of ${limits.maxActors}; it was not compiled.`,
      { suggestion: 'Raise --max-actors or trim the registry.' },
    ))
  } else {
    for (let index = 0; index < value.actors.length; index += 1) {
      const entry = value.actors[index]
      const pointer = `/actors/${index}`
      if (!isPlainObject(entry)) {
        problems.push(problem('machine-field-invalid', pointer, 'Each actor must be an object with an id and roles.'))
        continue
      }
      checkKeys(entry, ACTOR_KEYS, pointer, problems, 'machine-key-unknown')
      if (!isIdentifier(entry.id)) {
        problems.push(problem(
          'identifier-invalid',
          `${pointer}/id`,
          'Actor id is not a usable identifier.',
          { evidence: excerpt(typeof entry.id === 'string' ? entry.id : JSON.stringify(entry.id) ?? 'undefined', 60) },
        ))
        continue
      }
      if (actors.has(entry.id)) {
        problems.push(problem(
          'machine-actor-duplicate',
          `${pointer}/id`,
          `Actor "${excerpt(entry.id, 60)}" is declared more than once; which set of roles applies would be ambiguous.`,
        ))
        continue
      }
      const held = readIdentifierList(entry.roles ?? [], `${pointer}/roles`, problems, 'actor roles')
      const granted = new Set()
      for (const role of held ?? []) {
        if (!roleSet.has(role)) {
          problems.push(problem(
            'machine-role-unknown',
            `${pointer}/roles`,
            `Actor "${excerpt(entry.id, 60)}" holds role "${excerpt(role, 60)}", which the machine does not declare.`,
            { suggestion: 'Declare the role in /roles, or correct the spelling.' },
          ))
          continue
        }
        granted.add(role)
      }
      actors.set(entry.id, granted)
    }
  }

  // Transitions --------------------------------------------------------
  const byFrom = new Map()
  const actions = new Set()
  const list = []
  if (!Array.isArray(value.transitions)) {
    problems.push(problem('machine-field-invalid', '/transitions', 'transitions must be an array of transition objects.'))
  } else if (value.transitions.length > limits.maxTransitions) {
    problems.push(problem(
      'too-many-transitions',
      '/transitions',
      `Machine declares ${value.transitions.length} transitions, above the maxTransitions limit of ${limits.maxTransitions}; it was not compiled.`,
      { suggestion: 'Raise --max-transitions or split the lifecycle.' },
    ))
  } else {
    for (let index = 0; index < value.transitions.length; index += 1) {
      const entry = value.transitions[index]
      const pointer = `/transitions/${index}`
      if (!isPlainObject(entry)) {
        problems.push(problem('machine-field-invalid', pointer, 'Each transition must be an object.'))
        continue
      }
      checkKeys(entry, TRANSITION_KEYS, pointer, problems, 'machine-key-unknown')

      let broken = false
      for (const field of ['from', 'action', 'to']) {
        if (!isIdentifier(entry[field])) {
          problems.push(problem(
            'identifier-invalid',
            `${pointer}/${field}`,
            `Transition ${field} is not a usable identifier.`,
            {
              evidence: excerpt(
                typeof entry[field] === 'string' ? entry[field] : JSON.stringify(entry[field]) ?? 'undefined',
                60,
              ),
            },
          ))
          broken = true
        }
      }
      if (broken) continue

      for (const field of ['from', 'to']) {
        if (states.size > 0 && !states.has(entry[field])) {
          problems.push(problem(
            'machine-state-unknown',
            `${pointer}/${field}`,
            `Transition ${field} names state "${excerpt(entry[field], 60)}", which the machine does not declare.`,
            { suggestion: 'Declare the state in /states, or correct the spelling.' },
          ))
          broken = true
        }
      }

      const allowed = readIdentifierList(entry.roles ?? [], `${pointer}/roles`, problems, 'transition roles')
      if (allowed !== null && allowed.length === 0) {
        problems.push(problem(
          'machine-transition-no-roles',
          `${pointer}/roles`,
          'Transition allows no role. An empty role list is refused rather than read as "anyone": a transition nobody may perform and a transition everybody may perform must not look the same.',
          { suggestion: 'List the roles that may perform this transition, or remove the transition.' },
        ))
        broken = true
      }
      for (const role of allowed ?? []) {
        if (!roleSet.has(role)) {
          problems.push(problem(
            'machine-role-unknown',
            `${pointer}/roles`,
            `Transition allows role "${excerpt(role, 60)}", which the machine does not declare.`,
            { suggestion: 'Declare the role in /roles, or correct the spelling.' },
          ))
          broken = true
        }
      }

      const setsSchedule = readBoolean(entry.setsSchedule, `${pointer}/setsSchedule`, problems, 'setsSchedule', false)
      const requiresSchedule = readBoolean(
        entry.requiresSchedule, `${pointer}/requiresSchedule`, problems, 'requiresSchedule', false,
      )
      if (setsSchedule && requiresSchedule) {
        problems.push(problem(
          'machine-schedule-contradiction',
          pointer,
          'A transition cannot both set a schedule and require one already to have come due.',
        ))
        broken = true
      }
      if (broken) continue

      const fromTable = byFrom.get(entry.from) ?? new Map()
      if (fromTable.has(entry.action)) {
        problems.push(problem(
          'machine-transition-duplicate',
          pointer,
          `Transition "${excerpt(entry.action, 60)}" from "${excerpt(entry.from, 60)}" is declared more than once; which destination applies would be ambiguous.`,
        ))
        continue
      }
      const transition = {
        from: entry.from,
        action: entry.action,
        to: entry.to,
        roles: Object.freeze([...allowed]),
        setsSchedule,
        requiresSchedule,
      }
      fromTable.set(entry.action, Object.freeze(transition))
      byFrom.set(entry.from, fromTable)
      actions.add(entry.action)
      list.push(transition)
    }
    if (list.length === 0) {
      problems.push(problem('machine-field-invalid', '/transitions', 'The machine declares no usable transition.'))
    }
  }

  // Initial state ------------------------------------------------------
  let initialState = null
  if (!isIdentifier(value.initialState)) {
    problems.push(problem(
      'identifier-invalid',
      '/initialState',
      'initialState is not a usable identifier.',
      {
        evidence: excerpt(
          typeof value.initialState === 'string' ? value.initialState : JSON.stringify(value.initialState) ?? 'undefined',
          60,
        ),
      },
    ))
  } else if (states.size > 0 && !states.has(value.initialState)) {
    problems.push(problem(
      'machine-initial-unknown',
      '/initialState',
      `initialState names "${excerpt(value.initialState, 60)}", which the machine does not declare as a state.`,
    ))
  } else {
    initialState = value.initialState
  }

  if (problems.some((item) => item.fatal)) return { machine: null, problems }

  // Shape warnings, reported only once the machine is known to be usable.
  const reachable = new Set([initialState])
  const queue = [initialState]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const transition of byFrom.get(current)?.values() ?? []) {
      if (reachable.has(transition.to)) continue
      reachable.add(transition.to)
      queue.push(transition.to)
    }
  }
  for (const state of [...states.keys()].sort(byCodeUnit)) {
    if (!reachable.has(state)) {
      problems.push(warn(
        'machine-state-unreachable',
        `/states/${excerpt(state, 60)}`,
        `State "${excerpt(state, 60)}" cannot be reached from "${excerpt(initialState, 60)}" by any declared transition.`,
        { suggestion: 'Add a transition that reaches it, or remove the state.' },
      ))
    }
    const outgoing = byFrom.get(state)?.size ?? 0
    if (outgoing === 0 && !states.get(state).terminal) {
      problems.push(warn(
        'machine-state-stranded',
        `/states/${excerpt(state, 60)}`,
        `State "${excerpt(state, 60)}" has no outgoing transition but is not declared terminal, so content can enter it and never leave.`,
        { suggestion: 'Add an outgoing transition, or mark the state "terminal": true.' },
      ))
    }
  }

  const machine = Object.freeze({
    name,
    initialState,
    states,
    roles: Object.freeze([...roleSet].sort(byCodeUnit)),
    actors,
    actions: Object.freeze([...actions].sort(byCodeUnit)),
    transitions: Object.freeze(list),
    byFrom,
  })
  return { machine, problems }
}

/** The transition a given action takes from a given state, or null. */
export function lookupTransition(machine, from, action) {
  return machine.byFrom.get(from)?.get(action) ?? null
}

/** Whether the machine declares this action anywhere at all. */
export function hasAction(machine, action) {
  return machine.actions.includes(action)
}

/** The actions available from a state, ordered by code unit. */
export function actionsFrom(machine, from) {
  return [...(machine.byFrom.get(from)?.keys() ?? [])].sort(byCodeUnit)
}

/**
 * Whether an actor holds one of the roles a transition allows.
 *
 * The roles are read from the machine's registry. The command is not consulted
 * and cannot be: an unknown actor holds nothing.
 */
export function isAuthorized(machine, actorId, transition) {
  const held = machine.actors.get(actorId)
  if (held === undefined) return false
  return transition.roles.some((role) => held.has(role))
}

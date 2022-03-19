/**
 * editorial-status-machine
 *
 * Decides whether each editorial command is allowed by an explicit lifecycle
 * machine, and appends the ones that are to a local, hash-chained,
 * append-only event log.
 *
 * Four properties are structural here rather than incidental:
 *
 * 1. **The clock is injected.** `now` is a required option. Nothing in `src/`
 *    calls `Date.now()` or constructs a current date, so the same inputs and
 *    the same `--now` always produce the same bytes -- including the
 *    scheduling decisions, which are the part a wall clock would quietly make
 *    unreproducible.
 * 2. **Idempotency is decided before anything else.** A command whose id is
 *    already in the log is a replay: it is not re-evaluated, it appends no
 *    event, and it cannot publish a second time.
 * 3. **Roles come from the machine.** A command names an actor. It never
 *    carries the roles it is judged against.
 * 4. **Unknown evidence is never a pass.** A machine that would not compile,
 *    a log whose chain does not verify, a file that would not decode: in every
 *    one of those the commands are left undecided, the report says so, and the
 *    status is `incomplete`.
 */

import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { evaluateCommand, validateCommand } from './commands.mjs'
import {
  GENESIS_HASH, buildEvent, commandHash, initialDocument, parseEventLog, serializeEvent,
} from './events.mjs'
import { compileMachine } from './machine.mjs'
import { byCodeUnit, decodeUtf8, excerpt, isPlainObject, parseInstant } from './text.mjs'

export const TOOL_ID = 'editorial-status-machine'
export const REPORT_SCHEMA_VERSION = '1'

/**
 * Bounds are part of the contract, not a safety net.
 *
 * A machine definition, a command batch and an event log are all ordinary
 * untrusted input: a generated 60 MB log, a machine with ten thousand states,
 * a batch that names a new document on every line. Every limit below is
 * explicit, overridable from the CLI, and reported by name when it is hit.
 * Exceeding one produces a finding and an `incomplete` report -- never a
 * quietly shorter answer, and never a pass.
 */
export const DEFAULT_LIMITS = Object.freeze({
  maxFileBytes: 1048576,
  maxCommands: 5000,
  maxEvents: 20000,
  maxDocuments: 2000,
  maxStates: 64,
  maxTransitions: 256,
  maxActors: 512,
})

/**
 * The authoritative rule severity table.
 *
 * Severity is the whole difference between a run that fails and one that
 * passes. Written as a literal at forty construction sites it drifts silently,
 * and flipping one of these to `warning` turns a refused publish into a green
 * build with every test still passing. Every finding takes its severity from
 * here, an unknown rule id throws, and `docs/lifecycle-rules.md` is asserted
 * against this table in both directions.
 */
export const RULE_SEVERITY = Object.freeze({
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

const ALLOWED_OPTIONS = Object.freeze(['commands', 'events', 'limits', 'machine', 'now', 'root'])

/**
 * The log is not inside the input root, so it has no relative path there. It
 * is reported under a fixed logical name instead of its resolved location:
 * `location.file` must never carry an absolute host path, and a log kept
 * outside the tree would otherwise be the one finding that leaks one.
 */
export const EVENT_LOG_LABEL = 'event-log'

const MESSAGE_LIMIT = 400
const SUGGESTION_LIMIT = 300
const LOCATION_LIMIT = 200

export function validateLimits(overrides = {}) {
  if (!isPlainObject(overrides)) throw new TypeError('Limits must be an object')
  const limits = { ...DEFAULT_LIMITS }
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, name)) throw new TypeError(`Unknown limit "${name}"`)
    if (!Number.isInteger(value) || value < 1) {
      throw new TypeError(`Limit "${name}" must be a positive integer`)
    }
    limits[name] = value
  }
  return Object.freeze(limits)
}

/**
 * Containment, checked on real paths.
 *
 * Refusing `../` and absolute strings is not confinement: a symbolic link
 * planted inside the declared root resolves out of the tree without ever
 * spelling a traversal. The over-correction is just as wrong, and this catalog
 * has shipped it too -- comparing a realpath'd root against a target that was
 * merely resolved refuses files that are genuinely inside a symlinked root. So
 * both sides come from `realpath` before they reach here.
 */
export function isInside(root, candidate) {
  if (candidate === root) return true
  return candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

const ANCESTOR_PROBE_LIMIT = 64

/**
 * The real path of something that may not exist yet.
 *
 * Both the declared inputs and the log destination need this: an input the run
 * was told to read may be absent, and the log usually does not exist at all on
 * a first run. The nearest existing ancestor is resolved and the remaining
 * segments are appended to it, so a symlinked parent directory is still
 * defeated -- that is how a destination "outside the tree" quietly becomes a
 * file written into the inputs the same run is reading.
 *
 * A path whose own entry exists but does not resolve is a dangling symbolic
 * link, not a missing file, and it is refused rather than treated as absent:
 * handing back the lexical path would hand back one that a later open follows
 * straight out of the tree the moment the link's target appears.
 */
async function resolveNearest(absolute, label) {
  const tail = []
  let probe = absolute

  for (let step = 0; step < ANCESTOR_PROBE_LIMIT; step += 1) {
    let real
    try {
      real = await realpath(probe)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw new TypeError(`${label} could not be resolved: ${error.code ?? 'unknown error'}`)
      }
      if (await lstat(probe).then(() => true, () => false)) {
        throw new TypeError(`${label} is a symbolic link with no target and was refused unresolved`)
      }
      const parent = dirname(probe)
      if (parent === probe) throw new TypeError(`${label} has no existing ancestor directory`)
      tail.unshift(basename(probe))
      probe = parent
      continue
    }
    return { real: tail.length === 0 ? real : join(real, ...tail), missing: tail.length > 0 }
  }
  throw new TypeError(`${label} is nested too deeply to resolve`)
}

/**
 * Resolve one declared input and refuse anything that is not really inside the root.
 *
 * An input that is named but absent is resolved as far as it does exist and
 * confined like any other. It is *not* a configuration error: the run has a
 * subject -- a root, a machine, a batch -- and one piece of evidence about it
 * could not be obtained, which is what `incomplete` exists to say. `readText`
 * reports it as `input-unreadable` and the run ends at exit 2 with a report on
 * stdout, rather than exit 2 with nothing for a consumer to parse.
 */
export async function resolveInput(rootReal, relativePath, label) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') {
    throw new TypeError(`${label} must be a non-empty path`)
  }
  const { real } = await resolveNearest(resolve(rootReal, relativePath), label)
  if (!isInside(rootReal, real)) {
    throw new TypeError(`${label} resolves outside the input root and was refused unread`)
  }
  const relative = real === rootReal ? '.' : real.slice(rootReal.endsWith(sep) ? rootReal.length : rootReal.length + 1)
  return { real, relative: relative.split(sep).join('/') }
}

/** Resolve the event log destination and refuse anything inside the input root. */
export async function resolveEventLog(rootReal, destination) {
  if (typeof destination !== 'string' || destination.trim() === '') {
    throw new TypeError('Event log destination must be a non-empty path')
  }
  const { real: resolved, missing } = await resolveNearest(resolve(destination), 'Event log destination')
  if (isInside(rootReal, resolved)) {
    throw new TypeError(
      'Event log destination is inside the input root; the log is written to and the root is read-only, so it must live elsewhere',
    )
  }
  if (!missing) {
    // A destination that exists must be a regular file. A directory is the
    // obvious mistake; a FIFO or a device node is the one that would hang the
    // append forever instead of failing.
    const info = await stat(resolved)
    if (info.isDirectory()) throw new TypeError('Event log destination is a directory, not a file')
    if (!info.isFile()) throw new TypeError('Event log destination is not a regular file')
  }
  return resolved
}

function createCollector() {
  return { rows: [], incomplete: false }
}

function record(collector, row) {
  collector.rows.push({ pointer: '/', index: 0, ...row })
}

/**
 * Build a finding, taking its severity from the one table.
 *
 * Every untrusted string is sanitised here -- file, pointer, message, evidence
 * and suggestion alike -- not only the evidence field. A tool in this catalog
 * sanitised evidence and left identifiers raw, so an id containing a newline
 * forged an extra line in the human report.
 */
export function createFinding(row) {
  const severity = RULE_SEVERITY[row.ruleId]
  if (severity === undefined) {
    throw new Error(
      `Rule "${row.ruleId}" is not in RULE_SEVERITY; add it to the table and to docs/lifecycle-rules.md.`,
    )
  }
  const finding = {
    ruleId: row.ruleId,
    severity,
    message: excerpt(row.message, MESSAGE_LIMIT),
    location: { file: excerpt(row.file, LOCATION_LIMIT), pointer: excerpt(row.pointer, LOCATION_LIMIT) },
  }
  if (row.evidence !== undefined && row.evidence !== '') finding.evidence = excerpt(row.evidence)
  if (row.suggestion !== undefined) finding.suggestion = excerpt(row.suggestion, SUGGESTION_LIMIT)
  return finding
}

/**
 * Read one file, reporting every way it could fail to become text.
 *
 * `null` means "this file was not read", and it is load-bearing: the caller
 * turns it into `logTrusted = false`, and a sentinel that answered `''`
 * instead would make a log that was never read replay as an EMPTY log --
 * commands already in it would be applied a second time and appended to the
 * very file the run refused to read. So the sentinel is pinned behaviourally,
 * in `test/unread-inputs.test.mjs`: a bounded-out and an unreadable log are
 * driven through the real entry point and the real binary, and the status, the
 * exit code, the counts and the bytes of the log afterwards are asserted.
 *
 * None of these paths sets `incomplete` itself. A file that did not become
 * text leaves the machine uncompiled, the log unverified or the batch unread,
 * and every one of those ends at `notEvaluated`, which sets the flag once. A
 * second assignment *of that flag* here would look like defence and be
 * untestable: no mutation of it could change an outcome, so no test could fail
 * when it was removed. The invariant that actually holds -- a run that did not
 * decide every command is `incomplete` -- is asserted directly instead.
 */
async function readText(collector, file, real, limits) {
  let info
  try {
    info = await stat(real)
  } catch (error) {
    record(collector, { file, ruleId: 'input-unreadable', message: `File could not be inspected: ${error.code ?? 'unknown error'}.` })
    return null
  }
  if (!info.isFile()) {
    record(collector, {
      file,
      ruleId: 'input-unreadable',
      message: 'Path is not a regular file, so nothing could be read from it.',
    })
    return null
  }
  if (info.size > limits.maxFileBytes) {
    record(collector, {
      file,
      ruleId: 'input-too-large',
      message: `File is ${info.size} bytes, above the maxFileBytes limit of ${limits.maxFileBytes}; it was not read.`,
      suggestion: 'Raise --max-file-bytes, or split the input.',
    })
    return null
  }
  let bytes
  try {
    bytes = await readFile(real)
  } catch (error) {
    record(collector, { file, ruleId: 'input-unreadable', message: `File could not be read: ${error.code ?? 'unknown error'}.` })
    return null
  }
  const decoded = decodeUtf8(bytes)
  if (!decoded.ok) {
    record(collector, {
      file,
      ruleId: 'input-not-utf8',
      message: 'File is not valid UTF-8; it was not parsed and nothing was read from it.',
      suggestion: 'Re-encode the file as UTF-8.',
    })
    return null
  }
  return decoded.text
}

function readJson(collector, file, text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    record(collector, {
      file,
      ruleId: 'input-not-json',
      message: `File is not valid JSON: ${excerpt(error.message, 120)}.`,
    })
    return { ok: false, value: null }
  }
}

function notEvaluated(collector, reason) {
  record(collector, {
    file: 'commands.json',
    ruleId: 'commands-not-evaluated',
    message: `No command was decided: ${reason}. A command judged against evidence this run could not obtain would not have been judged at all.`,
  })
  collector.incomplete = true
}

function projectDocuments(machine, documents) {
  const rows = [...documents.entries()].map(([document, state]) => ({
    document,
    state: state.state,
    revision: state.revision,
    scheduledFor: state.scheduledFor,
    lastAt: state.lastAt,
  }))
  rows.sort((left, right) => byCodeUnit(left.document, right.document))
  return { initialState: machine === null ? null : machine.initialState, documents: rows }
}

/**
 * Run the machine over a batch of commands.
 *
 * Reads three files, writes none: appending the accepted events is the
 * caller's decision and the caller's destination, and `appendable` says
 * whether appending is safe at all.
 */
export async function runEditorialMachine(options = {}) {
  if (!isPlainObject(options)) throw new TypeError('Options must be an object')
  for (const key of Object.keys(options)) {
    if (!ALLOWED_OPTIONS.includes(key)) throw new TypeError(`Unknown option "${key}"`)
  }
  const limits = validateLimits(options.limits ?? {})

  const now = parseInstant(options.now)
  if (!now.ok) {
    throw new TypeError('A clock is required: "now" must be an ISO-8601 UTC instant such as 2026-03-01T09:00:00Z')
  }

  if (typeof options.root !== 'string' || options.root.trim() === '') {
    throw new TypeError('An input root is required')
  }
  let rootReal
  try {
    rootReal = await realpath(resolve(options.root))
  } catch (error) {
    throw new TypeError(`Input root could not be read: ${error.code ?? 'unknown error'}`)
  }
  const rootInfo = await stat(rootReal)
  if (!rootInfo.isDirectory()) throw new TypeError('Input root must be a directory')

  const machinePath = await resolveInput(rootReal, options.machine, '--machine')
  const commandPath = await resolveInput(rootReal, options.commands, '--commands')
  const eventLogPath = options.events === undefined ? null : await resolveEventLog(rootReal, options.events)

  const collector = createCollector()

  // Machine ------------------------------------------------------------
  const machineText = await readText(collector, machinePath.relative, machinePath.real, limits)
  let machine = null
  if (machineText !== null) {
    const parsed = readJson(collector, machinePath.relative, machineText)
    if (parsed.ok) {
      const compiled = compileMachine(parsed.value, limits)
      machine = compiled.machine
      for (const item of compiled.problems) {
        record(collector, {
          file: machinePath.relative,
          pointer: item.pointer === '' ? '/' : item.pointer,
          ruleId: item.ruleId,
          message: item.message,
          ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
          ...(item.suggestion === undefined ? {} : { suggestion: item.suggestion }),
        })
      }
    }
  }

  // Event log ----------------------------------------------------------
  let priorEvents = []
  let documents = new Map()
  let byCommandId = new Map()
  let logTrusted = true
  let logRefusal = 'the event log did not verify, so the current state of every document in it is unknown'
  if (eventLogPath !== null && machine !== null) {
    // A log that does not exist yet is an empty log, not missing evidence: the
    // first run of a new lifecycle has nothing to replay. A log that exists and
    // cannot be read is the opposite, and is reported as such.
    let logText = ''
    let present = true
    try {
      await stat(eventLogPath)
    } catch (error) {
      if (error.code !== 'ENOENT') {
        record(collector, {
          file: EVENT_LOG_LABEL,
          ruleId: 'input-unreadable',
          message: `Event log could not be inspected: ${error.code ?? 'unknown error'}.`,
        })
        logTrusted = false
      }
      present = false
    }
    if (present) {
      const text = await readText(collector, EVENT_LOG_LABEL, eventLogPath, limits)
      if (text === null) logTrusted = false
      else logText = text
    }

    if (logTrusted) {
      const replayed = parseEventLog(logText, { machine, maxEvents: limits.maxEvents })
      for (const item of replayed.problems) {
        record(collector, {
          file: EVENT_LOG_LABEL,
          pointer: item.pointer,
          index: Number(/\/events\/(\d+)/.exec(item.pointer)?.[1] ?? 0),
          ruleId: item.ruleId,
          message: item.message,
          ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
          ...(item.suggestion === undefined ? {} : { suggestion: item.suggestion }),
        })
      }
      // No `incomplete` flag here on purpose. `parseEventLog` reports a problem
      // only when it distrusts the log, so `logTrusted` below is false whenever
      // this loop ran, and `notEvaluated` sets the flag once for the run. A
      // second assignment here would be a guarantee no test could ever kill --
      // comfort rather than defence.
      logTrusted = replayed.trusted
      /**
       * `maxDocuments` bounds the documents this run holds state for, and the
       * log is where most of them come from. Counting only the ones a command
       * names would leave the documented bound unenforced against the larger
       * half of the projection -- a limit that reports nothing while being
       * exceeded is worse than no limit, because the report says the run was
       * complete.
       */
      if (logTrusted && replayed.documents.size > limits.maxDocuments) {
        record(collector, {
          file: EVENT_LOG_LABEL,
          pointer: '/events',
          ruleId: 'too-many-documents',
          message: `The log projects ${replayed.documents.size} documents, above the maxDocuments limit of ${limits.maxDocuments}; it was not used and no command was decided against it.`,
          suggestion: 'Raise --max-documents, or split the lifecycle across separate logs.',
        })
        logTrusted = false
        logRefusal = `the log projects more documents than the maxDocuments limit of ${limits.maxDocuments} allows`
      }
      if (logTrusted) {
        priorEvents = replayed.events
        documents = replayed.documents
        byCommandId = replayed.byCommandId
      }
    }
  }

  // Commands -----------------------------------------------------------
  const commandText = await readText(collector, commandPath.relative, commandPath.real, limits)
  let commandList = null
  let commandCount = 0
  let commandFailure = 'the command batch could not be read'
  if (commandText !== null) {
    const parsed = readJson(collector, commandPath.relative, commandText)
    if (parsed.ok) {
      if (Array.isArray(parsed.value)) commandCount = parsed.value.length
      if (!Array.isArray(parsed.value)) {
        record(collector, {
          file: commandPath.relative,
          ruleId: 'commands-not-an-array',
          message: 'The command file must hold a JSON array of commands. Newline-delimited JSON is not accepted.',
        })
        commandFailure = 'the command file does not hold a JSON array'
      } else if (parsed.value.length > limits.maxCommands) {
        record(collector, {
          file: commandPath.relative,
          ruleId: 'too-many-commands',
          message: `The batch holds ${parsed.value.length} commands, above the maxCommands limit of ${limits.maxCommands}; none of them were decided.`,
          suggestion: 'Raise --max-commands, or split the batch.',
        })
        commandFailure = `the batch is above the maxCommands limit of ${limits.maxCommands}`
      } else {
        commandList = parsed.value
      }
    }
  }

  const decisions = []
  const newEvents = []
  let applied = 0
  let replayedCount = 0
  let rejected = 0

  if (machine === null) {
    notEvaluated(collector, 'the machine definition could not be compiled')
  } else if (!logTrusted) {
    notEvaluated(collector, logRefusal)
  } else if (commandList === null) {
    notEvaluated(collector, commandFailure)
  } else if (commandList.length === 0) {
    /**
     * Green on no evidence is a defect, not a clean bill of health. A batch
     * with no command decided nothing, so it is reported and the run is
     * `incomplete`: `pass` with `checked: 0` is not reachable.
     */
    record(collector, {
      file: commandPath.relative,
      ruleId: 'no-commands',
      message: 'The command batch is empty, so this run decided nothing and proved nothing about the lifecycle.',
      suggestion: 'Point --commands at the batch you meant to check.',
    })
    collector.incomplete = true
  } else {
    let nextSeq = priorEvents.length + 1
    let previousHash = priorEvents.length === 0 ? GENESIS_HASH : priorEvents[priorEvents.length - 1].hash
    const known = new Map(byCommandId)
    const seenDocuments = new Set(documents.keys())

    for (let index = 0; index < commandList.length; index += 1) {
      const raw = commandList[index]
      const validated = validateCommand(raw, index, now.ms)
      if (!validated.ok) {
        for (const item of validated.problems) {
          record(collector, {
            file: commandPath.relative,
            pointer: item.pointer,
            index,
            ruleId: item.ruleId,
            message: item.message,
            ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
            ...(item.suggestion === undefined ? {} : { suggestion: item.suggestion }),
          })
        }
        rejected += 1
        decisions.push({ index, commandId: null, document: null, outcome: 'rejected', ruleId: validated.problems[0].ruleId })
        continue
      }
      const command = validated.command

      /**
       * Idempotency first, before the machine is consulted at all.
       *
       * This is the single reason a repeated publish cannot publish twice. Had
       * the replay been evaluated instead, it would have been refused as stale
       * -- a different answer to a different question, and one that would have
       * made a retrying client look broken rather than safe.
       */
      const previous = known.get(command.commandId)
      if (previous !== undefined) {
        if (previous.commandHash !== commandHash(command)) {
          record(collector, {
            file: commandPath.relative,
            pointer: `/commands/${index}/commandId`,
            index,
            ruleId: 'command-replay-mismatch',
            message: `Command id "${excerpt(command.commandId, 60)}" was already recorded with different instructions, so this is a new command wearing a used id, not a retry.`,
            suggestion: 'Give the new instruction its own command id.',
          })
          rejected += 1
          decisions.push({
            index, commandId: command.commandId, document: command.document,
            outcome: 'rejected', ruleId: 'command-replay-mismatch',
          })
          continue
        }
        record(collector, {
          file: commandPath.relative,
          pointer: `/commands/${index}/commandId`,
          index,
          ruleId: 'command-replayed',
          message: `Command id "${excerpt(command.commandId, 60)}" was already applied at seq ${previous.seq}; it was recognised as a retry and appended no second event.`,
        })
        replayedCount += 1
        decisions.push({
          index, commandId: command.commandId, document: command.document,
          outcome: 'replayed', ruleId: 'command-replayed', seq: previous.seq,
        })
        continue
      }

      if (!seenDocuments.has(command.document) && seenDocuments.size >= limits.maxDocuments) {
        record(collector, {
          file: commandPath.relative,
          pointer: `/commands/${index}/document`,
          index,
          ruleId: 'too-many-documents',
          message: `Command names document number ${seenDocuments.size + 1}, above the maxDocuments limit of ${limits.maxDocuments}; this command and every command after it were left undecided.`,
          suggestion: 'Raise --max-documents, or split the batch by document.',
        })
        // Events already built stay valid and may be appended -- they record
        // commands that really were accepted. The run is `incomplete`, so no
        // consumer mistakes a half-applied batch for a finished one, and
        // re-running with a raised limit replays the applied commands by id
        // rather than applying them twice.
        collector.incomplete = true
        break
      }

      const state = documents.get(command.document) ?? initialDocument(machine)
      const verdict = evaluateCommand(machine, state, command, now.ms)
      if (!verdict.ok) {
        record(collector, {
          file: commandPath.relative,
          pointer: `/commands/${index}`,
          index,
          ruleId: verdict.ruleId,
          message: verdict.message,
          ...(verdict.evidence === undefined ? {} : { evidence: verdict.evidence }),
          ...(verdict.suggestion === undefined ? {} : { suggestion: verdict.suggestion }),
        })
        rejected += 1
        decisions.push({
          index, commandId: command.commandId, document: command.document,
          outcome: 'rejected', ruleId: verdict.ruleId,
        })
        continue
      }

      const event = buildEvent({
        seq: nextSeq,
        previousHash,
        command,
        transition: verdict.transition,
        revision: state.revision + 1,
        scheduledFor: verdict.scheduledFor,
      })
      newEvents.push(event)
      known.set(command.commandId, event)
      seenDocuments.add(command.document)
      documents.set(command.document, {
        state: verdict.to,
        revision: event.revision,
        scheduledFor: verdict.scheduledFor,
        lastAt: command.at,
        lastAtMs: command.atMs,
      })
      previousHash = event.hash
      nextSeq += 1
      applied += 1
      decisions.push({
        index, commandId: command.commandId, document: command.document,
        outcome: 'applied', ruleId: null, seq: event.seq,
      })
    }

  }

  collector.rows.sort((left, right) =>
    byCodeUnit(left.file, right.file) ||
    left.index - right.index ||
    byCodeUnit(left.pointer, right.pointer) ||
    byCodeUnit(left.ruleId, right.ruleId) ||
    byCodeUnit(left.message, right.message))

  const findings = collector.rows.map(createFinding)
  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length
  const status = collector.incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass'

  const projection = projectDocuments(machine, documents)

  const report = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status,
    summary: {
      checked: applied + replayedCount + rejected,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      commands: commandCount,
      applied,
      replayed: replayedCount,
      rejected,
      documents: projection.documents.length,
      priorEvents: priorEvents.length,
      newEvents: newEvents.length,
      states: machine === null ? 0 : machine.states.size,
      transitions: machine === null ? 0 : machine.transitions.length,
    },
    findings,
  }

  return {
    report,
    machineName: machine === null ? null : machine.name,
    newEvents,
    priorEventCount: priorEvents.length,
    eventLogPath,
    decisions,
    documents: projection.documents,
    /**
     * Appending is refused unless the log this run read verified end to end.
     * Writing new events onto a log whose chain is broken would extend a
     * history nobody can check and bury the break under fresh, valid-looking
     * lines.
     */
    appendable: machine !== null && logTrusted,
  }
}

/** Serialise new events as the lines to append. Never rewrites an existing line. */
export function eventLines(events) {
  if (events.length === 0) return ''
  return `${events.map((event) => serializeEvent(event)).join('\n')}\n`
}

const SEVERITY_WIDTH = 7

export function formatReport(report, extra = {}) {
  const { summary } = report
  const lines = [
    `machine ${excerpt(extra.machineName ?? 'not compiled', 80)}: ${summary.states} state(s), ${summary.transitions} transition(s).`,
    `${summary.checked} of ${summary.commands} command(s) decided: ${summary.applied} applied, ${summary.replayed} replayed, ${summary.rejected} rejected, status ${report.status}.`,
    `log: ${summary.priorEvents} prior event(s), ${summary.newEvents} new event(s), ${summary.documents} document(s) projected.`,
  ]
  for (const row of extra.documents ?? []) {
    const schedule = row.scheduledFor === null ? '' : ` scheduled ${excerpt(row.scheduledFor, 40)}`
    lines.push(`  ${excerpt(row.document, 80)} -> ${excerpt(row.state, 40)} @r${row.revision}${schedule}`)
  }
  for (const finding of report.findings) {
    lines.push(
      `${finding.severity.toUpperCase().padEnd(SEVERITY_WIDTH)} ` +
      `${finding.location.file}${finding.location.pointer} ${finding.ruleId} ${finding.message}`,
    )
  }
  return `${lines.join('\n')}\n`
}

export {
  COMMAND_KEYS, EVALUATION_ORDER, evaluateCommand, validateCommand,
} from './commands.mjs'
export {
  EVENT_KEYS, GENESIS_HASH, buildEvent, canonicalEventBody, commandHash,
  eventHash, initialDocument, parseEventLog, serializeEvent,
} from './events.mjs'
export {
  ACTOR_KEYS, MACHINE_KEYS, MACHINE_SCHEMA_VERSION, STATE_KEYS, TRANSITION_KEYS,
  actionsFrom, compileMachine, hasAction, isAuthorized, lookupTransition,
} from './machine.mjs'
export {
  EXCERPT_LIMIT, MAX_IDENTIFIER_LENGTH, byCodeUnit, decodeUtf8, excerpt,
  isIdentifier, isPlainObject, parseInstant,
} from './text.mjs'

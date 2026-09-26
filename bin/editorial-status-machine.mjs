#!/usr/bin/env node

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { eventLines, excerpt, formatReport, runEditorialMachine } from '../src/index.mjs'

const HELP = `editorial-status-machine

Decide editorial lifecycle commands against an explicit state machine -- states,
transitions, and the actor roles allowed to perform each -- and append the
accepted ones to a local, hash-chained, append-only event log. Nothing is
fetched and the clock is supplied, never read.

Usage:
  editorial-status-machine --root DIR --machine FILE --commands FILE --now INSTANT
                           [--events FILE] [--dry-run] [--json] [limits]

Options:
  --root DIR              Directory holding the machine and command files (required)
  --machine FILE          Machine definition, relative to --root (required)
  --commands FILE         JSON array of commands, relative to --root (required)
  --now INSTANT           The clock, as an ISO-8601 UTC instant, e.g.
                          2026-03-01T09:00:00Z (required)
  --events FILE           Append-only event log, read then appended to.
                          Resolved against --root, like --machine and
                          --commands, so the same command writes the same log
                          from any directory. The root is read-only, so the log
                          must land outside it: a relative path names its way
                          out (../events.jsonl) and an absolute path is taken as
                          given. A symbolic link at the destination, or one on
                          the way to it, is refused rather than followed, and so
                          is a destination that is the same file as an input --
                          a hard link included.
  --dry-run               Decide every command and append nothing
  --json                  Emit the machine-readable report on stdout
  --max-file-bytes N      Maximum bytes per input file (default 1048576)
  --max-commands N        Maximum commands in one batch (default 5000)
  --max-events N          Maximum events in the log (default 20000)
  --max-documents N       Maximum distinct documents (default 2000)
  --max-states N          Maximum states in the machine (default 64)
  --max-transitions N     Maximum transitions in the machine (default 256)
  --max-actors N          Maximum actors in the registry (default 512)
  -h, --help              Show this help

Every option that carries a value may be given only once: a repeated flag is a
configuration error, not a silent last-wins.

Three refusals stay separate, because they call for different responses:
  transition-unauthorized  the actor holds no role this transition allows
  transition-stale         the command names a revision that is no longer current
  transition-invalid       the action is not available from the document's state

A command whose id is already in the log is a retry: it is recognised before
anything else is checked, appends no second event, and cannot publish twice.

Exit codes:
  0  every command was accepted or recognised as a retry
  1  the batch was decided and at least one command was refused
  2  invalid usage or configuration (no report on stdout), or evidence that was
     missing, undecodable or bounded out (an "incomplete" report on stdout)
`

const LIMIT_FLAGS = new Map([
  ['--max-file-bytes', 'maxFileBytes'],
  ['--max-commands', 'maxCommands'],
  ['--max-events', 'maxEvents'],
  ['--max-documents', 'maxDocuments'],
  ['--max-states', 'maxStates'],
  ['--max-transitions', 'maxTransitions'],
  ['--max-actors', 'maxActors'],
])

const VALUE_FLAGS = new Map([
  ['--root', 'root'],
  ['--machine', 'machine'],
  ['--commands', 'commands'],
  ['--events', 'events'],
  ['--now', 'now'],
])

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = {
    root: null, machine: null, commands: null, events: null, now: null,
    json: false, dryRun: false, limits: {},
  }
  const given = new Set()

  /**
   * A flag that carries a value is accepted once.
   *
   * Letting it repeat discards the earlier value with no diagnostic, so
   * `--now A --now B` runs against a clock nobody asked for and
   * `--commands a --commands b` decides a batch nobody named. That is the same
   * defect as an ignored typo, which this tool already refuses.
   */
  const once = (name) => {
    if (given.has(name)) throw new Error(`${name} was given more than once`)
    given.add(name)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }

    if (argument === '--json') options.json = true
    else if (argument === '--dry-run') options.dryRun = true
    else if (VALUE_FLAGS.has(argument)) {
      once(argument)
      options[VALUE_FLAGS.get(argument)] = takeValue(argument)
    } else if (LIMIT_FLAGS.has(argument)) {
      once(argument)
      const raw = takeValue(argument)
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw new Error(`${argument} requires a positive integer`)
      options.limits[LIMIT_FLAGS.get(argument)] = Number(raw)
    // argv is the one untrusted string that reaches a stream without passing
    // through a finding, so it is flattened the same way one would be.
    } else throw new Error(`Unknown option "${excerpt(argument, 60)}"`)
  }

  for (const [flag, key] of [['--root', 'root'], ['--machine', 'machine'], ['--commands', 'commands'], ['--now', 'now']]) {
    if (options[key] === null) throw new Error(`${flag} is required`)
  }
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stdout.write(HELP)
    return 0
  }

  let result
  try {
    result = await runEditorialMachine({
      root: options.root,
      machine: options.machine,
      commands: options.commands,
      now: options.now,
      limits: options.limits,
      ...(options.events === null ? {} : { events: options.events }),
    })
  } catch (error) {
    // Configuration never had a subject to report on, so stdout stays empty.
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  const { report } = result

  /**
   * The refusal to append is decided first, and said out loud.
   *
   * Nested inside `newEvents.length > 0` it could never run: events are built
   * only when the machine compiled and the log verified, which is exactly when
   * appending is allowed. An unreachable guard is not defence -- no test can
   * kill it, so nothing notices when it stops being true. Checked first it is
   * reachable, it is the one line that tells a reader with a broken log why
   * their log did not grow, and the test that asserts that diagnostic fails if
   * the guard is removed.
   */
  if (result.eventLogPath !== null && !result.appendable) {
    process.stderr.write(
      'the event log was not appended to: this run could not obtain the evidence it needed, so it decided nothing to add.\n',
    )
  } else if (result.eventLogPath !== null && result.newEvents.length > 0) {
    if (options.dryRun) {
      process.stderr.write(`dry run: ${result.newEvents.length} event(s) were decided and not appended.\n`)
    } else {
      try {
        await mkdir(dirname(result.eventLogPath), { recursive: true })
        await appendFile(result.eventLogPath, eventLines(result.newEvents), { encoding: 'utf8', flag: 'a' })
        process.stderr.write(
          `appended ${result.newEvents.length} event(s) after ${result.priorEventCount} existing one(s).\n`,
        )
      } catch (error) {
        process.stderr.write(`the event log could not be appended to: ${error.code ?? error.message}\n`)
        return 2
      }
    }
  }

  process.stdout.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatReport(report, { machineName: result.machineName, documents: result.documents,
      statePointers: result.statePointers }))

  if (report.status === 'incomplete') {
    process.stderr.write(
      `incomplete: ${report.summary.checked} of ${report.summary.commands} command(s) were decided.\n`,
    )
    return 2
  }
  return report.status === 'fail' ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))

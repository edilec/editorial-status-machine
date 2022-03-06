# editorial-status-machine

Decide editorial lifecycle commands against an **explicit** state machine — declared states,
declared transitions, and the actor roles allowed to perform each — and append the accepted ones
to a local, hash-chained, append-only event log.

- **Repository:** [edilec/editorial-status-machine](https://github.com/edilec/editorial-status-machine)
- **Area:** Content & Publishing
- **License:** MIT
- Node ESM, `node >= 22`, **no dependencies** — runtime or development. Node built-ins only.

The reason to declare the lifecycle rather than let it emerge from code is that three very
different refusals stop looking alike:

| Rule | What happened | What to do |
| --- | --- | --- |
| `transition-unauthorized` | the actor exists but holds no role this transition allows | ask someone who holds one; retrying changes nothing |
| `transition-stale` | the command names a revision that is no longer current | someone moved the document first: re-read, decide again, use a new command id |
| `transition-invalid` | the action is not available from the state the document is in | the lifecycle says no; no role and no retry fixes it |

And a fourth thing that is not a refusal at all: a command whose id is already in the log is a
**retry**. It appends no second event and cannot publish twice.

## Install

```sh
npm install editorial-status-machine
```

Or run it from a checkout with `node bin/editorial-status-machine.mjs`.

## Use

```sh
editorial-status-machine \
  --root examples/clean \
  --machine machine.json \
  --commands commands.json \
  --events build/editorial-events.jsonl \
  --now 2026-03-10T12:00:00Z
```

```
machine edilec-editorial-lifecycle: 6 state(s), 9 transition(s).
10 of 10 command(s) decided: 9 applied, 1 replayed, 0 rejected, status pass.
log: 0 prior event(s), 9 new event(s), 2 document(s) projected.
  post-hello -> scheduled @r3 scheduled 2026-03-20T08:00:00.000Z
  post-roadmap -> retired @r6
INFO    commands.json/commands/9/commandId command-replayed Command id "cmd-014" was already
        applied at seq 8; it was recognised as a retry and appended no second event.
```

Run exactly the same command a second time and the log does not grow: all ten commands are
recognised as retries, `applied` is `0`, `replayed` is `10`, and the file is byte-for-byte what it
was. That is the property the tool exists for.

`--json` emits the machine-readable report on stdout; `--dry-run` decides everything and appends
nothing; `--help` prints the full flag list.

### As a library

```js
import { runEditorialMachine, eventLines } from 'editorial-status-machine'

const { report, newEvents, appendable, documents } = await runEditorialMachine({
  root: 'examples/clean',
  machine: 'machine.json',
  commands: 'commands.json',
  events: 'build/editorial-events.jsonl',
  now: '2026-03-10T12:00:00Z',
})
```

`runEditorialMachine` reads; it never writes. Appending `eventLines(newEvents)` is the caller's
decision, and `appendable` says whether it is safe — it is `false` whenever this run could not
verify what the log already held.

The pure pieces are exported too: `compileMachine`, `evaluateCommand`, `validateCommand`,
`parseEventLog`, `buildEvent`, `serializeEvent`, `eventHash`, `commandHash`, `parseInstant`.

## The clock is injected

`--now` is required. Nothing under `src/` calls `Date.now()` or constructs a current date, so
every scheduling decision — is this command from the future, is this schedule in the past, has
this scheduled document come due — is reproducible. The same inputs and the same `--now` produce
byte-identical stdout.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | every command was accepted or recognised as a retry | the report |
| `1` | the batch was decided and at least one command was refused | the report |
| `2` | invalid usage or configuration | **empty** |
| `2` | evidence missing, undecodable or bounded out | an `incomplete` report |

stdout carries the report and nothing else; diagnostics go to stderr. A consumer that pipes stdout
must handle it being empty on exit 2 — emitting a fake report for a run that never started would
be worse.

## Guarantees

Each of these has a test that fails when the line enforcing it is removed.

- **A repeated command id appends no second event.** Idempotency is settled before the machine is
  consulted, so a retry is never re-evaluated and never re-applied.
- **A used command id carrying different instructions is refused**, not swallowed as a duplicate.
- **Roles come from the machine.** A command names an actor and can never carry the roles it is
  judged against.
- **A command names an action, not a destination**, so no expressible command skips a state.
- **`pass` with `checked: 0` is not reachable.** An empty batch, a machine that would not compile,
  a log that would not verify and a bounded-out batch are all `incomplete`.
- **Nothing is appended to a log that did not verify.** Valid-looking lines on top of a broken
  chain bury the break.
- **The log is append-only.** No code path in this package rewrites, reorders or removes an event.
- **Every finding's severity comes from one frozen table**, asserted against the documented catalog
  in both directions and pinned again rule by rule.
- **Paths are confined on real paths, both sides.** A symlink out of the root is refused; a
  legitimate file reached through a symlinked root is not.
- **No wall clock, locale, `localeCompare`, random source, network access or filesystem
  enumeration order** affects the output.

## Limits and non-goals

Bounds are enforced and reported by name — `maxFileBytes`, `maxCommands`, `maxEvents`,
`maxDocuments`, `maxStates`, `maxTransitions`, `maxActors`. Exceeding one is `incomplete` with a
finding, never a quietly shorter answer.

What this tool **cannot** conclude:

- **That the declared lifecycle is a sensible editorial policy.** The machine is data. Declare a
  transition from `draft` straight to `published` and it will be allowed. This tool checks
  commands against the machine, not the machine against good sense.
- **That an actor is who the id says.** There is no authentication. The registry maps an id to
  roles; deciding who may issue commands under that id happens upstream.
- **That anything was published.** It records decisions. It never contacts a CMS, a CDN or a site,
  and there is no network access of any kind. A `published` event means the transition was
  allowed, not that a page is live.
- **That the log is complete.** A verified chain proves the events present were not altered and
  none was removed from the middle. Truncating the end leaves a shorter, perfectly valid chain —
  this tool sees a shorter history, not a tampered one.
- **That a schedule will fire.** Nothing here runs at the scheduled instant. A separate scheduler
  must issue the `publish` command; this tool then checks that the instant has been reached.
- **That concurrent writers are safe.** Revisions give optimistic concurrency within what the log
  records. Two processes appending to one log file at the same moment are outside what this tool
  arbitrates.
- **Anything at all about a run that ended `incomplete`.** That status is a statement that
  evidence was not obtained. It is not a soft pass.

Full rule catalog, machine and command schemas, log format and ordering rules:
[`docs/lifecycle-rules.md`](./docs/lifecycle-rules.md).

## Verify

```sh
npm run check
```

`lint` (`node --check` over every shipped file), `test` (`node --test`), `example` (the clean batch
end to end) and `pack:check`.

## License

MIT. See [LICENSE](./LICENSE).

# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- an explicit machine definition — states, transitions, roles and an actor
  registry — compiled from data, with every unknown key refused rather than
  ignored, empty transition role lists refused rather than read as "anyone",
  and unreachable or stranded states reported;
- command evaluation in a documented, fixed order that keeps the three refusals
  a caller must tell apart under their own rule ids: `transition-unauthorized`,
  `transition-stale` and `transition-invalid`, with authorisation checked
  before staleness so a refused actor is not handed the revision history;
- idempotency by command id, settled before the machine is consulted, so a
  repeated publish appends no second event and does not advance the revision,
  while a used id carrying different instructions is refused as
  `command-replay-mismatch` instead of being swallowed as a duplicate;
- optimistic concurrency through a required `expectedRevision` on every
  command, so a command written against a superseded revision cannot silently
  overwrite the decision that replaced it;
- scheduling rules driven entirely by an injected clock: `--now` is required
  and nothing under `src/` reads the wall clock. A schedule must be after the
  instant the command was issued, so replaying a batch later decides it the
  same way; whether a schedule has come due, and whether a command is
  timestamped in the future, are the two questions judged against `--now`;
- an append-only, hash-chained event log — SHA-256 over the previous hash and a
  positional canonical body — verified end to end on load for JSON shape, field
  vocabulary, identifiers, instants, sequence contiguity, chain integrity,
  agreement with the machine, duplicate command ids, per-document state and
  revision continuity, and per-document time order;
- refusal to append to a log that did not verify, and refusal to decide any
  command against one, because a command judged against an unknown state has
  not been judged;
- strict UTF-8 decoding with `TextDecoder('utf-8', { fatal: true })` on every
  input, the machine definition included, so whether a file is decodable is the
  decoder's decision and never an inference drawn from the decoded text;
- ISO-8601 UTC instant parsing that rebuilds the canonical form and compares
  it, so `2026-02-31T00:00:00Z` and `24:00:00` are refused rather than rolled
  silently forward, and local offsets are refused rather than converted;
- real-path confinement on both sides for `--machine` and `--commands`, and a
  `--events` destination refused if it resolves inside the read-only input
  root, checked against the nearest existing ancestor so a symlinked parent
  cannot put the log back among the inputs;
- explicit file-byte, command, event, document, state, transition and actor
  limits, each reported by name when hit and each making the run `incomplete`
  instead of truncating. `maxDocuments` counts the documents a verified log
  projects as well as the ones the batch names: a log already above the bound
  is reported and left unused rather than quietly exceeding the limit while the
  report claims a complete run;
- sanitisation of every untrusted string that reaches output — identifiers,
  paths, pointers and messages as well as `evidence` — so an id containing a
  line terminator cannot forge a line in the human report;
- a CLI with `--help`, `--json`, `--dry-run`, the required `--now` and the limit
  flags, the report on stdout, diagnostics on stderr, and exit codes 0 / 1 / 2
  — with an empty stdout for a configuration error and an `incomplete` report
  for evidence that could not be obtained, and with a repeated value-carrying
  flag refused instead of silently overwriting the earlier value;
- runnable clean and deliberately broken example batches; the clean batch ends
  by repeating an applied publish command, so idempotency is demonstrated by
  the example itself, and the broken batch spreads fifteen refusals over nine
  documents;
- the rule catalog, machine and command schemas, log format, ordering rule,
  limits, exit codes and the list of things this tool cannot conclude in
  `docs/lifecycle-rules.md`.

### Guaranteed

- No code path in this package rewrites, reorders or removes an event. The log
  is opened for append, and input files are never written to.
- A run that decided no command is `incomplete` and exits 2. `pass` with
  `checked: 0` is not reachable.
- A command never carries the roles it is judged against; they come from the
  machine's registry. A command never names a destination state; the machine
  decides where an action leads, so no expressible command skips a state.
- Every finding takes its severity from one frozen `ruleId -> severity` table;
  an unknown rule id throws, the table is asserted against the documented
  catalog in both directions, and every severity is additionally pinned rule by
  rule, so downgrading a rule in both the table and the catalog is still caught.
- No wall clock, locale, `localeCompare`, random source, network access or
  filesystem enumeration order affects the output.

No release has been published.

# Rules, limits and determinism

This document is the reference for what `editorial-status-machine` reads, what each rule means,
what the event log guarantees, and what the tool refuses to claim. Rule ids are stable: renaming
one is a breaking change and is recorded in the changelog.

## What is read, and what is written

Three inputs and one output:

| Path | Direction | Resolved against |
| --- | --- | --- |
| `--root` | read-only | the working directory |
| `--machine` | read-only | `--root`, and must really be inside it |
| `--commands` | read-only | `--root`, and must really be inside it |
| `--events` | read, then appended | the working directory, and must **not** be inside `--root` |

- Every input path is resolved with `realpath` and checked against the `realpath` of the root.
  Both sides are resolved: rejecting `../` is not confinement, because a symbolic link planted
  inside the root resolves out of the tree without ever spelling a traversal — and comparing a
  real root against a merely-resolved target is the opposite mistake, which refuses files that
  are genuinely inside a root reached through a symlink.
- A path that does not exist — an input that is simply absent, or a log destination on a first
  run — is resolved as far as it does exist: the nearest existing ancestor is resolved and the
  remaining segments appended. It is then confined exactly like any other path, so an absent
  file outside the root is still refused unread. A path whose own entry exists but does not
  resolve is a **dangling symbolic link**, not an absent file, and is refused unresolved:
  treating it as absent would hand back a path that the next open follows out of the tree the
  moment the link's target appears.
- The event log is written to and the root is read-only, so a log destination inside the root is
  refused. The nearest existing ancestor of the destination is resolved before the check, so a
  symlinked parent directory cannot put the log back inside the inputs.
- Every file is decoded with `TextDecoder('utf-8', { fatal: true })` — the machine definition
  included. Whether bytes are UTF-8 is the decoder's decision; the decoded text is never inspected
  to make that judgement.
- The log is opened for **append**. There is no code path in this tool that rewrites, reorders or
  removes an event, and none that edits a machine or a command file.

`location.file` in a finding is the input's path relative to `--root` — the path that was really
read, including for the finding that says no command was decided. The event log has no relative
path there, so its findings are reported under the fixed logical name `event-log`: a finding must
never carry an absolute host path.

## The clock

`--now` is **required** and is the only clock this tool has. Nothing under `src/` calls
`Date.now()` or constructs a current date. Both decisions that need a present moment — whether a
command is timestamped in the future, and whether a scheduled document has come due — are taken
against that value, so the same inputs and the same `--now` always produce byte-identical
output.

`--now`, every command `at`, and every `scheduledFor` must be an ISO-8601 **UTC** instant:
`YYYY-MM-DDTHH:MM:SSZ`, optionally with one to three fractional digits. Local offsets are refused
rather than converted — a log that mixes them has no single order. `Date.parse` alone is not a
validator (it accepts `2026-02-31T00:00:00Z` and hands back 3 March, and accepts `24:00:00` and
hands back the next midnight), so the canonical form is rebuilt from the parsed instant and
compared with the input.

## The machine definition

```json
{
  "schemaVersion": "1",
  "name": "edilec-editorial-lifecycle",
  "initialState": "draft",
  "roles": ["author", "editor", "publisher", "archivist"],
  "states": [
    { "id": "draft" },
    { "id": "retired", "terminal": true, "description": "Withdrawn. Terminal." }
  ],
  "actors": [{ "id": "alice", "roles": ["author"] }],
  "transitions": [
    { "from": "draft", "action": "submit", "to": "review", "roles": ["author", "editor"] },
    { "from": "approved", "action": "schedule", "to": "scheduled", "roles": ["publisher"],
      "setsSchedule": true },
    { "from": "scheduled", "action": "publish", "to": "published", "roles": ["publisher"],
      "requiresSchedule": true }
  ]
}
```

Top-level keys: `schemaVersion`, `name`, `initialState`, `states`, `roles`, `actors`,
`transitions`. State keys: `id`, `description`, `terminal`. Transition keys: `from`, `action`,
`to`, `roles`, `setsSchedule`, `requiresSchedule`, `description`. Actor keys: `id`, `roles`,
`description`. **Any other key is an error**, not a key to ignore: a one-character typo in
`requiresSchedule` would turn a scheduling rule off and a real refusal green.

Two design decisions are load-bearing:

- **A command names an action, never a destination state.** The machine decides where the action
  leads, so there is no expressible command that skips a state. The only way to reach `published`
  is to walk a transition that ends there.
- **Actor roles come from the machine's registry and from nowhere else.** A command names an
  actor; it never carries the roles it is judged against. A command that could declare its own
  roles would make authorisation a formality the caller fills in for itself.

`"roles": []` on a transition is refused rather than read as "anyone may": a transition nobody may
perform and a transition everybody may perform must not look the same.

`setsSchedule` and `requiresSchedule` are mutually exclusive. A transition that `setsSchedule`
requires the command to carry `scheduledFor` and records it on the document; every other
transition clears it. A transition that `requiresSchedule` may only run against a document that
carries a schedule the clock has already reached.

The two halves of a schedule are judged against different instants, on purpose:

- **Is the schedule sensible?** `scheduledFor` must be after the command's own `at` — the instant
  someone chose it. Judging that against `--now` instead would make the same batch decide
  differently depending on when it is replayed, and would retroactively refuse a schedule that was
  perfectly sensible when it was set.
- **Has the schedule come due?** That is judged against `--now`, and nothing else. It is the one
  question a clock is actually for.

## Commands

```json
[
  { "commandId": "cmd-001", "document": "post-hello", "action": "submit",
    "actor": "alice", "at": "2026-03-01T09:00:00Z", "expectedRevision": 0,
    "note": "free-form, ignored by the machine" }
]
```

The file must hold a **JSON array**. Newline-delimited JSON is not accepted.

Command keys: `commandId`, `document`, `action`, `actor`, `at`, `expectedRevision`,
`scheduledFor`, `note`. Any other key is an error.

`commandId`, `document`, `action` and `actor` are identifiers: non-empty strings of at most 200
characters, with no leading or trailing whitespace and none of the characters listed under
[Report](#report) below — C0, DEL, C1, U+2028, U+2029 and the bidi controls. `expectedRevision`
is required and must be an integer of at least 0.

Letters are not the issue: an id in Arabic, Hebrew or any other right-to-left script is perfectly
ordinary and is accepted, because those letters carry their own direction. It is the explicit
**overrides** that are refused.

### Idempotency comes first

A command whose `commandId` already appears in the log is a **retry**. It is recognised before the
machine is consulted at all: it appends no second event, it does not advance the revision, and it
is reported as `command-replayed` (`info`). This is the single reason a repeated publish cannot
publish twice. Had the retry been evaluated instead, it would have been refused as *stale* — a
different answer to a different question, and one that makes a correctly-retrying client look
broken.

A command that reuses an id with **different** instructions is not a retry. The recorded event
carries a hash of the command that produced it, and a mismatch is `command-replay-mismatch`.

Three details of that, stated so nobody has to infer them:

- A command's **identity** is `document`, `action`, `actor`, `at`, `expectedRevision` and
  `scheduledFor`. `note` is free-form prose that changes no decision, so it is not part of the
  identity: re-sending a command with a reworded note is a retry, not a conflict.
- Only **applied** commands enter the replay index. Re-sending a command id that was *refused* is
  evaluated again from scratch, and refused again for the same reason.
- Events are appended for the commands that were accepted **even when others in the same batch
  were refused, and even when a limit ended the batch early**. An accepted transition is a fact;
  withholding it would leave the log disagreeing with what the report says happened. Re-running
  with the refusals fixed replays the applied commands by id rather than applying them twice.

### The order commands are refused in

After the shape checks above, a command is evaluated against the machine and the document's
current projection in exactly this order, so the reason given never depends on which branch ran
first:

1. `actor-unknown`
2. `action-unknown`
3. `transition-invalid`
4. `transition-unauthorized`
5. `transition-stale`
6. `command-out-of-order`
7. `schedule-target-missing` / `schedule-target-unexpected`
8. `schedule-in-past`
9. `schedule-missing`
10. `publish-before-schedule`

Authorisation is checked **before** staleness on purpose: an actor who may not perform a
transition should be told that, not handed the document's revision history as a consolation prize.

The three refusals a caller most needs to tell apart keep their own rule ids, because they call
for completely different responses:

| Rule | What happened | What to do |
| --- | --- | --- |
| `transition-unauthorized` | the actor exists but holds no role this transition allows | ask someone who holds one; retrying changes nothing |
| `transition-stale` | the command names a revision that is no longer current | someone moved the document first: re-read, decide again, use a new command id |
| `transition-invalid` | the action is not available from the state the document is in | the lifecycle says no; no role and no retry fixes it |

Shape problems are all reported at once — a command with three broken fields should not need three
runs to fix — and a command with any shape problem is rejected without being evaluated further.
A structurally sound command produces at most one evaluation finding.

## The event log

One JSON object per line, in this field order:

```json
{"seq":1,"commandId":"cmd-001","document":"post-hello","action":"submit","from":"draft",
 "to":"review","actor":"alice","at":"2026-03-01T09:00:00.000Z","revision":1,
 "scheduledFor":null,"commandHash":"<64 hex>","hash":"<64 hex>"}
```

`hash` is `SHA-256(previousHash + "\n" + canonicalBody)`, where `canonicalBody` is the JSON of a
positional array of the other eleven fields and `previousHash` for the first event is sixty-four
zeroes. A positional array rather than an object on purpose: `JSON.stringify` of an object follows
insertion order, so a hash over an object would change its answer when a field moved in the
source, and a tamper-evidence scheme that does that is not tamper-evidence.

On load the whole log is verified: JSON shape, the field vocabulary, identifiers, instants,
`seq` contiguous from 1, the hash chain, that every state and transition it records is still
declared by the machine, that no command id appears twice, that each event leaves each document
where the next one starts, that revisions advance by exactly one, and that no document's
timestamps move backwards.

**Any** of those failing makes the run `incomplete` and stops the commands being decided at all.
If the log cannot be trusted, the current state of every document in it is unknown, and a command
judged against an unknown state has not been judged. Nothing is appended to a log that did not
verify: fresh, valid-looking lines on top of a broken chain bury the break.

A log that does not exist yet is an empty log, not missing evidence — the first run of a new
lifecycle has nothing to replay. A log that exists and cannot be read is the opposite, and is
reported as `input-unreadable`.

The documents a verified log projects count against `maxDocuments`, because they are the state
this run holds. A log already above the bound is reported as `too-many-documents`, is not used,
and leaves the batch undecided — counting only the documents a command in the batch names would
leave the bound unenforced against the larger half of the projection while the report still
claimed the run was complete. The batch's own counter starts from the log's documents, so a run
that already holds `maxDocuments` of them refuses to open one more.

## Report

```json
{
  "schemaVersion": "1",
  "tool": "editorial-status-machine",
  "status": "pass",
  "summary": {
    "checked": 10, "errors": 0, "warnings": 0, "info": 1,
    "commands": 10, "applied": 9, "replayed": 1, "rejected": 0,
    "documents": 2, "priorEvents": 0, "newEvents": 9,
    "states": 6, "transitions": 9
  },
  "findings": []
}
```

`status` is `pass`, `fail` or `incomplete`. `incomplete` is required whenever evidence was
missing, undecodable or bounded out; it is never interchangeable with `pass`.

`checked` counts the commands this run actually decided. **`pass` with `checked: 0` is not
reachable**: an empty batch is reported as `no-commands` and makes the run `incomplete`, and so
does every path that leaves commands undecided (`commands-not-evaluated`).

Findings are ordered by `(location.file, command or event index, location.pointer, ruleId,
message)`, all string comparisons by UTF-16 code unit. `localeCompare` is never used: it depends
on ICU data that differs between Node builds, and a report that is only deterministic on one
machine is not deterministic.

Every untrusted string that reaches a finding is flattened to one line, stripped of the characters
below and bounded — identifiers, paths and pointers as well as `evidence`. Sanitising the excerpt
and leaving the identifiers raw is how a document id containing a newline forges an extra line in a
human report, so identifiers refuse the same set outright rather than being cleaned up later.

| Class | Code points | Why |
| --- | --- | --- |
| C0 and DEL | U+0000–U+001F, U+007F | a newline forges a line; ESC starts a terminal escape; NUL cuts a value short |
| C1 | U+0080–U+009F | U+0085 (NEL) is a line break to many consumers; U+009B is the 8-bit CSI, a control introducer needing no ESC |
| Line and paragraph separators | U+2028, U+2029 | line breaks to JavaScript and to many text consumers |
| Bidi and isolate controls | U+200E, U+200F, U+202A–U+202E, U+2066–U+2069 | U+202E reverses everything printed after it, so a value can display as something other than the value that was compared, stored and hashed |

Tab, newline and carriage return are collapsed into a single space along with any other run of
whitespace; everything else above is replaced by a space. The CLI flattens an unknown option the
same way before naming it on stderr — argv is the one untrusted string that reaches a stream
without passing through a finding.

## Exit codes

| Code | Meaning | stdout |
| ---: | --- | --- |
| `0` | every command was accepted or recognised as a retry | the report |
| `1` | the batch was decided and at least one command was refused | the report |
| `2` | invalid usage or configuration | **empty** |
| `2` | evidence missing, undecodable or bounded out | an `incomplete` report |

A configuration error means the run never had a subject, so there is nothing to report about: an
unknown or repeated flag, a missing required one, an unusable `--now`, a root that cannot be read
or is not a directory, a path that resolves outside the root, a log destination inside it.

Everything else on exit 2 had a subject and failed to obtain evidence about it, which is exactly
what `incomplete` exists to say — and that includes an input that was **named but is not there**.
A machine file or a command file that does not exist is reported as `input-unreadable` against its
path relative to the root, in an `incomplete` report on stdout. A missing file is the commonest
shape of missing evidence, and answering it with an empty stdout would leave a consumer that pipes
the report nothing to parse in the one case it most needs to distinguish.

## Limits

Every limit is enforced, overridable, and reported by name when it is hit. Exceeding one is an
`incomplete` result with a finding — never a silent truncation, and never a pass.

| Limit | Flag | Default |
| --- | --- | ---: |
| `maxFileBytes` | `--max-file-bytes` | 1048576 |
| `maxCommands` | `--max-commands` | 5000 |
| `maxEvents` | `--max-events` | 20000 |
| `maxDocuments` | `--max-documents` | 2000 |
| `maxStates` | `--max-states` | 64 |
| `maxTransitions` | `--max-transitions` | 256 |
| `maxActors` | `--max-actors` | 512 |

Identifiers are additionally bounded at 200 characters, and excerpts in findings at 160.

Unknown configuration is refused everywhere: an unknown CLI flag, an unknown option key, an
unknown limit name, an unknown machine key, an unknown command key and an unknown event field are
all errors. A repeated value-carrying flag is a configuration error rather than a silent
last-wins.

## Rule catalog

| Rule | Severity | Meaning |
| --- | --- | --- |
| `action-unknown` | error | The action is not declared by any transition in the machine. |
| `actor-unknown` | error | The actor is not in the machine's registry, so its roles are unknown. |
| `command-in-future` | error | The command is timestamped after the clock this run was given. |
| `command-invalid` | error | The command is not a JSON object. |
| `command-key-unknown` | error | A command key outside the documented vocabulary; it was not interpreted. |
| `command-out-of-order` | error | The command is timestamped before the last event for its document. |
| `command-replay-mismatch` | error | A used command id carrying different instructions; not a retry. |
| `command-replayed` | info | The command id is already in the log; recognised as a retry, no second event. |
| `command-revision-invalid` | error | `expectedRevision` is not an integer of at least 0. |
| `command-revision-missing` | error | No `expectedRevision`, so the command can never be stale. |
| `commands-not-an-array` | error | The command file does not hold a JSON array. |
| `commands-not-evaluated` | warning | No command was decided, because evidence this run needed was not obtained. |
| `event-chain-broken` | error | An event does not match the hash chain: the log has been altered. |
| `event-command-duplicate` | error | The log itself records one command id twice. |
| `event-field-invalid` | error | An event field is missing, mistyped or outside the schema. |
| `event-line-invalid` | error | A log line is not a JSON object. |
| `event-out-of-order` | error | A document's events move backwards in time. |
| `event-revision-broken` | error | An event's revision does not follow the one before it. |
| `event-sequence-broken` | error | `seq` is not contiguous from 1: a line was removed, reordered or inserted. |
| `event-state-mismatch` | error | An event starts from a state the replay does not leave the document in. |
| `event-state-unknown` | error | An event names a state the machine no longer declares. |
| `event-transition-unknown` | error | An event records a transition the machine does not declare. |
| `identifier-invalid` | error | An identifier is empty, untrimmed, over 200 characters, or holds a control or bidi character. |
| `input-not-json` | error | An input file is not valid JSON. |
| `input-not-utf8` | error | An input file is not valid UTF-8; nothing was read from it. |
| `input-too-large` | error | An input file is above `maxFileBytes`; it was not read. |
| `input-unreadable` | error | An input file is absent, could not be opened, or is not a regular file. |
| `machine-actor-duplicate` | error | An actor id is declared twice, so which roles apply is ambiguous. |
| `machine-duplicate-entry` | warning | A role or list entry is repeated; the repeat was ignored. |
| `machine-field-invalid` | error | A machine field has the wrong type or is absent. |
| `machine-initial-unknown` | error | `initialState` names a state the machine does not declare. |
| `machine-invalid` | error | The machine definition is not a JSON object. |
| `machine-key-unknown` | error | A machine key outside the documented vocabulary; it was not interpreted. |
| `machine-role-unknown` | error | A transition or actor names a role the machine does not declare. |
| `machine-schedule-contradiction` | error | A transition both sets a schedule and requires one to have come due. |
| `machine-schema-version` | error | `schemaVersion` is not the string `"1"`. |
| `machine-state-duplicate` | error | A state id is declared twice. |
| `machine-state-stranded` | warning | A non-terminal state has no outgoing transition, so content can never leave it. |
| `machine-state-unknown` | error | A transition names a state the machine does not declare. |
| `machine-state-unreachable` | warning | No declared transition reaches the state from `initialState`. |
| `machine-transition-duplicate` | error | One `(from, action)` pair leads to two destinations. |
| `machine-transition-no-roles` | error | A transition allows no role; an empty list is refused, not read as "anyone". |
| `no-commands` | warning | The batch is empty, so the run decided nothing and proved nothing. |
| `publish-before-schedule` | error | The document's schedule has not been reached by the given clock. |
| `schedule-in-past` | error | `scheduledFor` is not after the instant the command was issued. |
| `schedule-missing` | error | A transition requiring a schedule was issued against a document with none. |
| `schedule-target-missing` | error | A scheduling transition carried no `scheduledFor`. |
| `schedule-target-unexpected` | error | A non-scheduling transition carried a `scheduledFor` that would be discarded. |
| `timestamp-invalid` | error | An instant is not ISO-8601 UTC, or names a date that does not exist. |
| `too-many-actors` | error | The registry is above `maxActors`; the machine was not compiled. |
| `too-many-commands` | error | The batch is above `maxCommands`; no command was decided. |
| `too-many-documents` | error | `maxDocuments` was reached — by the log's projection, or by the batch; nothing past it was decided. |
| `too-many-events` | error | The log is above `maxEvents`; it was not replayed. |
| `too-many-states` | error | The machine is above `maxStates`; it was not compiled. |
| `too-many-transitions` | error | The machine is above `maxTransitions`; it was not compiled. |
| `transition-invalid` | error | The action is not available from the document's current state. |
| `transition-stale` | error | `expectedRevision` is not the document's current revision. |
| `transition-unauthorized` | error | The actor holds no role this transition allows. |

## What this tool cannot conclude

- **That the lifecycle in the file is the lifecycle the organisation runs.** The machine is data.
  If it declares a transition from `draft` straight to `published`, this tool will happily allow
  it. It checks commands against the declared machine; it has no opinion about whether the
  declared machine is a sensible editorial policy.
- **That an actor is who the id says.** There is no authentication here. The registry maps an id
  to roles; who is allowed to issue commands under that id is somebody else's problem, upstream.
- **That anything was actually published.** This tool records decisions. It never contacts a CMS,
  a CDN or a site, and a `published` event means "the machine allowed the transition", not "the
  page is live".
- **That the log is complete.** A verified chain proves that the events present have not been
  altered and that none was removed from the middle. Truncating the log at the end leaves a
  shorter, perfectly valid chain: this tool sees a shorter history, not a tampered one. Keep the
  authoritative copy somewhere with its own integrity.
- **That a schedule will fire.** `scheduled` is a state with an instant attached. Nothing here
  runs at that instant; a separate scheduler must issue the `publish` command, and this tool will
  then check that the instant has been reached.
- **That concurrent writers are safe.** Revisions give optimistic concurrency *within* what the
  log records. Two processes appending to the same log file at the same moment are outside what
  this tool arbitrates; give one writer the log, or put a lock in front of it.
- **Anything about a run that ended `incomplete`.** An `incomplete` report is a statement that
  evidence was not obtained. It is not a soft pass, and no count inside it should be read as one.

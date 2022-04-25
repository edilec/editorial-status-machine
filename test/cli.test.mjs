import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { CLI, NOW, TO_PUBLISHED, command, projectDirectory, workspace } from './support.mjs'

const run = promisify(execFile)

/** Run the real binary and report what actually reached each stream. */
async function cli(args, cwd = projectDirectory) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

const CLEAN = ['--root', 'examples/clean', '--machine', 'machine.json', '--commands', 'commands.json']
const BROKEN = ['--root', 'examples/broken', '--machine', 'machine.json', '--commands', 'commands.json']

test('--help prints usage on stdout and exits 0', async () => {
  const result = await cli(['--help'])
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /^editorial-status-machine/)
  assert.match(result.stdout, /--now INSTANT/)
  assert.match(result.stdout, /transition-unauthorized/)
  assert.match(result.stdout, /transition-stale/)
  assert.match(result.stdout, /transition-invalid/)
})

test('-h is the same as --help, and wins over other arguments', async () => {
  assert.equal((await cli(['-h'])).stdout, (await cli(['--help'])).stdout)
  assert.equal((await cli(['--root', 'nowhere', '-h'])).code, 0)
})

test('the clean example passes, with the report on stdout and nothing else', async () => {
  const result = await cli([...CLEAN, '--now', NOW, '--json', '--dry-run'])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.summary.rejected, 0)
  assert.equal(report.summary.applied, 9)
  assert.equal(report.summary.replayed, 1)
  assert.deepEqual(report.findings.map((item) => item.ruleId), ['command-replayed'])
})

test('visually empty default-ignorable actor identities cannot authorize clean commands', async () => {
  const machine = JSON.parse(await readFile(join(projectDirectory, 'examples/clean/machine.json'), 'utf8'))
  const commands = JSON.parse(await readFile(join(projectDirectory, 'examples/clean/commands.json'), 'utf8'))
  await workspace(async ({ root }) => {
    const argv = ['--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--now', NOW, '--json', '--dry-run']
    const good = await cli(argv)
    assert.equal(good.code, 0)
    assert.equal(JSON.parse(good.stdout).summary.applied, 9)
    for (const invisible of ['\u034f', '\ufe0f']) {
      const changedMachine = structuredClone(machine)
      const changedCommands = structuredClone(commands)
      changedMachine.actors.find(actor => actor.id === 'alice').id = invisible
      for (const item of changedCommands) if (item.actor === 'alice') item.actor = invisible
      await workspace(async ({ root: changedRoot }) => {
        const result = await cli(['--root', changedRoot, '--machine', 'machine.json',
          '--commands', 'commands.json', '--now', NOW, '--json', '--dry-run'])
        assert.equal(result.code, 2)
        const report = JSON.parse(result.stdout)
        assert.equal(report.status, 'incomplete')
        assert.equal(report.summary.applied, 0)
        assert.equal(report.findings.some(f => f.ruleId === 'identifier-invalid'), true)
        assert.equal(result.stdout.includes(invisible), false)
      }, { machine: changedMachine, commands: changedCommands })
    }
  }, { machine, commands })
})

test('the broken example fails with exit 1 and keeps the three refusals distinct', async () => {
  const result = await cli([...BROKEN, '--now', NOW, '--json'])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')

  const found = report.findings.map((item) => item.ruleId)
  for (const ruleId of [
    'transition-unauthorized', 'transition-stale', 'transition-invalid',
    'actor-unknown', 'action-unknown', 'command-replay-mismatch',
    'command-in-future', 'command-key-unknown', 'command-revision-missing',
    'command-out-of-order', 'schedule-in-past', 'schedule-target-unexpected',
    'publish-before-schedule', 'identifier-invalid', 'timestamp-invalid',
    'machine-state-stranded', 'machine-state-unreachable',
  ]) {
    assert.ok(found.includes(ruleId), `the broken example no longer demonstrates ${ruleId}`)
  }
  assert.equal(found.filter((item) => item === 'transition-unauthorized').length, 1)
})

test('the human report goes to stdout when --json is absent', async () => {
  const result = await cli([...CLEAN, '--now', NOW, '--dry-run'])
  assert.equal(result.code, 0)
  assert.match(result.stdout, /^machine edilec-editorial-lifecycle: 6 state\(s\), 9 transition\(s\)\./)
  assert.match(result.stdout, /post-hello -> scheduled @r3 scheduled 2026-03-20T08:00:00\.000Z/)
  assert.throws(() => JSON.parse(result.stdout))
})

test('an unknown flag is a configuration error: stdout stays empty', async () => {
  const result = await cli([...CLEAN, '--now', NOW, '--verbose'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /Unknown option "--verbose"/)
})

test('a missing required flag is a configuration error', async () => {
  for (const [args, message] of [
    [[...CLEAN], /--now is required/],
    [['--machine', 'machine.json', '--commands', 'c.json', '--now', NOW], /--root is required/],
    [['--root', 'examples/clean', '--commands', 'commands.json', '--now', NOW], /--machine is required/],
    [['--root', 'examples/clean', '--machine', 'machine.json', '--now', NOW], /--commands is required/],
  ]) {
    const result = await cli(args)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, message)
  }
})

test('a repeated value-carrying flag is refused rather than silently last-wins', async () => {
  const result = await cli([...CLEAN, '--now', NOW, '--now', '2026-04-01T00:00:00Z'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--now was given more than once/)

  const repeatedRoot = await cli([...CLEAN, '--root', 'examples/broken', '--now', NOW])
  assert.equal(repeatedRoot.code, 2)
  assert.match(repeatedRoot.stderr, /--root was given more than once/)
})

test('a flag missing its value, and a bad limit value, are configuration errors', async () => {
  const missing = await cli([...CLEAN, '--now'])
  assert.equal(missing.code, 2)
  assert.match(missing.stderr, /--now requires a value/)

  for (const value of ['0', 'many', '-1', '1.5']) {
    const result = await cli([...CLEAN, '--now', NOW, '--max-commands', value])
    assert.equal(result.code, 2, value)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--max-commands requires (a value|a positive integer)/)
  }
})

test('an unusable clock is a configuration error with an empty stdout', async () => {
  for (const value of ['today', '2026-02-31T00:00:00Z', '2026-03-01T09:00:00+05:30']) {
    const result = await cli([...CLEAN, '--now', value])
    assert.equal(result.code, 2, value)
    assert.equal(result.stdout, '', value)
    assert.match(result.stderr, /clock is required/)
  }
})

test('an unreadable input yields exit 2 with an incomplete report on stdout', async () => {
  await workspace(async ({ root, log }) => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'commands.json'), '[ broken', 'utf8')
    const result = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--now', NOW, '--events', log, '--json',
    ])
    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')
    assert.ok(report.findings.some((item) => item.ruleId === 'input-not-json'))
    assert.match(result.stderr, /incomplete: 0 of 0 command\(s\) were decided/)
  }, { commands: TO_PUBLISHED })
})

test('an input named but absent yields exit 2 with an incomplete report on stdout', async () => {
  // The two shapes of exit 2, told apart: a file that is simply not there is
  // evidence the run failed to obtain, so stdout carries a report a consumer
  // can parse. A flag that makes no sense leaves the run with no subject at
  // all, and stdout stays empty.
  await workspace(async ({ root }) => {
    const missing = await cli([
      '--root', root, '--machine', 'absent.json', '--commands', 'commands.json',
      '--now', NOW, '--json',
    ])
    assert.equal(missing.code, 2)
    const report = JSON.parse(missing.stdout)
    assert.equal(report.status, 'incomplete')
    assert.equal(report.summary.checked, 0)
    const unreadable = report.findings.filter((item) => item.ruleId === 'input-unreadable')
    assert.equal(unreadable.length, 1)
    assert.equal(unreadable[0].location.file, 'absent.json')
    assert.match(missing.stderr, /incomplete: 0 of 3 command\(s\) were decided/)

    const configuration = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--now', 'whenever', '--json',
    ])
    assert.equal(configuration.code, 2)
    assert.equal(configuration.stdout, '', 'a run with no subject has nothing to report')
  }, { commands: TO_PUBLISHED })
})

test('a log destination inside the input root is refused before anything is read', async () => {
  // Relative to --root, like every other path option, so a bare name lands in
  // the root -- which is read-only.
  const result = await cli([...CLEAN, '--now', NOW, '--events', 'events.jsonl'])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /inside the input root/)
})

test('--events is resolved against --root, so one command writes one log from any directory', async () => {
  /*
   * Against the working directory it did not. The same command run from two
   * places wrote two logs, each with its own hash chain claiming to be the
   * history of the same documents, and neither of them saying so. Running it
   * from inside this repository put an untracked events.jsonl in the checkout.
   */
  await workspace(async ({ base, root }) => {
    const elsewhere = join(base, 'elsewhere')
    await mkdir(elsewhere)
    const argv = [
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--now', NOW, '--events', '../events.jsonl',
    ]

    const first = await cli(argv, base)
    assert.equal(first.code, 0)
    assert.match(first.stderr, /appended 3 event\(s\) after 0 existing one\(s\)/)

    const second = await cli(argv, elsewhere)
    assert.equal(second.code, 0)
    assert.doesNotMatch(second.stderr, /appended/, 'it found the same log, so every command was a retry')

    assert.deepEqual(await readdir(elsewhere), [], 'the working directory is not a log destination')
    const log = await readFile(join(base, 'events.jsonl'), 'utf8')
    assert.equal(log.trimEnd().split('\n').length, 3, 'one chain, not two')
  }, { commands: TO_PUBLISHED })
})

test('an input that escapes the root is refused before anything is read', async () => {
  const result = await cli([
    '--root', 'examples/clean', '--machine', 'machine.json',
    '--commands', '../broken/commands.json', '--now', NOW,
  ])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--commands resolves outside the input root/)
})

test('a run that could not obtain its evidence says the log was not appended to', async () => {
  // The refusal to append is reported, not left to be inferred from an exit
  // code. Both shapes reach it: a log this run could not verify, and a machine
  // it could not compile to verify one with.
  await workspace(async ({ root, log }) => {
    const { writeFile } = await import('node:fs/promises')
    const args = [
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--now', NOW, '--events', log, '--json',
    ]

    const first = await cli(args)
    assert.equal(first.code, 0)
    assert.match(first.stderr, /appended 3 event\(s\)/)
    const seeded = await readFile(log, 'utf8')

    await writeFile(log, `not json\n${seeded}`, 'utf8')
    const broken = await cli(args)
    assert.equal(broken.code, 2)
    assert.match(broken.stderr, /the event log was not appended to/)
    assert.equal(broken.stderr.includes('appended 3'), false)
    assert.equal(await readFile(log, 'utf8'), `not json\n${seeded}`, 'the log must not have grown')

    await writeFile(join(root, 'machine.json'), '{ broken', 'utf8')
    const uncompiled = await cli(args)
    assert.equal(uncompiled.code, 2)
    assert.match(uncompiled.stderr, /the event log was not appended to/)
  }, { commands: TO_PUBLISHED })
})

test('the CLI creates the log directory it was pointed at, and appends to it', async () => {
  await workspace(async ({ base, root }) => {
    const log = join(base, 'nested', 'deeper', 'events.jsonl')
    const args = [
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--now', NOW, '--events', log,
    ]
    const first = await cli(args)
    assert.equal(first.code, 0)
    assert.match(first.stderr, /appended 3 event\(s\) after 0 existing one\(s\)\./)
    assert.equal((await readFile(log, 'utf8')).trimEnd().split('\n').length, 3)

    const second = await cli(args)
    assert.equal(second.code, 0)
    assert.equal(second.stderr.includes('appended'), false)
    assert.equal((await readFile(log, 'utf8')).trimEnd().split('\n').length, 3)
  }, { commands: TO_PUBLISHED })
})

test('stdout is a JSON document and stderr never carries report data', async () => {
  const result = await cli([...BROKEN, '--now', NOW, '--json'])
  assert.doesNotThrow(() => JSON.parse(result.stdout))
  assert.equal(result.stderr, '', 'a decided batch has nothing to say on stderr')
})

test('exit 1 and exit 2 are told apart by status, not by guesswork', async () => {
  await workspace(async ({ root, log }) => {
    const base = ['--root', root, '--machine', 'machine.json', '--commands', 'commands.json', '--now', NOW, '--json']
    const failed = await cli([...base, '--events', log])
    assert.equal(failed.code, 1)
    assert.equal(JSON.parse(failed.stdout).status, 'fail')

    const bounded = await cli([...base, '--events', log, '--max-commands', '1'])
    assert.equal(bounded.code, 2)
    assert.equal(JSON.parse(bounded.stdout).status, 'incomplete')
  }, { commands: [command({ actor: 'dana' }), command({ commandId: 'c-2', actor: 'alice' })] })
})

test('a log that exists but cannot be inspected is named by its label, never by its host path', async () => {
  /*
   * This construction site was documented in test/confinement.test.mjs as
   * unreachable, and that was wrong. resolveEventLog stats the destination
   * itself, but a path whose PARENT is a regular file fails with ENOTDIR at the
   * later stat, inside the run.
   *
   * The finding must name the log by its label. An absolute host path in a
   * report is a leak into whatever CI system reads it, and this was the one
   * finding able to carry one.
   */
  await workspace(async ({ base, root }) => {
    const result = await cli([
      '--root', root,
      '--machine', 'machine.json',
      '--commands', 'commands.json',
      '--now', NOW,
      '--events', join(base, 'regular.txt', 'log.jsonl'),
      '--json',
    ])

    assert.equal(result.code, 2)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'incomplete')

    const finding = report.findings.find((item) => item.ruleId === 'input-unreadable')
    assert.ok(finding, 'the uninspectable log must be reported')
    assert.equal(finding.location.file, 'event-log')
    assert.equal(finding.location.file.startsWith('/'), false)
    assert.equal(result.stdout.includes(base), false, 'no host path may reach stdout')
  }, { commands: [], files: { 'regular.txt': 'not a directory\n' } })
})

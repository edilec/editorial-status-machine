import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { formatReport, runEditorialMachine } from '../src/index.mjs'
import { CLI, MACHINE, NOW, TO_PUBLISHED, command, projectDirectory, workspace } from './support.mjs'

const run = promisify(execFile)

/**
 * The guarantees the README states, each with the mutation that would break it.
 *
 * Every case below asserts `status === 'incomplete'` rather than merely "not
 * pass". That is what makes these tests mutation-sensitive: deleting the
 * `incomplete = true` beside any one of them leaves the finding in place and
 * the status at `fail`, and the assertion still fails. Where the finding is
 * only a warning, the flag is the *only* thing standing between the run and a
 * green build, and that case is called out explicitly.
 */

async function decide(commands, { machine = MACHINE, limits = {}, now = NOW, mutate = null } = {}) {
  return workspace(async ({ root, log }) => {
    if (mutate !== null) await mutate({ root, log })
    return runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now, limits, events: log,
    })
  }, { machine, commands })
}

function rules(report) {
  return report.findings.map((item) => item.ruleId)
}

test('every path that obtains no evidence reports incomplete, never pass', async () => {
  const cases = [
    ['an empty batch', () => decide([])],
    ['a machine that will not compile', () => decide(TO_PUBLISHED, { machine: { ...MACHINE, initialState: 'x' } })],
    ['a machine that is not JSON', () => decide(TO_PUBLISHED, {
      mutate: ({ root }) => writeFile(`${root}/machine.json`, '{ broken', 'utf8'),
    })],
    ['a machine that is not UTF-8', () => decide(TO_PUBLISHED, {
      mutate: ({ root }) => writeFile(`${root}/machine.json`, Buffer.from([0x7b, 0xff, 0x7d])),
    })],
    ['a command file that is not an array', () => decide(TO_PUBLISHED, {
      mutate: ({ root }) => writeFile(`${root}/commands.json`, '{}', 'utf8'),
    })],
    ['a command file that is not UTF-8', () => decide(TO_PUBLISHED, {
      mutate: ({ root }) => writeFile(`${root}/commands.json`, Buffer.from([0x5b, 0xff, 0x5d])),
    })],
    ['a log that is not UTF-8', () => decide(TO_PUBLISHED, {
      mutate: ({ log }) => writeFile(log, Buffer.from([0x7b, 0xff, 0x7d])),
    })],
    ['a log line that is not JSON', () => decide(TO_PUBLISHED, {
      mutate: ({ log }) => writeFile(log, 'not json\n', 'utf8'),
    })],
    ['a batch above maxCommands', () => decide(TO_PUBLISHED, { limits: { maxCommands: 1 } })],
    ['a batch above maxDocuments', () => decide(
      [command({ commandId: 'a', document: 'a' }), command({ commandId: 'b', document: 'b' })],
      { limits: { maxDocuments: 1 } },
    )],
    ['an input above maxFileBytes', () => decide(TO_PUBLISHED, { limits: { maxFileBytes: 30 } })],
    ['a machine above maxStates', () => decide(TO_PUBLISHED, { limits: { maxStates: 2 } })],
  ]

  for (const [label, build] of cases) {
    const { report } = await build()
    assert.equal(report.status, 'incomplete', `${label} must be incomplete, not ${report.status}`)
    assert.notEqual(report.status, 'pass', label)
  }
})

test('the empty batch is held back by the flag alone, not by an error finding', async () => {
  // Nothing here is an `error`. Delete the `incomplete = true` beside
  // `no-commands` and this run reports `pass` with `checked: 0` -- green on no
  // evidence, with every other test in the suite still passing.
  const { report } = await decide([])
  assert.equal(report.status, 'incomplete')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.checked, 0)
  assert.deepEqual(rules(report), ['no-commands'])
})

test('pass is never reported with nothing checked', async () => {
  const observed = []
  for (const build of [
    () => decide([]),
    () => decide(TO_PUBLISHED),
    () => decide([command({ actor: 'dana' })]),
    () => decide(TO_PUBLISHED, { machine: { ...MACHINE, initialState: 'x' } }),
  ]) {
    const { report } = await build()
    observed.push([report.status, report.summary.checked])
    if (report.status === 'pass') assert.ok(report.summary.checked > 0, 'a pass must rest on something checked')
  }
  assert.ok(observed.some(([status]) => status === 'pass'), 'at least one case must actually pass')
  assert.ok(observed.some(([status]) => status === 'incomplete'))
  assert.ok(observed.some(([status]) => status === 'fail'))
})

test('an identifier carrying a line terminator cannot forge a line in the report', async () => {
  const forged = `post\nERROR   commands.json/ forged-rule this finding was never emitted`
  const { report } = await decide([command({ document: forged })])

  assert.deepEqual(rules(report), ['identifier-invalid'])
  for (const finding of report.findings) {
    assert.equal(JSON.stringify(finding).includes('\\n'), false)
    assert.equal((finding.evidence ?? '').includes('\n'), false)
  }
  assert.match(report.findings[0].evidence, /^post ERROR commands\.json\/ forged-rule/)

  const human = formatReport(report, { machineName: 'test-lifecycle', documents: [] })
  const lines = human.trimEnd().split('\n')
  assert.equal(lines.length, 3 + report.findings.length, 'the human report grew by a line nobody emitted')
  assert.equal(lines.filter((line) => line.startsWith('ERROR')).length, 1, 'a second ERROR line was forged')
})

test('a machine name carrying a line terminator cannot forge a line either', async () => {
  const machine = { ...structuredClone(MACHINE), name: 'lifecycle\nERROR   forged/ forged-rule invented' }
  const { report, machineName } = await decide(TO_PUBLISHED, { machine })
  assert.equal(report.status, 'pass')

  const human = formatReport(report, { machineName, documents: [] })
  const lines = human.trimEnd().split('\n')
  assert.equal(lines.length, 3)
  assert.match(lines[0], /^machine lifecycle ERROR forged\/ forged-rule invented: 6 state/)
})

test('the human report has exactly one line per finding and per document', async () => {
  const { report, machineName, documents } = await decide([
    ...TO_PUBLISHED,
    command({ commandId: 'y', document: 'other', actor: 'alice' }),
    command({
      commandId: 'x', document: 'post', action: 'publish', actor: 'dana',
      at: '2026-03-04T09:00:00Z', expectedRevision: 3,
    }),
  ])
  const lines = formatReport(report, { machineName, documents }).trimEnd().split('\n')
  assert.equal(documents.length, 2)
  assert.equal(report.findings.length, 1)
  assert.equal(lines.length, 3 + documents.length + report.findings.length)
})

test('nothing in this package rewrites the event log', async () => {
  const cli = await readFile(resolve(projectDirectory, 'bin/editorial-status-machine.mjs'), 'utf8')
  assert.equal(cli.includes('appendFile'), true)
  assert.equal(/flag: 'a'/.test(cli), true)
  for (const forbidden of ['writeFile', 'truncate', 'unlink', 'rename', 'rm(']) {
    assert.equal(cli.includes(forbidden), false, `the CLI must not use ${forbidden}`)
  }
  for (const path of ['src/index.mjs', 'src/machine.mjs', 'src/events.mjs', 'src/commands.mjs', 'src/text.mjs']) {
    const source = await readFile(resolve(projectDirectory, path), 'utf8')
    for (const forbidden of ['writeFile', 'appendFile', 'truncate', 'unlink', 'rename']) {
      assert.equal(source.includes(forbidden), false, `${path} must not use ${forbidden}`)
    }
  }
})

/** Run the real binary. */
async function cli(args, cwd) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: cwd ?? projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('the CLI appends nothing to a log whose chain does not verify', async () => {
  await workspace(async ({ root, log }) => {
    const args = [
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--now', NOW, '--events', log, '--json',
    ]
    const first = await cli(args)
    assert.equal(first.code, 0)

    const lines = (await readFile(log, 'utf8')).trimEnd().split('\n')
    const tampered = JSON.parse(lines[0])
    tampered.actor = 'mallory'
    const broken = `${[JSON.stringify(tampered), ...lines.slice(1)].join('\n')}\n`
    await writeFile(log, broken, 'utf8')

    const second = await cli(args)
    assert.equal(second.code, 2)
    assert.equal(await readFile(log, 'utf8'), broken, 'a log that did not verify must not be extended')
    assert.equal(JSON.parse(second.stdout).status, 'incomplete')
  }, { commands: TO_PUBLISHED })
})

test('the CLI appends nothing when every command is refused', async () => {
  await workspace(async ({ root, log }) => {
    const result = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--now', NOW, '--events', log,
    ])
    assert.equal(result.code, 1)
    await assert.rejects(readFile(log, 'utf8'), /ENOENT/, 'no log should have been created')
  }, { commands: [command({ actor: 'dana' })] })
})

test('--dry-run decides everything and appends nothing', async () => {
  await workspace(async ({ root, log }) => {
    const result = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--now', NOW, '--events', log, '--dry-run', '--json',
    ])
    assert.equal(result.code, 0)
    assert.equal(JSON.parse(result.stdout).summary.applied, 3)
    assert.match(result.stderr, /dry run: 3 event\(s\)/)
    await assert.rejects(readFile(log, 'utf8'), /ENOENT/)
  }, { commands: TO_PUBLISHED })
})

test('a repeated publish through the real binary publishes exactly once', async () => {
  await workspace(async ({ root, log }) => {
    const args = ['--root', root, '--machine', 'machine.json', '--commands', 'commands.json', '--now', NOW, '--events', log, '--json']

    const first = await cli(args)
    assert.equal(first.code, 0)
    assert.equal(JSON.parse(first.stdout).summary.applied, 3)
    const afterFirst = await readFile(log, 'utf8')

    const second = await cli(args)
    assert.equal(second.code, 0)
    const report = JSON.parse(second.stdout)
    assert.equal(report.summary.applied, 0)
    assert.equal(report.summary.replayed, 4)
    assert.equal(report.summary.newEvents, 0)
    assert.equal(await readFile(log, 'utf8'), afterFirst, 'the log grew on a replay')

    const publishes = afterFirst.trimEnd().split('\n')
      .map((line) => JSON.parse(line))
      .filter((event) => event.to === 'published')
    assert.equal(publishes.length, 1)
    assert.equal(publishes[0].revision, 3)
  }, { commands: [...TO_PUBLISHED, TO_PUBLISHED[2]] })
})

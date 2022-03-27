import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { excerpt, formatReport, isIdentifier, runEditorialMachine } from '../src/index.mjs'
import { CLI, MACHINE, NOW, TO_PUBLISHED, command, projectDirectory, workspace } from './support.mjs'

const run = promisify(execFile)

/**
 * Every class of character that must not travel inside a value this tool
 * prints, tested class by class and through the real report path.
 *
 * A class list that stops at C0 and the two Unicode line separators leaves the
 * C1 range through, and two of those do the same damage on their own: U+0085
 * NEL is a line break to a great many consumers, and U+009B is the 8-bit CSI,
 * a terminal control introducer that needs no ESC in front of it. The bidi
 * overrides are worse in a different way -- they forge no line, but U+202E
 * makes a value print as something other than the value that was compared,
 * stored and hashed, which is the whole basis of auditing one.
 *
 * Half of these arrive through an IDENTIFIER -- a document id, a command id, a
 * machine state id, a file name -- rather than through a content excerpt. A
 * tool in this catalog sanitised its excerpts and left its identifiers raw.
 */

const CLASSES = Object.freeze([
  ['C0 NUL', 0x00],
  ['C0 BEL', 0x07],
  ['C0 line feed', 0x0a],
  ['C0 ESC', 0x1b],
  ['DEL', 0x7f],
  ['C1 padding', 0x80],
  ['C1 NEL', 0x85],
  ['C1 CSI', 0x9b],
  ['C1 APC', 0x9f],
  ['line separator', 0x2028],
  ['paragraph separator', 0x2029],
  ['left-to-right mark', 0x200e],
  ['right-to-left mark', 0x200f],
  ['left-to-right embedding', 0x202a],
  ['right-to-left override', 0x202e],
  ['left-to-right isolate', 0x2066],
  ['pop directional isolate', 0x2069],
])

function carrying(code) {
  return `post${String.fromCharCode(code)}id`
}

async function cli(args, cwd = projectDirectory) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('excerpt removes every class, and keeps ordinary text of any script', () => {
  for (const [label, code] of CLASSES) {
    assert.equal(excerpt(carrying(code)), 'post id', label)
    assert.equal(excerpt(carrying(code)).includes(String.fromCharCode(code)), false, label)
  }
  // Nothing legitimate is lost: right-to-left letters carry their own
  // direction and need no override, and a combining mark is not a control.
  for (const kept of ['\u0645\u0642\u0627\u0644-2', 'na\u00efve-draft', 'e\u0301dition']) {
    assert.equal(excerpt(kept), kept)
  }
})

test('isIdentifier refuses every class at the door', () => {
  for (const [label, code] of CLASSES) {
    assert.equal(isIdentifier(carrying(code)), false, label)
  }
  for (const kept of ['\u0645\u0642\u0627\u0644-2', 'na\u00efve-draft', 'post-hello']) {
    assert.equal(isIdentifier(kept), true, kept)
  }
})

test('a document id carrying any class is refused, and its evidence is flattened', async () => {
  for (const [label, code] of CLASSES) {
    const { report } = await workspace(
      async ({ root }) => runEditorialMachine({
        root, machine: 'machine.json', commands: 'commands.json', now: NOW,
      }),
      { commands: [command({ document: carrying(code) })] },
    )
    assert.equal(report.status, 'fail', label)
    assert.deepEqual(report.findings.map((item) => item.ruleId), ['identifier-invalid'], label)
    assert.equal(report.findings[0].evidence, 'post id', label)
    assert.equal(JSON.stringify(report).includes(String.fromCharCode(code)), false, label)

    const human = formatReport(report, { machineName: 'test-lifecycle', documents: [] })
    if (code !== 0x0a) assert.equal(human.includes(String.fromCharCode(code)), false, label)
    // Three header lines and one finding: the value forged no line of its own.
    assert.equal(human.trimEnd().split('\n').length, 4, label)
  }
})

test('a machine state id carrying a class is refused, and the report stays clean', async () => {
  for (const [label, code] of [['C1 NEL', 0x85], ['right-to-left override', 0x202e], ['C1 CSI', 0x9b]]) {
    const machine = structuredClone(MACHINE)
    machine.states = [...machine.states, { id: carrying(code) }]
    const { report } = await workspace(
      async ({ root }) => runEditorialMachine({
        root, machine: 'machine.json', commands: 'commands.json', now: NOW,
      }),
      { machine, commands: TO_PUBLISHED },
    )
    assert.equal(report.status, 'incomplete', label)
    assert.ok(report.findings.some((item) => item.ruleId === 'identifier-invalid'), label)
    assert.equal(JSON.stringify(report).includes(String.fromCharCode(code)), false, label)
  }
})

test('an unknown command key carrying a class cannot forge a line through a pointer', async () => {
  for (const [label, code] of [['C1 NEL', 0x85], ['right-to-left override', 0x202e]]) {
    const { report } = await workspace(
      async ({ root }) => runEditorialMachine({
        root, machine: 'machine.json', commands: 'commands.json', now: NOW,
      }),
      { commands: [{ ...command(), [`sneak${String.fromCharCode(code)}y`]: 1 }] },
    )
    assert.equal(report.status, 'fail', label)
    assert.deepEqual(report.findings.map((item) => item.ruleId), ['command-key-unknown'], label)
    assert.equal(report.findings[0].location.pointer, '/commands/0/sneak y', label)
    assert.equal(JSON.stringify(report).includes(String.fromCharCode(code)), false, label)
  }
})

test('a file name carrying a class reaches the report sanitised, and names the file that was read', async () => {
  // The identifier here is a path, and it arrives from the filesystem rather
  // than from a JSON document. Both findings must name the batch that was
  // actually read -- not a hardcoded default -- and neither may carry the raw
  // character.
  const name = `cmd${String.fromCharCode(0x85)}${String.fromCharCode(0x202e)}.json`
  await workspace(async ({ root }) => {
    await writeFile(join(root, name), '[ broken', 'utf8')
    const { report } = await runEditorialMachine({
      root, machine: 'machine.json', commands: name, now: NOW,
    })
    assert.equal(report.status, 'incomplete')
    assert.deepEqual(
      report.findings.map((item) => [item.ruleId, item.location.file]),
      [['commands-not-evaluated', 'cmd .json'], ['input-not-json', 'cmd .json']],
    )
    for (const code of [0x85, 0x202e]) {
      assert.equal(JSON.stringify(report).includes(String.fromCharCode(code)), false, String(code))
    }
  }, { commands: TO_PUBLISHED })
})

test('nothing a command carries can put a control character on either stream', async () => {
  await workspace(async ({ root, log }) => {
    const result = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--now', NOW, '--events', log,
    ])
    assert.equal(result.code, 1)
    for (const [label, code] of CLASSES) {
      if (code === 0x0a) continue
      assert.equal(result.stdout.includes(String.fromCharCode(code)), false, `stdout: ${label}`)
      assert.equal(result.stderr.includes(String.fromCharCode(code)), false, `stderr: ${label}`)
    }
    // One line per finding, and no line the tool did not emit.
    assert.equal(result.stdout.trimEnd().split('\n').length, 3 + CLASSES.length)
  }, { commands: CLASSES.map(([, code], index) => command({ commandId: `c-${index}`, document: carrying(code) })) })
})

test('an unusable flag cannot put a control character on stderr either', async () => {
  // argv is the one untrusted string that reaches a stream without passing
  // through a finding.
  const forged = `--sneak${String.fromCharCode(0x0a)}ERROR   forged${String.fromCharCode(0x202e)}`
  const result = await cli([
    '--root', 'examples/clean', '--machine', 'machine.json', '--commands', 'commands.json',
    '--now', NOW, forged,
  ])
  assert.equal(result.code, 2)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /^Unknown option "--sneak ERROR forged"/)
  assert.equal(result.stderr.includes(String.fromCharCode(0x202e)), false)
})

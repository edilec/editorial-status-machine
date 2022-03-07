import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { runEditorialMachine } from '../src/index.mjs'
import { CLI, MACHINE, NOW, TO_PUBLISHED, command, projectDirectory, workspace } from './support.mjs'

const run = promisify(execFile)

async function cli(args, cwd = projectDirectory) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('two runs over identical inputs produce byte-identical stdout', async () => {
  const args = [
    '--root', 'examples/broken', '--machine', 'machine.json',
    '--commands', 'commands.json', '--now', NOW, '--json',
  ]
  const first = await cli(args)
  const second = await cli(args)
  assert.equal(first.code, 1)
  assert.equal(first.stdout, second.stdout)
  assert.ok(first.stdout.length > 1000)
})

test('the event log a run produces is byte-identical to the one it produced before', async () => {
  const build = async () => {
    const { newEvents } = await workspace(
      async ({ root }) => runEditorialMachine({
        root, machine: 'machine.json', commands: 'commands.json', now: NOW,
      }),
      { commands: TO_PUBLISHED },
    )
    return newEvents.map((event) => event.hash).join(',')
  }
  assert.equal(await build(), await build())
})

test('findings sort by command index numerically, not by pointer text', async () => {
  // Command 2 and command 10 both fail. Under a text sort of the pointer,
  // "/commands/10" precedes "/commands/2" and this assertion fails.
  const commands = Array.from({ length: 11 }, (unused, index) => (
    index === 2 || index === 10
      ? command({ commandId: `c-${index}`, document: `d-${index}`, actor: 'dana' })
      : command({ commandId: `c-${index}`, document: `d-${index}` })
  ))
  const { report } = await workspace(
    async ({ root }) => runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW,
    }),
    { commands },
  )

  assert.equal(report.findings.length, 2)
  assert.deepEqual(
    report.findings.map((item) => item.location.pointer),
    ['/commands/2', '/commands/10'],
  )
  assert.ok('/commands/10' < '/commands/2', 'the text order really is the other way round')
})

test('findings sort across files by name, and the order is not accidental', async () => {
  const machine = { ...structuredClone(MACHINE), states: [...structuredClone(MACHINE.states), { id: 'limbo' }] }
  const { report } = await workspace(
    async ({ root }) => runEditorialMachine({
      root, machine: 'machine.json', commands: 'commands.json', now: NOW,
    }),
    { machine, commands: [command({ actor: 'dana' })] },
  )

  const files = report.findings.map((item) => item.location.file)
  assert.deepEqual(new Set(files), new Set(['commands.json', 'machine.json']))
  assert.deepEqual(files, [...files].sort((left, right) => (left === right ? 0 : left < right ? -1 : 1)))
  assert.equal(files[0], 'commands.json', 'commands.json precedes machine.json by code unit')
  assert.notEqual(files[0], files[files.length - 1], 'the sort must span more than one file to mean anything')
})

/**
 * Strip prose so the scan looks at code.
 *
 * These modules explain in comments exactly what they refuse to call, so a
 * scan over the raw text would find `Date.now()` in the sentence promising not
 * to use it. Block comments and full-line comments go; code lines stay.
 */
function codeOnly(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      return !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    .join('\n')
}

test('nothing in the shipped source reads a clock, a locale or a random source', async () => {
  for (const path of [
    'src/index.mjs', 'src/machine.mjs', 'src/events.mjs', 'src/commands.mjs', 'src/text.mjs',
    'bin/editorial-status-machine.mjs',
  ]) {
    const source = codeOnly(await readFile(resolve(projectDirectory, path), 'utf8'))
    assert.equal(/Date\.now\s*\(/.test(source), false, `${path} reads the wall clock`)
    assert.equal(/new Date\s*\(\s*\)/.test(source), false, `${path} constructs a current date`)
    assert.equal(source.includes('localeCompare'), false, `${path} orders by locale`)
    assert.equal(source.includes('toLocale'), false, `${path} formats by locale`)
    assert.equal(source.includes('Math.random'), false, `${path} uses a random source`)
    assert.equal(source.includes('Intl.'), false, `${path} uses ICU data`)
    assert.equal(source.includes('process.env'), false, `${path} reads the environment`)
    assert.equal(/\bfetch\s*\(|node:https?|XMLHttpRequest/.test(source), false, `${path} reaches the network`)
  }
})

test('the only date construction in the source is parsing a supplied instant', async () => {
  const source = codeOnly(await readFile(resolve(projectDirectory, 'src/text.mjs'), 'utf8'))
  // `new Date(ms)` round-trips a parsed instant to check it means what it says.
  // Any other file constructing a Date would be reading a clock by another name.
  assert.equal(source.includes('new Date(ms)'), true)
  for (const path of ['src/index.mjs', 'src/machine.mjs', 'src/events.mjs', 'src/commands.mjs']) {
    const other = codeOnly(await readFile(resolve(projectDirectory, path), 'utf8'))
    assert.equal(/new Date\b/.test(other), false, `${path} constructs a Date`)
  }
})

test('the report is plain JSON with the contract envelope', async () => {
  const result = await cli([
    '--root', 'examples/clean', '--machine', 'machine.json',
    '--commands', 'commands.json', '--now', NOW, '--json', '--dry-run',
  ])
  const report = JSON.parse(result.stdout)
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'editorial-status-machine')
  assert.ok(['pass', 'fail', 'incomplete'].includes(report.status))
  assert.deepEqual(Object.keys(report), ['schemaVersion', 'tool', 'status', 'summary', 'findings'])
  for (const finding of report.findings) {
    assert.deepEqual(Object.keys(finding.location).sort(), ['file', 'pointer'])
    assert.ok(['error', 'warning', 'info'].includes(finding.severity))
  }
})

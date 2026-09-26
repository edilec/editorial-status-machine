/**
 * What a `JSON.parse` failure may not print back.
 *
 * V8 answers an unparseable document two ways, and one of them embeds the
 * input: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. So
 * a command batch, a machine definition, or a line of the event log that is
 * short enough to be only a credential was reproduced in full by its own error
 * message -- `input-not-json` and `event-line-invalid` both reach stdout, in
 * both output modes.
 *
 * `excerpt` does not catch it. It strips control characters and cuts from the
 * end; the quoted span sits at the *front* of the message, so truncation only
 * ever removes the position and leaves the input.
 *
 * `AKIAIOSFODNN7EXAMPLE` is the AWS documentation placeholder, not a key.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { parseFailureDetail } from '../src/index.mjs'
import { CLI, NOW, TO_PUBLISHED, projectDirectory, workspace } from './support.mjs'

const run = promisify(execFile)

const CANARY = 'AKIAIOSFODNN7EXAMPLE'

// Longer than V8's ten-character window, so a leak is a prefix rather than the
// whole string. Truncating the message would not have caught this one.
const LONG_SECRET = 'password=hunter2-correct-horse-battery-staple'

const MIN_RUN = 8

/**
 * Assert that no run of `secret` eight characters or longer survives.
 *
 * Every run, not only every prefix: V8 quotes a window around the offending
 * character, so a secret in the middle of a document leaks from its middle.
 * Asserting only on the whole string would pass against output that printed
 * `AKIAIOSF` and called that truncation.
 */
function assertNoLeak(secret, ...streams) {
  const haystack = streams.join('\n')
  for (let length = secret.length; length >= MIN_RUN; length -= 1) {
    for (let start = 0; start + length <= secret.length; start += 1) {
      const window = secret.slice(start, start + length)
      assert.equal(haystack.includes(window), false, `output echoed ${JSON.stringify(window)}`)
    }
  }
}

async function cli(args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { cwd: projectDirectory })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr }
  }
}

test('a command batch that is only a credential is not printed back', async () => {
  await workspace(async ({ root, log }) => {
    await writeFile(join(root, 'commands.json'), CANARY)

    const { stdout, stderr } = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--events', log, '--now', NOW, '--json',
    ])
    const report = JSON.parse(stdout)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'input-not-json'), true)
    assertNoLeak(CANARY, stdout, stderr)
  }, { commands: [] })
})

test('a machine definition that is only a credential is not printed back', async () => {
  await workspace(async ({ root, log }) => {
    await writeFile(join(root, 'machine.json'), CANARY)

    const { stdout, stderr } = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--events', log, '--now', NOW, '--json',
    ])
    assertNoLeak(CANARY, stdout, stderr)
  }, { commands: TO_PUBLISHED })
})

test('an event log line that is only a credential is not printed back', async () => {
  await workspace(async ({ root, log }) => {
    await writeFile(log, `${CANARY}\n`)

    const { stdout, stderr } = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--events', log, '--now', NOW, '--json',
    ])
    const report = JSON.parse(stdout)
    assert.equal(report.findings.some((finding) => finding.ruleId === 'event-line-invalid'), true)
    assertNoLeak(CANARY, stdout, stderr)
  }, { commands: TO_PUBLISHED })
})

test("a secret longer than V8's quoting window does not leak its prefix either", async () => {
  await workspace(async ({ root, log }) => {
    await writeFile(join(root, 'commands.json'), LONG_SECRET)

    const { stdout, stderr } = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--events', log, '--now', NOW, '--json',
    ])
    assertNoLeak(LONG_SECRET, stdout, stderr)
    assert.equal(stdout.includes('password=h'), false)
  }, { commands: [] })
})

test('a secret sitting mid-document does not leak through the windowed form', async () => {
  await workspace(async ({ root, log }) => {
    // V8 answers this one with `Unexpected token '}', "[ }AKIAIOSFO"...`: the
    // shape that quotes a window rather than a leading prefix.
    await writeFile(join(root, 'commands.json'), `[ }${CANARY}]`)

    const { stdout, stderr } = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--events', log, '--now', NOW, '--json',
    ])
    assertNoLeak(CANARY, stdout, stderr)
  }, { commands: [] })
})

test('the position, line and column of a parse failure survive the fix', async () => {
  await workspace(async ({ root, log }) => {
    await writeFile(join(root, 'commands.json'), '[{"commandId": "c-1" "document": "post"}]')

    const { stdout } = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--events', log, '--now', NOW, '--json',
    ])
    const finding = JSON.parse(stdout).findings.find((item) => item.ruleId === 'input-not-json')
    assert.match(finding.message, /at position 21 \(line 1 column 22\)/)
  }, { commands: [] })
})

test('a parse failure still names the token: a detail that says nothing is its own defect', async () => {
  await workspace(async ({ root, log }) => {
    await writeFile(join(root, 'commands.json'), CANARY)

    const { stdout } = await cli([
      '--root', root, '--machine', 'machine.json', '--commands', 'commands.json',
      '--events', log, '--now', NOW, '--json',
    ])
    const finding = JSON.parse(stdout).findings.find((item) => item.ruleId === 'input-not-json')
    assert.match(finding.message, /unexpected token 'A'/)
  }, { commands: [] })
})

test('parseFailureDetail keeps the position and drops the quoted window', () => {
  const detail = (text) => {
    try {
      JSON.parse(text)
      throw new Error('that text parsed')
    } catch (error) {
      return parseFailureDetail(error)
    }
  }

  // The positional form is all position and no input, and is kept whole.
  assert.equal(
    detail('[{"commandId": "c-1" "document": "post"}]'),
    "Expected ',' or '}' after property value in JSON at position 21 (line 1 column 22)",
  )
  assert.equal(detail('{"a":1}x'), 'Unexpected non-whitespace character after JSON at position 7 (line 1 column 8)')
  assert.equal(detail(''), 'Unexpected end of JSON input')
  assert.equal(detail('[1,2,'), 'Unexpected end of JSON input')

  // Every quoted shape: the whole input, a leading prefix, and a window.
  assert.equal(detail(CANARY), "unexpected token 'A' near the start")
  assert.equal(detail(LONG_SECRET), "unexpected token 'p' near the start")
  assert.equal(detail(`[ }${CANARY}]`), "unexpected token '}' near the start")
  assert.equal(detail(`{"aaaaaaaaaaaaaa": [ }${CANARY} ]}`), "unexpected token '}'")
})

test('parseFailureDetail refuses a document whose own bytes imitate a position', () => {
  // The quoted form is matched first for exactly this reason.
  let detail
  try {
    JSON.parse(`at position 12 ${CANARY}`)
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assertNoLeak(CANARY, detail)
  assert.equal(detail.includes('at position 12'), false)
})

test('parseFailureDetail strips a control character that arrives as the token', () => {
  // V8 names the offending character, and that character came from the input.
  let detail
  try {
    JSON.parse(String.fromCharCode(0x1b))
  } catch (error) {
    detail = parseFailureDetail(error)
  }
  assert.equal(detail.includes(String.fromCharCode(0x1b)), false)
})

test('parseFailureDetail says something for an error it does not recognise', () => {
  assert.equal(parseFailureDetail(undefined), 'it could not be parsed as JSON')
  assert.equal(parseFailureDetail(new Error('something else entirely')), 'it could not be parsed as JSON')
})

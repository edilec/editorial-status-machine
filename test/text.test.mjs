import assert from 'node:assert/strict'
import test from 'node:test'

import { byCodeUnit, decodeUtf8, excerpt, isIdentifier, isPlainObject, parseInstant } from '../src/text.mjs'

test('byCodeUnit orders by UTF-16 code unit, not by collation', () => {
  // The catalog's real ordering bug: `S` (0x53) precedes `_` (0x5F) by code
  // point, so MAXSTATES sorts first, while collation treats the underscore as
  // ignorable punctuation and puts MAX_STATES first. Reversing the comparator
  // flips every assertion here.
  assert.equal(byCodeUnit('MAX_STATES', 'MAXSTATES'), 1)
  assert.equal(byCodeUnit('MAXSTATES', 'MAX_STATES'), -1)
  assert.equal(byCodeUnit('a_b', 'ab'), -1)
  assert.equal(byCodeUnit('ab', 'a_b'), 1)
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('same', 'same'), 0)
})

test('sorting with byCodeUnit puts an underscore before a letter', () => {
  const sorted = ['event_log', 'eventlog', 'eventLog'].sort(byCodeUnit)
  assert.deepEqual(sorted, ['eventLog', 'event_log', 'eventlog'])
})

test('decodeUtf8 refuses undecodable bytes and never guesses from content', () => {
  assert.deepEqual(decodeUtf8(Buffer.from('hello', 'utf8')), { ok: true, text: 'hello' })
  assert.equal(decodeUtf8(Buffer.from([0x66, 0xff, 0x66])).ok, false)

  // A file that legitimately holds U+FFFD decodes fine. Inferring "not UTF-8"
  // from a replacement character in the decoded text is the defect this guards.
  const withReplacement = decodeUtf8(Buffer.from('a�b', 'utf8'))
  assert.equal(withReplacement.ok, true)
  assert.equal(withReplacement.text, 'a�b')
})

test('excerpt flattens control characters, line terminators and length', () => {
  assert.equal(excerpt('post\nid'), 'post id')
  assert.equal(excerpt(`post${String.fromCharCode(0x2028)}id`), 'post id')
  assert.equal(excerpt(`post${String.fromCharCode(0x2029)}id`), 'post id')
  assert.equal(excerpt(`post${String.fromCharCode(0)}id`), 'post id')
  assert.equal(excerpt('  spaced   out  '), 'spaced out')
  assert.equal(excerpt('x'.repeat(20), 8), `${'x'.repeat(8)}...`)
  assert.equal(excerpt('x'.repeat(8), 8), 'x'.repeat(8))
})

test('a sanitised string can never carry a line break into a report', () => {
  const forged = `alice\nERROR   commands.json/ forged-rule invented finding`
  assert.equal(excerpt(forged).includes('\n'), false)
  assert.equal(excerpt(forged).split('\n').length, 1)
})

test('isIdentifier refuses empty, untrimmed, over-long and control-bearing values', () => {
  assert.equal(isIdentifier('post-hello'), true)
  assert.equal(isIdentifier('a'.repeat(200)), true)
  assert.equal(isIdentifier('a'.repeat(201)), false)
  assert.equal(isIdentifier(''), false)
  assert.equal(isIdentifier(' alice'), false)
  assert.equal(isIdentifier('alice '), false)
  assert.equal(isIdentifier('post\nid'), false)
  assert.equal(isIdentifier(`post${String.fromCharCode(0x2028)}id`), false)
  assert.equal(isIdentifier(`post${String.fromCharCode(0x7f)}id`), false)
  assert.equal(isIdentifier(42), false)
  assert.equal(isIdentifier(null), false)
})

test('parseInstant accepts only real ISO-8601 UTC instants', () => {
  const ok = parseInstant('2026-03-01T09:00:00Z')
  assert.equal(ok.ok, true)
  assert.equal(ok.canonical, '2026-03-01T09:00:00.000Z')
  assert.equal(ok.ms, Date.UTC(2026, 2, 1, 9, 0, 0))

  assert.equal(parseInstant('2026-03-01T09:00:00.5Z').canonical, '2026-03-01T09:00:00.500Z')
  assert.equal(parseInstant('2026-03-01T09:00:00.123Z').canonical, '2026-03-01T09:00:00.123Z')
})

test('parseInstant refuses a date that Date.parse would silently roll forward', () => {
  // Date.parse('2026-02-31T00:00:00Z') is a finite number that means 3 March.
  // Relying on it would let a scheduling rule agree to a date nobody wrote.
  assert.equal(Number.isFinite(Date.parse('2026-02-31T00:00:00Z')), true)
  assert.equal(parseInstant('2026-02-31T00:00:00Z').ok, false)

  // 24:00:00 is legal ISO that means the next midnight.
  assert.equal(Number.isFinite(Date.parse('2026-03-01T24:00:00Z')), true)
  assert.equal(parseInstant('2026-03-01T24:00:00Z').ok, false)
})

test('parseInstant refuses local offsets, loose formats and non-strings', () => {
  for (const value of [
    '2026-03-01T09:00:00+05:30',
    '2026-03-01T09:00:00',
    '2026-03-01 09:00:00Z',
    '2026-03-01',
    '2026-13-01T00:00:00Z',
    '2026-03-01T09:00:00.1234Z',
    '',
    42,
    null,
    undefined,
  ]) {
    assert.equal(parseInstant(value).ok, false, `${JSON.stringify(value)} should not parse`)
  }
})

test('isPlainObject separates objects from arrays, null and class instances', () => {
  assert.equal(isPlainObject({}), true)
  assert.equal(isPlainObject(Object.create(null)), true)
  assert.equal(isPlainObject([]), false)
  assert.equal(isPlainObject(null), false)
  assert.equal(isPlainObject(new Date(0)), false)
  assert.equal(isPlainObject('x'), false)
})

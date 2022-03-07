/**
 * Decoding, sanitising, ordering and instant parsing.
 *
 * Nothing in this module touches the filesystem, the network, the locale or
 * the clock. Every value it handles arrives from a file this tool did not
 * write, so every value it returns is treated as data on its way to a report,
 * never as something that can shape a line of output.
 */

/**
 * Order by UTF-16 code unit.
 *
 * `localeCompare` depends on ICU data that differs between Node builds and
 * between hosts, and it treats punctuation as ignorable: under collation
 * `state_id` and `stateId` swap places depending on where the tool runs. A
 * report that is only deterministic on one machine is not deterministic.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

/**
 * Characters stripped before any untrusted string is embedded in output.
 *
 * Built from code points rather than written literally: a literal U+2028 or
 * U+2029 inside a module is a line terminator to the parser, and writing one
 * into this file would be a syntax error. They are here because both are line
 * breaks to a great many consumers, and a document id carrying one forges an
 * extra line in the human report exactly as a newline does.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${String.fromCharCode(127)}-${String.fromCharCode(159)}` +
  `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
  'g',
)

/**
 * What an identifier may not contain: the whole C0 range including tab,
 * newline and carriage return, DEL, the C1 range, and both Unicode line
 * separators. `CONTROL` above leaves the three ASCII whitespace controls to
 * the `\s+` collapse that follows it; an identifier has no such second pass,
 * and a document id holding a newline is exactly the value that forged a line
 * in a human report elsewhere in this catalog.
 */
const FORBIDDEN_IN_IDENTIFIER = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
  `${String.fromCharCode(127)}-${String.fromCharCode(159)}` +
  `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
)

export const EXCERPT_LIMIT = 160
export const MAX_IDENTIFIER_LENGTH = 200

/**
 * A bounded, single-line, control-free rendering of an untrusted string.
 *
 * Every identifier, path, key and message that reaches a finding goes through
 * this, not only the evidence field. A tool in this catalog sanitised its
 * excerpts and left its identifiers raw, so a record id holding a newline
 * printed two lines into the human report and invented a finding that was
 * never emitted.
 */
export function excerpt(value, limit = EXCERPT_LIMIT) {
  const flattened = String(value).replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * Identifiers are the machine's vocabulary: state names, action names, role
 * names, actor ids, document ids and command ids. They are compared, used as
 * map keys, written into an append-only log and printed. A control character
 * in one of them is refused at the door rather than cleaned up later, because
 * a value that prints differently from the value that was compared is a value
 * nobody can audit.
 */
export function isIdentifier(value) {
  if (typeof value !== 'string') return false
  if (value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return false
  if (value.trim() !== value) return false
  return !FORBIDDEN_IN_IDENTIFIER.test(value)
}

/**
 * Decode bytes as UTF-8, strictly.
 *
 * `fatal: true` is the whole point. Decoding leniently and then hunting for
 * U+FFFD cannot tell undecodable bytes from a file that legitimately contains
 * a replacement character, and that confusion has let an unread input report a
 * pass in this catalog. The decoder decides; the decoded text never gets a
 * vote. Every file this tool opens goes through here, including the machine
 * definition -- the configuration path is exactly where a tool hardened its
 * data path and forgot.
 */
export function decodeUtf8(bytes) {
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) }
  } catch {
    return { ok: false, reason: 'not-utf8' }
  }
}

const INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/

/**
 * Parse an ISO-8601 UTC instant, exactly.
 *
 * `Date.parse` alone is not a validator: it accepts `2026-02-31T00:00:00Z` and
 * quietly hands back the third of March, and it accepts `24:00:00` and hands
 * back the following midnight. Both would make a scheduling rule agree to a
 * date nobody wrote. The canonical form is rebuilt from the parsed instant and
 * compared with the input, so only a timestamp that means what it says passes.
 *
 * Offsets other than `Z` are refused rather than converted: an editorial log
 * that mixes local offsets is a log whose ordering depends on who wrote the
 * line.
 */
export function parseInstant(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'not-a-string' }
  const parts = INSTANT.exec(value)
  if (parts === null) return { ok: false, reason: 'not-iso-utc' }
  const canonical =
    `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}.` +
    `${(parts[7] ?? '').padEnd(3, '0')}Z`
  const ms = Date.parse(canonical)
  if (!Number.isFinite(ms)) return { ok: false, reason: 'not-a-real-instant' }
  if (new Date(ms).toISOString() !== canonical) return { ok: false, reason: 'not-a-real-instant' }
  return { ok: true, ms, canonical }
}

/** True for a plain object -- not an array, not null, not a class instance dressed up as one. */
export function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

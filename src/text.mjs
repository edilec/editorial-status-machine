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
 * The characters no untrusted value may carry into output, in four classes.
 *
 * Built from code points rather than written literally: a literal U+2028 or
 * U+2029 inside a module is a line terminator to the parser, so writing one
 * into this file would be a syntax error, and the rest are invisible in an
 * editor. Spelling every one of them keeps the file plain ASCII and keeps the
 * list readable.
 *
 * - **C0** (U+0000-U+001F) and **DEL** (U+007F). A newline forges a line in
 *   the human report; ESC starts a terminal escape sequence; NUL cuts a value
 *   short in anything that reaches it through C.
 * - **C1** (U+0080-U+009F). Easy to forget after C0, and two of them do the
 *   same damage on their own: U+0085 NEL is a line break to a great many
 *   consumers, and U+009B is the 8-bit CSI -- a terminal control introducer
 *   that needs no ESC in front of it.
 * - **Line and paragraph separators** (U+2028, U+2029), line breaks to
 *   JavaScript and to many text consumers.
 * - **Bidi and isolate controls** (U+200E, U+200F, U+202A-U+202E,
 *   U+2066-U+2069). U+202E RIGHT-TO-LEFT OVERRIDE reverses everything printed
 *   after it, so a document id can be displayed as something other than the
 *   value that was compared, stored and hashed. Ordinary right-to-left text --
 *   Arabic, Hebrew -- needs none of these: the letters carry their own
 *   direction, so refusing the overrides refuses nothing legitimate.
 */
const DEL_AND_C1 = `${String.fromCharCode(127)}-${String.fromCharCode(159)}`
const SEPARATORS = `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}`
const BIDI =
  `${String.fromCharCode(0x200e)}${String.fromCharCode(0x200f)}` +
  `${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}` +
  `${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}`

/**
 * Stripped before any untrusted string is embedded in output. Tab, newline and
 * carriage return are left to the `\s+` collapse in `excerpt`, which turns
 * them into the same single space.
 */
const CONTROL = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(8)}` +
  `${String.fromCharCode(11)}${String.fromCharCode(12)}` +
  `${String.fromCharCode(14)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
  'g',
)

/**
 * What an identifier may not contain: the same four classes, plus the three
 * ASCII whitespace controls `CONTROL` leaves to the collapse. An identifier
 * has no such second pass, and a value that prints differently from the value
 * that was compared is a value nobody can audit.
 */
const FORBIDDEN_IN_IDENTIFIER = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}` +
  `${DEL_AND_C1}${SEPARATORS}${BIDI}]`,
)
const DEFAULT_IGNORABLE = /\p{Default_Ignorable_Code_Point}/u

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
  const flattened = String(value).replace(CONTROL, ' ')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, ' ').replace(/\s+/g, ' ').trim()
  if (flattened.length <= limit) return flattened
  return `${flattened.slice(0, limit)}...`
}

/**
 * The part of a `JSON.parse` failure that may safely be printed.
 *
 * V8 reports a parse failure two ways, and one of them quotes the input:
 * `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON`. A command
 * batch, a machine definition or an event log line short enough to be only a
 * credential is therefore reproduced in full by its own error message, and a
 * longer one is reproduced ten characters at a time -- a window around the
 * offending character, which may sit anywhere in the document.
 *
 * `excerpt` does not help. It strips control characters and cuts from the
 * *end*; the quoted span is at the front of the message, so it survives and
 * the position is what gets lost.
 *
 * The quoted form carries no position, so nothing diagnostic is lost by
 * reducing it to the offending token. The other form is all position and no
 * input, and is kept. The quoted window never leaves this function.
 *
 * The quoted form is matched first on purpose: a file whose own bytes read
 * `at position 12` would otherwise be sliced after its own quoted copy.
 */
export function parseFailureDetail(error) {
  const message = typeof error?.message === 'string' ? error.message : ''
  const token = /^Unexpected token (.+?), (\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s.exec(message)
  if (token) {
    const where = token[2] === undefined ? ' near the start' : ''
    return `unexpected token ${excerpt(token[1], 8)}${where}`
  }
  const position = /at position \d+(?: \(line \d+ column \d+\))?/.exec(message)
  if (position) return message.slice(0, position.index + position[0].length)
  if (/^Unexpected end of JSON input$/.test(message)) return message
  return 'it could not be parsed as JSON'
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
  return !FORBIDDEN_IN_IDENTIFIER.test(value) && !DEFAULT_IGNORABLE.test(value)
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

/**
 * Fixture builders shared by the suite.
 *
 * Every test that needs files gets its own temporary root, so no test can be
 * made to pass by another test's leftovers and the order they run in does not
 * matter.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = join(projectDirectory, 'bin/editorial-status-machine.mjs')
export const NOW = '2026-03-10T12:00:00Z'

export const MACHINE = Object.freeze({
  schemaVersion: '1',
  name: 'test-lifecycle',
  initialState: 'draft',
  roles: ['author', 'editor', 'publisher', 'archivist'],
  states: [
    { id: 'draft' },
    { id: 'review' },
    { id: 'approved' },
    { id: 'scheduled' },
    { id: 'published' },
    { id: 'retired', terminal: true },
  ],
  actors: [
    { id: 'alice', roles: ['author'] },
    { id: 'bob', roles: ['editor'] },
    { id: 'dana', roles: ['publisher'] },
    { id: 'eve', roles: ['archivist'] },
  ],
  transitions: [
    { from: 'draft', action: 'submit', to: 'review', roles: ['author', 'editor'] },
    { from: 'review', action: 'approve', to: 'approved', roles: ['editor'] },
    { from: 'review', action: 'reject', to: 'draft', roles: ['editor'] },
    { from: 'approved', action: 'schedule', to: 'scheduled', roles: ['publisher'], setsSchedule: true },
    { from: 'approved', action: 'publish', to: 'published', roles: ['publisher'] },
    { from: 'scheduled', action: 'unschedule', to: 'approved', roles: ['publisher'] },
    { from: 'scheduled', action: 'publish', to: 'published', roles: ['publisher'], requiresSchedule: true },
    { from: 'published', action: 'revise', to: 'draft', roles: ['author', 'editor'] },
    { from: 'published', action: 'retire', to: 'retired', roles: ['archivist', 'publisher'] },
  ],
})

/** A structurally valid command; every field can be overridden. */
export function command(overrides = {}) {
  return {
    commandId: 'c-1',
    document: 'post',
    action: 'submit',
    actor: 'alice',
    at: '2026-03-01T09:00:00Z',
    expectedRevision: 0,
    ...overrides,
  }
}

/** The three commands that take a fresh document from draft to published. */
export const TO_PUBLISHED = Object.freeze([
  command({ commandId: 'c-submit', action: 'submit', actor: 'alice', expectedRevision: 0 }),
  command({ commandId: 'c-approve', action: 'approve', actor: 'bob', at: '2026-03-02T09:00:00Z', expectedRevision: 1 }),
  command({ commandId: 'c-publish', action: 'publish', actor: 'dana', at: '2026-03-03T09:00:00Z', expectedRevision: 2 }),
])

/**
 * Build a temporary workspace: a read-only input root holding the machine and
 * the command batch, plus a log destination outside it.
 */
export async function workspace(body, { machine = MACHINE, commands = [], files = {} } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'editorial-status-machine-'))
  const root = join(base, 'root')
  await mkdir(root, { recursive: true })
  if (machine !== null) await writeFile(join(root, 'machine.json'), `${JSON.stringify(machine, null, 2)}\n`, 'utf8')
  if (commands !== null) await writeFile(join(root, 'commands.json'), `${JSON.stringify(commands, null, 2)}\n`, 'utf8')
  for (const [name, content] of Object.entries(files)) {
    const target = join(base, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  try {
    return await body({ base, root, log: join(base, 'events.jsonl') })
  } finally {
    await rm(base, { recursive: true, force: true })
  }
}

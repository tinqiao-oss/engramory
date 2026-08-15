/**
 * dsh-engramory — the Engramory memory discipline as a DeepSeek Harness plugin.
 *
 * Two things the always-on AGENTS.md block cannot do on its own:
 *
 *   1. A DETERMINISTIC index cap. dsh's `ctx.tools.guard()` is a synchronous,
 *      monotonic refusal — once a guard returns a reason, no later waterfall
 *      listener can turn it back into an allow. That makes it a stronger seam than
 *      most hosts expose, and it is why the 200-line / 25 KB limit can be enforced
 *      here rather than merely asked for. Everywhere except Claude Code, Engramory's
 *      cap degrades to "rules plus a checker the agent has to remember to run".
 *   2. Skill delivery that does not depend on install paths. Registering at runtime
 *      sidesteps the five-root scan entirely, so the protocol is present because the
 *      plugin is loaded, not because a directory happened to be right.
 *
 * Zero dependencies, no build step: plain ESM, node: builtins only.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

export const name = 'engramory'

// `tools` carries the cap and is required. `skills` is optional so the plugin still
// loads (and still caps) on a profile that mounts no skill registry.
export const inject = { required: ['tools'], optional: ['skills'] }

/** Mirrors hooks/engramory_index_guard.py — the caps are the protocol's, not this port's. */
const DEFAULT_MAX_LINES = 200
const DEFAULT_MAX_BYTES = 25600

/** Tools that replace a file wholesale, so `arguments.content` IS the post-write text. */
const WHOLE_FILE_WRITES = new Set(['write'])

export function apply(ctx, config = {}) {
  const settings = {
    indexName: config.indexName ?? 'MEMORY.md',
    maxLines: positive(config.maxLines, DEFAULT_MAX_LINES),
    maxBytes: positive(config.maxBytes, DEFAULT_MAX_BYTES),
  }

  ctx.tools.guard((exec) => refuseOversizedIndex(exec, settings))

  if (ctx.skills && config.registerSkill !== false) {
    const skill = config.skill ?? builtinSkillBody()
    ctx.skills.register({
      name: 'engramory',
      description:
        'Curated file-based long-term memory: recall through MEMORY.md at the start of ' +
        'a task, save durable user/feedback/project/reference facts, and sync before ' +
        'compacting or opening a fresh thread.',
      whenToUse:
        'Starting or resuming work, learning something durable worth a future session, ' +
        'or approaching a compact/clear/new-thread boundary.',
      source: 'runtime',
      content: skill,
    })
  }
}

/**
 * The cap itself. Returning a string denies the call; `undefined` lets it through.
 *
 * Guards are synchronous by contract, so this stays cheap: one basename comparison
 * rejects the overwhelming majority of calls before anything is measured, and the
 * only I/O is a single read of the index on a partial write.
 */
function refuseOversizedIndex(exec, settings) {
  const args = exec?.arguments
  if (!args || typeof args !== 'object') return undefined

  const filePath = args.file_path
  if (typeof filePath !== 'string' || basename(filePath) !== settings.indexName) {
    return undefined
  }

  if (WHOLE_FILE_WRITES.has(exec.name)) {
    if (typeof args.content !== 'string') return undefined
    return verdictFor(args.content, filePath, settings)
  }

  // A partial write (an edit / replace) does not carry the resulting text, and a
  // guard must not do expensive work to reconstruct it. The honest, cheap rule: if
  // the index is ALREADY over, refuse to grow it further. An edit that crosses the
  // line from under it still gets through here — engramory_check.py is the backstop,
  // and the next whole-file write is caught exactly.
  const current = readIfPossible(filePath)
  if (current === undefined) return undefined
  const breach = measure(current, settings)
  if (!breach) return undefined
  return (
    `${settings.indexName} is already over the Engramory cap (${breach}). ` +
    `Editing it further would push it deeper past the limit. Compact it first: ` +
    `pointer-ify over-long lines, merge duplicates, and archive cold notes — the ` +
    `index is a table of contents, and anything past the cap silently stops being ` +
    `recalled.`
  )
}

function verdictFor(text, filePath, settings) {
  const breach = measure(text, settings)
  if (!breach) return undefined
  return (
    `This write would put ${basename(filePath)} over the Engramory index cap ` +
    `(${breach}). The index is loaded every session and the host only reads so far, ` +
    `so anything past the cap silently stops being recalled. Compact before writing: ` +
    `move detail into the linked note files, merge duplicates, archive cold notes, ` +
    `and keep every line to "one short hook + link".`
  )
}

/** Returns a human-readable breach description, or `null` when the text is within caps. */
function measure(text, { maxLines, maxBytes }) {
  const lines = countLines(text)
  const bytes = Buffer.byteLength(text, 'utf8')
  const over = []
  if (lines > maxLines) over.push(`${lines} lines > ${maxLines}`)
  if (bytes > maxBytes) over.push(`${bytes} bytes > ${maxBytes}`)
  return over.length ? over.join(', ') : null
}

/** Trailing-newline-insensitive, matching how the Python guard counts. */
function countLines(text) {
  if (!text) return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/**
 * A missing or unreadable index is not a breach: the guard's job is to stop an
 * oversized index, never to block work because a path could not be read.
 */
function readIfPossible(filePath) {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return undefined
  }
}

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * The always-on block states the discipline; this is the on-demand detail the model
 * pulls when it is actually about to recall, write, or sync. Kept deliberately short —
 * the full protocol is SKILL.md in the Engramory repo, and a skill body that has to be
 * read before it is useful is a skill that will not be read.
 */
function builtinSkillBody() {
  return [
    '# Engramory — curated file-based memory',
    '',
    'One canonical store: `MEMORY.md` is an index of pointers, one line per memory;',
    'each fact lives in its own small markdown file beside it. Never put content in',
    'the index, and never keep a second parallel store for handoffs.',
    '',
    '## Recall',
    '',
    'At the start of a task, read the index and open only the notes whose hooks look',
    'relevant. Treat what you recall as background that may be stale: re-verify any',
    'file, flag, or version against the repo before acting on it.',
    '',
    '## Write',
    '',
    'Before writing, confirm the fact is not already in the repo, git history, or the',
    'instruction files, and that it is not a secret value. Search the index and update',
    'an existing note rather than adding a near-duplicate. A new note is one atomic',
    'fact with frontmatter:',
    '',
    '```markdown',
    '---',
    'name: <kebab-case-slug>',
    'description: <one sharp line — this is what future-you reads to decide to open it>',
    'type: user | feedback | project | reference',
    'scope: global | repo        # optional: does this still hold in another repo?',
    'created: YYYY-MM-DD',
    'updated: YYYY-MM-DD',
    '---',
    '```',
    '',
    '`feedback` and `project` notes MUST carry a `**Why:**` line and a',
    '`**How to apply:**` line. Add exactly one pointer line to the index, and delete',
    'memories that turn out to be wrong.',
    '',
    'Store settled facts, never current state: "2.0 shipped on 2026-01-15" is durable;',
    '"the current version is X", the tip commit, or a passing test count will rot —',
    'record where to read those instead.',
    '',
    '## Sync',
    '',
    'Before a deliberate compact, clear, or new thread: scan the task, dedup and update,',
    'refresh project state, promote only reusable feedback, retire completed transient',
    'state, then report what was added, updated, archived, and skipped.',
    '',
    '## The cap is enforced here',
    '',
    'This host denies a write that would push the index past 200 lines / 25 KB. That is',
    'a real refusal, not a warning: compact first — the index is loaded every session,',
    'and anything past the cap silently stops being recalled.',
    '',
    'Never write credentials, keys, tokens, or cookies into memory — record only where',
    'the secret lives.',
  ].join('\n')
}

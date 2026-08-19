/**
 * dsh-engramory — the Engramory memory discipline as a DeepSeek Harness plugin.
 *
 * Two things the always-on AGENTS.md block cannot do on its own:
 *
 *   1. A DETERMINISTIC index cap. dsh's `ctx.tools.guard()` is a synchronous,
 *      monotonic refusal — once a guard returns a reason, no later waterfall
 *      listener can turn it back into an allow. That makes it a stronger seam than
 *      most hosts expose, and it is why the 200-line / 25 KB limit can be enforced
 *      here rather than merely asked for. Without a shim like this one, everywhere
 *      except Claude Code the cap degrades to "rules plus a checker the agent has to
 *      remember to run".
 *   2. Skill delivery that does not depend on install paths. Registering at runtime
 *      sidesteps the five-root scan entirely, so the protocol is present because the
 *      plugin is loaded, not because a directory happened to be right.
 *
 * The decision table mirrors hooks/engramory_index_guard.py: deny only a write that
 * ENDS over a cap AND grew past the current file — a shrinking rewrite always passes,
 * so an over-cap index can be compacted incrementally (210 → 205 → 198). Only known
 * mutating tools are gated; `read` and unknown tools are never refused (the first cut
 * gated everything that named the index, which blocked recall of an over-cap index at
 * exactly the moment compaction was needed).
 *
 * Zero dependencies, no build step: plain ESM, node: builtins only.
 */
import { readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const name = 'engramory'

// `tools` carries the cap and is the plugin's only declared dependency. Cordis reads
// `inject` as an array of service names (or an object KEYED by them) and treats every
// entry as a hard wait — the `{ required, optional }` shape is older-Cordis syntax that
// the build dsh vendors resolves as services literally named "required"/"optional",
// which never appear, so the plugin sat pending forever (issue #8). `skills` is
// deliberately NOT declared: the cap must mount even on a profile with no skill
// registry, so apply() probes it at runtime instead.
export const inject = ['tools']

/** Mirrors hooks/engramory_index_guard.py — the caps are the protocol's, not this port's. */
const DEFAULT_INDEX_NAME = 'MEMORY.md'
const DEFAULT_MAX_LINES = 200
const DEFAULT_MAX_BYTES = 25600

/** Tools that replace a file wholesale, so the post-write text is in the arguments. */
const WHOLE_FILE_WRITES = new Set(['write'])

/**
 * Tools that mutate a file in place. Only tools named here (plus
 * `str_replace_editor`'s write commands, handled explicitly) count as partial
 * writes. Unknown tools pass through: this guard is a discipline rail, not a
 * security boundary (SECURITY.md), and a false refusal of `read` costs more than a
 * miss — the next whole-file write is measured exactly regardless.
 */
const PARTIAL_WRITES = new Set(['edit', 'str_replace', 'insert'])

export function apply(ctx, config = {}) {
  // `indexPath` pins the guard to ONE file. Without it the only signal is the
  // basename, so an unrelated MEMORY.md in any other project is gated too — a real
  // refusal on a file that is not a memory index at all, with no way to opt out
  // (renaming `indexName` would just unguard the real index). The Claude Code hook
  // has had ENGRAMORY_INDEX_PATH for exactly this; this is its counterpart.
  //
  // The key and the basename are computed ONCE here: guards run on every tool call
  // and must stay cheap, so the per-call path stays a string compare and the single
  // realpath() only happens when the basename already matched.
  const indexPath = typeof config.indexPath === 'string' && config.indexPath.trim()
    ? config.indexPath.trim()
    : undefined
  const settings = {
    indexName: indexNameOf(config.indexName),
    indexPath,
    indexKey: indexPath === undefined ? undefined : pathKey(indexPath),
    // When pinned, the name to match is the pinned file's own basename.
    matchName: (indexPath === undefined
      ? indexNameOf(config.indexName)
      : basename(indexPath)).toLowerCase(),
    maxLines: positive(config.maxLines, DEFAULT_MAX_LINES),
    maxBytes: positive(config.maxBytes, DEFAULT_MAX_BYTES),
  }

  ctx.tools.guard((exec) => refuseOversizedIndex(exec, settings))

  // The skill registry is optional AND may activate after this plugin — fiber order
  // between unrelated providers is not guaranteed, so a one-shot probe here would
  // silently skip registration on such boots. ctx.inject() is Cordis' reactive form:
  // the callback runs once `skills` is available (however late), re-runs if the
  // registry reloads, and never makes the cap wait. A bare `ctx.skills` read at THIS
  // level would throw (undeclared service — issue #8's second crash); inside the
  // callback the service is declared, so the read is legal.
  if (config.registerSkill !== false) {
    ctx.inject(['skills'], (inner) => {
      const skill = config.skill ?? builtinSkillBody()
      // effect() ties the registration to the child fiber: it is disposed when the
      // registry unloads, so a reload cannot accumulate duplicate registrations.
      inner.effect(() => inner.skills.register({
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
      }))
    })
  }
}

/**
 * The cap itself. Returning a string denies the call; `undefined` lets it through.
 *
 * Guards are synchronous by contract, so this stays cheap: one basename comparison
 * rejects the overwhelming majority of calls before anything is measured, and the
 * only I/O is a single read of the index on a gated write.
 */
function refuseOversizedIndex(exec, settings) {
  const args = exec?.arguments
  if (!args || typeof args !== 'object') return undefined

  // dsh's file tools carry the target as `file_path`; `str_replace_editor` calls it
  // `path`. Compare basenames case-INsensitively: on the case-insensitive
  // filesystems most stores live on (Windows/macOS), `memory.md` IS the guarded
  // index, and an exact compare let that spelling through. (Same trade-off as the
  // Python guard: on a case-sensitive FS this can gate an unrelated lowercase twin —
  // rename it, or point `indexName` elsewhere.)
  const filePath = typeof args.file_path === 'string' ? args.file_path
    : typeof args.path === 'string' ? args.path
      : undefined
  if (filePath === undefined) return undefined
  if (basename(filePath).toLowerCase() !== settings.matchName) return undefined

  const tool = typeof exec.name === 'string' ? exec.name : ''

  // Nothing below can refuse a read, a view, or an unknown tool, so leave before the
  // pinned-path check: pathKey() touches the filesystem and a guard runs on EVERY tool
  // call. Ordering it here keeps the common case a pair of string compares.
  const gated = WHOLE_FILE_WRITES.has(tool)
    || PARTIAL_WRITES.has(tool)
    || (tool === 'str_replace_editor'
      && (args.command === 'create' || args.command === 'str_replace'
        || args.command === 'insert'))
  if (!gated) return undefined
  // If the guard is pinned to one file, this is where an unrelated same-named file in
  // another project drops out.
  if (settings.indexKey !== undefined && pathKey(filePath) !== settings.indexKey) {
    return undefined
  }

  if (WHOLE_FILE_WRITES.has(tool)) {
    if (typeof args.content !== 'string') return undefined
    return verdict(args.content, readIfPossible(filePath), filePath, settings)
  }
  if (tool === 'str_replace_editor' && args.command === 'create') {
    if (typeof args.file_text !== 'string') return undefined
    return verdict(args.file_text, readIfPossible(filePath), filePath, settings)
  }

  const partial = PARTIAL_WRITES.has(tool)
    || (tool === 'str_replace_editor'
      && (args.command === 'str_replace' || args.command === 'insert'))
  if (!partial) return undefined // read / view / list / unknown: never refused

  const currentBuf = readIfPossible(filePath)
  if (currentBuf === undefined) return undefined
  const current = currentBuf.toString('utf8')
  const simulated = simulateEdit(current, args)
  if (simulated !== undefined) {
    return verdict(simulated, currentBuf, filePath, settings)
  }

  // The edit's result genuinely cannot be reconstructed from its arguments. Honest,
  // cheap rule: if the index is ALREADY over, refuse to mutate it blind — and name
  // the open door, because "compact first" while refusing edits reads as a dead end.
  const breach = measure(current, settings)
  if (!breach) return undefined
  return (
    `${displayName(settings)} is already over the Engramory cap (${breach}) and this ` +
    `edit's result cannot be measured. Compact it with a whole-file write instead: ` +
    `a rewrite that SHRINKS the index always passes, even while still over the cap. ` +
    `Pointer-ify over-long lines, merge duplicates, archive cold notes — the index ` +
    `is a table of contents, and anything past the cap silently stops being recalled.` +
    notMyIndexHint(settings)
  )
}

/**
 * Mirrors the Python guard's deny rule: refuse only when a dimension ends OVER its
 * cap AND grew past the current file, so a shrinking/keeping write on an over-cap
 * index always passes and incremental compaction stays possible. A missing or
 * unreadable current file counts as empty — a first write past the cap is refused.
 */
function verdict(text, currentBuf, filePath, settings) {
  const lines = countLines(text)
  const bytes = Buffer.byteLength(text, 'utf8')
  // Current byte size comes from the RAW buffer, mirroring how the Python guard
  // sizes the on-disk file: decoding first inflated a non-UTF-8 index ~3x (every
  // bad byte becomes a 3-byte U+FFFD), which made a genuinely growing write look
  // like a shrink and pass. Newlines survive a lossy decode, so the line count may
  // use the decoded text.
  const curLines = currentBuf === undefined ? 0 : countLines(currentBuf.toString('utf8'))
  const curBytes = currentBuf === undefined ? 0 : currentBuf.length
  const over = []
  if (lines > settings.maxLines && lines > curLines) {
    over.push(`${lines} lines > ${settings.maxLines}`)
  }
  if (bytes > settings.maxBytes && bytes > curBytes) {
    over.push(`${bytes} bytes > ${settings.maxBytes}`)
  }
  if (!over.length) return undefined
  return (
    `This write would put ${basename(filePath)} over the Engramory index cap ` +
    `(${over.join(', ')}). The index is loaded every session and the host only reads ` +
    `so far, so anything past the cap silently stops being recalled. Compact before ` +
    `writing: move detail into the linked note files, merge duplicates, archive cold ` +
    `notes, and keep every line to "one short hook + link". A write that SHRINKS the ` +
    `index always passes, so you can compact step by step.` + notMyIndexHint(settings)
  )
}


/**
 * The name to show in a refusal. `indexPath` wins over `indexName` when both are set,
 * so quoting the ignored one would send a user looking for the wrong file.
 */
function displayName(settings) {
  return settings.indexPath === undefined
    ? settings.indexName
    : basename(settings.indexPath)
}


/**
 * Without `indexPath` the guard matches on basename alone, so it can land on a file
 * that is not a memory index at all. Say so in the refusal: a user who hits this
 * needs the way out, not just the cap.
 */
function notMyIndexHint(settings) {
  if (settings.indexPath !== undefined) return ''
  return (
    ` (If this file is NOT your memory index, set this plugin's \`indexPath\` config ` +
    `to your real index's absolute path so only that file is gated.)`
  )
}

/**
 * Reconstruct a partial edit's post-write text when its arguments carry enough to
 * do it (`old_str`/`new_str`, or the Claude-style `old_string`/`new_string`).
 * Mirrors the Python guard's Edit simulation: replace the unique occurrence, or all
 * of them under a replace-all flag; an absent or ambiguous old-string means the
 * real tool errors and changes nothing, so the current text is the honest
 * prediction. Returns undefined when the shape isn't recognised.
 */
function simulateEdit(current, args) {
  const oldStr = firstString(args.old_str, args.old_string)
  if (oldStr === undefined || oldStr === '') return undefined
  const newStr = firstString(args.new_str, args.new_string) ?? ''
  if (args.replace_all === true || args.replaceAll === true) {
    return current.split(oldStr).join(newStr)
  }
  const first = current.indexOf(oldStr)
  if (first === -1) return current // the real tool errors: nothing changes
  const second = current.indexOf(oldStr, first + oldStr.length)
  if (second !== -1) return current // ambiguous: the real tool errors, nothing changes
  return current.slice(0, first) + newStr + current.slice(first + oldStr.length)
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string') return v
  }
  return undefined
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
 * oversized index, never to block work because a path could not be read. Returns the
 * RAW buffer — byte comparisons must use on-disk bytes (see verdict), decode at the
 * call sites that need text.
 */
function readIfPossible(filePath) {
  try {
    return readFileSync(filePath)
  } catch {
    return undefined
  }
}

function positive(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  const floored = Math.floor(value)
  return floored > 0 ? floored : fallback
}

/**
 * Normalise a path for identity comparison. `realpath` resolves symlinks and `..` so
 * two spellings of the same file compare equal, but it throws for a path with no file
 * behind it yet — and a plain `resolve` fallback is NOT interchangeable with it: an
 * index pinned before it exists, under a symlinked ancestor, would be keyed by its
 * alias at config time and by the link's target on every later call. The keys would
 * never match again and the guard would silently stop guarding its own index.
 *
 * So resolve the deepest ancestor that DOES exist and re-attach the missing tail:
 * the same file then keys identically whether or not it exists yet. Case is folded on
 * Windows only, mirroring `os.path.normcase` in the Python guard — folding it on Linux
 * would make an unrelated `memory.md` collide with the pinned index. (Known limit:
 * `toLowerCase` is not NTFS's exact case-folding table, same as the Python guard.)
 */
function pathKey(p) {
  let head = resolve(p)
  const tail = []
  for (;;) {
    try {
      head = realpathSync(head)
      break
    } catch {
      const parent = dirname(head)
      if (parent === head) break // hit the root with nothing resolvable
      tail.unshift(basename(head))
      head = parent
    }
  }
  const out = tail.length ? join(head, ...tail) : head
  return process.platform === 'win32' ? out.toLowerCase() : out
}


/**
 * An empty or non-string indexName must fall back, not silently disable the cap:
 * the numeric caps already recover from nonsense values, and this field is the one
 * that decides whether the guard fires at all.
 */
function indexNameOf(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_INDEX_NAME
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
    'This host denies a write that would GROW the index past 200 lines / 25 KB. That is',
    'a real refusal, not a warning — but a write that shrinks the index always passes,',
    'so compact first, step by step if needed: the index is loaded every session, and',
    'anything past the cap silently stops being recalled.',
    '',
    'Never write credentials, keys, tokens, or cookies into memory — record only where',
    'the secret lives.',
  ].join('\n')
}

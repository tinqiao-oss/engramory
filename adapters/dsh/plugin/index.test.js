/**
 * cd adapters/dsh/plugin && node --test
 *
 * Covers the guard's decision table directly. The guard is the whole point of this
 * plugin — a wrong `undefined` silently drops the cap, and a wrong refusal blocks
 * unrelated work — so every branch is pinned here. The mount() mock mirrors Cordis'
 * reflective context on purpose: a plain-object mock let 0.2.0 ship an `inject`
 * shape and a bare `ctx.skills` read that could never survive real activation
 * (issue #8), so the mock now enforces the same access rules the real host does.
 */
import assert from 'node:assert/strict'
import { execSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs, {
  chmodSync, lstatSync, mkdirSync, mkdtempSync as makeTempDir, readdirSync, realpathSync, renameSync,
  rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { homedir, hostname, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'

import { apply, inject, name } from './index.js'

// A move of the store waits a moment at two steps for writes already under way; not here.
process.env.ENGRAMORY_MOVE_WAIT_MS = '0'

// The temp folders a run makes are removed when it ends, as far as they will go: left behind,
// a few hundred a run had added up to 122,000 on one machine. A link is removed, not followed.
// Not by rmSync: on Windows, Node 24.11 reports success and leaves a non-ASCII path in place.
const made = []
const mkdtempSync = (prefix) => {
  const dir = makeTempDir(prefix)
  made.push(dir)
  return dir
}
function discard(path) {
  try {
    if (!lstatSync(path).isDirectory()) return unlinkSync(path)
    for (const entry of readdirSync(path)) discard(join(path, entry))
    rmdirSync(path)
  } catch { /* gone already, or held open: no verdict on the plugin */ }
}
process.on('exit', () => made.forEach(discard))

// Where neither the config nor dsh names a language, the memory follows the system's:
// pinned here, so the tests read the same on every machine.
let systemLocale = 'en-US'
const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions
Intl.DateTimeFormat.prototype.resolvedOptions = function (...args) {
  return { ...resolvedOptions.apply(this, args), locale: systemLocale }
}

function mount(config = {}, { withSkills = true, workingDirectory, systemPrompt, rowId, projections = projectionRegistry(), services: extra = {}, listeners: early = {} } = {}) {
  let guard
  const skills = []
  const skillRegistry = {
    register: (skill) => {
      skills.push(skill)
      return () => { if (skills.includes(skill)) skills.splice(skills.indexOf(skill), 1) }
    },
  }
  const services = {
    tools: { guard: (fn) => { guard = fn; return () => {} } },
    ...(withSkills ? { skills: skillRegistry } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(projections ? { sessionProjections: projections } : {}),
    ...extra,
  }
  // Mirrors Cordis' reflective context (issue #8): only services named in the
  // caller's inject are readable as properties — anything else throws and must go
  // through ctx.get() (undefined when absent) or a reactive ctx.inject() child whose
  // callback waits for the service. A regression to a bare top-level `ctx.skills`
  // read fails every test in this file, not just a real dsh boot.
  const pending = []
  // the plugin's own fiber, as the profile editor's entries name it. Its entry, as on a real
  // dsh 0.2.1-rc.5: `id` scoped by the include tree, `options.id` the row id the patch names
  const fiber = {
    name: 'engramory fiber',
    ...(rowId === undefined ? {} : { entry: { id: `include:${rowId}`, options: { id: rowId } } }),
  }
  // Cordis' event listeners: `prepend` puts one ahead of those already there. `early`: dsh's
  // own, registered before this plugin's.
  const listeners = new Map(Object.entries(early).map(([event, list]) => [event, [...list]]))
  const on = (event, listener, options) => {
    const list = listeners.get(event) ?? []
    if (options?.prepend === true) list.unshift(listener)
    else list.push(listener)
    listeners.set(event, list)
    return () => { if (list.includes(listener)) list.splice(list.indexOf(listener), 1) }
  }
  // A dsh waterfall: each listener gets the payload and the rest of the chain; at its end,
  // what dsh does on its own.
  const waterfall = (event, args, end) => {
    const list = [...(listeners.get(event) ?? [])]
    const run = (i) => (i < list.length ? list[i](...args, () => run(i + 1)) : Promise.resolve(end()))
    return run(0)
  }
  const signal = new AbortController().signal
  // `system-prompt/assemble`: over the assembly of the runtime contexts dsh will use.
  const assemble = (assembly, context) => waterfall('system-prompt/assemble', [assembly, context], () => assembly)
  // `agent/pre-step`: the step goes ahead with the messages it has queued.
  const preStep = (agent, queued = []) => waterfall('agent/pre-step', [{ agent, turn: 1, step: 1, messages: queued, signal }],
    () => ({ kind: 'enter', messages: [...queued] }))
  // `agent/request-error`: what dsh does about a failed request — `action` from its own
  // listeners (a compaction's retry), none by default.
  const requestError = (agent, action) => waterfall('agent/request-error',
    [{ agent, turn: 1, step: 1, failure: { code: 'CONTEXT_WINDOW_EXCEEDED' }, signal }], () => action)
  const host = { assemble, preStep, requestError }
  if (systemPrompt !== null && typeof systemPrompt === 'object') Object.assign(systemPrompt, host)
  const makeCtx = (declared) => new Proxy({}, {
    get(_, prop) {
      if (prop === 'fiber') return fiber
      if (prop === 'get') return (name) => services[name]
      if (prop === 'effect') return (fn) => fn()
      if (prop === 'on') return on
      if (prop === 'inject') {
        return (deps, callback) => {
          const attempt = () => {
            if (!deps.every((name) => name in services)) return false
            callback(makeCtx(new Set(deps)))
            return true
          }
          if (!attempt()) pending.push(attempt)
        }
      }
      if (typeof prop !== 'string') return undefined
      if (declared.has(prop)) return services[prop]
      throw new Error(`cannot get property "${prop}" without inject`)
    },
  })
  apply(makeCtx(new Set(inject)), config)
  // Simulates a service whose fiber only activates after this plugin's did — fiber
  // order between unrelated providers is not guaranteed on a real boot.
  const mountLate = (name, service) => {
    services[name] = service
    if (name === 'systemPrompt' && service !== null && typeof service === 'object') Object.assign(service, host)
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i]()) pending.splice(i, 1)
    }
  }
  const mountSkillsLate = () => mountLate('skills', skillRegistry)
  return { guard, skills, mountSkillsLate, mountLate, fiber, projections, listeners, ...host }
}

/**
 * dsh's session projections: a registered unit folds a test session's `events` the way
 * dsh drives it over a session's log, from `init` through `apply`.
 */
function projectionRegistry() {
  const units = new Map()
  return {
    units,
    register: (unit) => { units.set(unit.key, unit); return () => units.delete(unit.key) },
    stateOf: (session, key) => {
      const unit = units.get(key)
      if (unit === undefined) throw new Error(`no projection ${key}`)
      return (session.events ?? []).reduce((state, event) => unit.apply(state, event),
        unit.init(session.header, session.inherited ?? 0))
    },
  }
}

/** dsh 0.2's per-session directory owner: `get(session)` is its synchronous read. */
const sessionDirs = () => ({ get: (session) => session.cwd })

/**
 * dsh's prompt registry, keeping every runtime context registered on it — and, once the
 * plugin is mounted with it, a step as dsh takes one (`preStep`, set by mount()).
 */
const promptRegistry = () => {
  const contexts = []
  // The runtime context as dsh renders it: every non-empty context in order; with
  // `optionalOff`, as under a persona preset that turns optional runtime context off, only
  // the required ones (dsh resolves no other).
  const render = (context, { optionalOff = false } = {}) => contexts
    .filter((spec) => !optionalOff || spec.required === true)
    .map((spec) => spec.text(context)).filter(Boolean).join('\n\n')
  const registry = { contexts, render, context: (spec) => { contexts.push(spec); return () => {} } }
  // A step's assembly as dsh makes it: the runtime contexts it will use, resolved, through
  // the `system-prompt/assemble` waterfall.
  registry.assembleFor = (context, { optionalOff = false } = {}) => registry.assemble({
    contexts: contexts.filter((spec) => !optionalOff || spec.required === true)
      .map((spec) => ({ name: spec.name, text: spec.text(context) })),
  }, context)
  // One step: its assembly, the `agent/pre-step` waterfall, then the refresh of the
  // runtime context dsh makes before the request (no waterfall). The plugin's index
  // messages the step delivers; with `commit`, every message it delivers joins the
  // session's events as dsh commits it, for the projections to fold next step.
  registry.sent = async (context, { optionalOff = false, commit = false } = {}) => {
    await registry.assembleFor(context, { optionalOff })
    const decision = await registry.preStep(context?.agent)
    render(context, { optionalOff })
    const messages = decision?.kind === 'enter' ? decision.messages : []
    if (commit) for (const message of messages) committed(context.agent.session, message)
    return messages.filter((m) => m?.source?.kind === 'engramory')
  }
  // The index the step sends, without the message's head ('' for none).
  registry.recall = async (context, options) => (await registry.sent(context, options))
    .map((m) => withoutHead(m.content[0].text)).join('\n\n')
  // All the plugin puts before the model on a step: the runtime context, then the message.
  registry.seen = async (context, options) => {
    const shown = render(context, options)
    const sent = (await registry.sent(context, options)).map((m) => m.content[0].text)
    return [shown, ...sent].filter(Boolean).join('\n\n')
  }
  return registry
}

/** The index message's head, which says it replaces earlier ones, in either language. */
const RECALL_HEADS = ['Engramory memory index, as it stands now', 'Engramory 记忆索引，现在的样子']
const withoutHead = (text) => (RECALL_HEADS.some((h) => text.startsWith(h))
  ? text.slice(text.indexOf('\n\n') + 2)
  : text)

/** One message dsh commits for a step: a `user/message` event appended to the session's log. */
function committed(session, message) {
  session.events ??= []
  const seq = session.events.reduce((last, e) => Math.max(last, e.seq ?? -1), -1) + 1
  session.events.push({ type: 'user/message', seq, data: message, surfaceOp: 'append' })
}

/** Run `fn` with `$DSH_HOME` set to `home` (or unset), then put it back — once it settles. */
function withDshHome(home, fn) {
  const before = process.env.DSH_HOME
  if (home === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = home
  const restore = () => {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
  let result
  try {
    result = fn()
  } catch (error) {
    restore()
    throw error
  }
  if (typeof result?.then === 'function') return result.finally(restore)
  restore()
  return result
}

const INDEX = 'MEMORY.md'
const big = (lines) => Array.from({ length: lines }, (_, i) => `- line ${i}`).join('\n')

function write(file_path, content) {
  return { name: 'write', arguments: { file_path, content } }
}

/**
 * What `fn` returns, and the paths on another machine its synchronous file system calls
 * named. Each such call holds dsh's main thread while that machine does not answer; the
 * hosts in these tests fail fast, so a test can see the call but not the wait.
 */
function sharesTouched(fn) {
  const remote = /^[\\/]{2}(?![?.][\\/][A-Za-z]:)/
  const touched = []
  const watch = (call) => function (p, ...rest) {
    if (typeof p === 'string' && remote.test(p)) touched.push(p)
    return call.call(this, p, ...rest)
  }
  const names = ['statSync', 'lstatSync', 'realpathSync', 'openSync', 'readlinkSync']
  const saved = Object.fromEntries(names.map((n) => [n, fs[n]]))
  for (const n of names) fs[n] = watch(saved[n])
  fs.realpathSync.native = watch(saved.realpathSync.native)
  syncBuiltinESMExports()
  const restore = () => {
    Object.assign(fs, saved)
    syncBuiltinESMExports()
  }
  let result
  try {
    result = fn()
  } catch (error) {
    restore()
    throw error
  }
  // a step resolves its index after dsh's other listeners: watched until it settles
  if (typeof result?.then === 'function') {
    return result.then((value) => ({ result: value, touched })).finally(restore)
  }
  restore()
  return { result, touched }
}

test('plugin metadata is what the loader expects', () => {
  assert.equal(name, 'engramory')
  // An ARRAY of service names. Cordis reads object-form inject as keyed BY service
  // name — `{ required: [...], optional: [...] }` meant "wait for services named
  // required/optional" and the plugin never activated (issue #8). `skills` must stay
  // out of here: every declared service is a hard wait, and the cap has to mount on
  // profiles with no skill registry.
  assert.deepEqual(inject, ['tools'])
})

test('a write well inside the caps passes', () => {
  const { guard } = mount()
  assert.equal(guard(write(`/store/${INDEX}`, big(10))), undefined)
})

test('too many lines is refused, and the reason names the numbers', () => {
  const { guard } = mount()
  const reason = guard(write(`/store/${INDEX}`, big(250)))
  assert.equal(typeof reason, 'string')
  assert.match(reason, /250 lines > 200/)
  assert.match(reason, /compact/i)
})

test('too many bytes is refused even when the line count is fine', () => {
  const { guard } = mount()
  const reason = guard(write(`/store/${INDEX}`, 'x'.repeat(26_000)))
  assert.match(reason, /bytes > 25600/)
})

test('a trailing newline does not inflate the line count past the cap', () => {
  // off-by-one here would refuse a legitimate exactly-at-cap index on every write
  const { guard } = mount()
  assert.equal(guard(write(`/store/${INDEX}`, `${big(200)}\n`)), undefined)
  assert.match(guard(write(`/store/${INDEX}`, `${big(201)}\n`)), /201 lines/)
})

test('any file that is not the index is none of the guard\'s business', () => {
  const { guard } = mount()
  assert.equal(guard(write('/store/some-note.md', big(500))), undefined)
  assert.equal(guard(write('/src/generated.ts', 'x'.repeat(99_000))), undefined)
})

test('caps are configurable, and a nonsense value falls back to the protocol default', () => {
  assert.match(mount({ maxLines: 5 }).guard(write(`/s/${INDEX}`, big(6))), /6 lines > 5/)
  assert.equal(mount({ maxLines: -1 }).guard(write(`/s/${INDEX}`, big(199))), undefined)
  assert.match(mount({ maxLines: -1 }).guard(write(`/s/${INDEX}`, big(201))), /201 lines > 200/)
})

test('a custom index name is honoured', () => {
  const { guard } = mount({ indexName: 'INDEX.md' })
  assert.match(guard(write('/s/INDEX.md', big(300))), /300 lines/)
  assert.equal(guard(write(`/s/${INDEX}`, big(300))), undefined)
})

test('a shrinking whole-file write passes even while the index is still over', () => {
  // The documented compaction path is incremental: 210 -> 205 -> 198. Refusing the
  // 205 rewrite because "205 > 200" wedged an over-cap store completely.
  const dir = mkdtempSync(join(tmpdir(), 'engramory-dsh-'))
  const path = join(dir, INDEX)
  const { guard } = mount()
  writeFileSync(path, big(210), 'utf8')
  assert.equal(guard(write(path, big(205))), undefined, 'shrinking must pass')
  assert.match(guard(write(path, big(215))), /215 lines > 200/, 'growing must be refused')
})

test('reading an over-cap index is never refused', () => {
  // Gating every tool that named the index refused `read` the moment the index went
  // over — recall died exactly when compaction was needed.
  const dir = mkdtempSync(join(tmpdir(), 'engramory-dsh-'))
  const path = join(dir, INDEX)
  writeFileSync(path, big(300), 'utf8')
  const { guard } = mount()
  assert.equal(guard({ name: 'read', arguments: { file_path: path } }), undefined)
  assert.equal(guard({ name: 'str_replace_editor', arguments: { command: 'view', path } }), undefined)
})

test('a simulable edit is judged by its RESULT: shrink passes, growth is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-dsh-'))
  const path = join(dir, INDEX)
  const { guard } = mount()
  writeFileSync(path, `HEAD\n${big(220)}`, 'utf8')
  const shrink = {
    name: 'edit',
    arguments: { file_path: path, old_string: `HEAD\n${big(220)}`, new_string: big(150) },
  }
  assert.equal(guard(shrink), undefined, 'a compacting edit must pass while over')
  const grow = {
    name: 'edit',
    arguments: { file_path: path, old_string: 'HEAD', new_string: big(30) },
  }
  assert.match(guard(grow), /lines > 200/, 'an edit growing an over-cap index must be refused')
  // str_replace_editor names its strings old_str / new_str
  const viaEditor = {
    name: 'str_replace_editor',
    arguments: { command: 'str_replace', path, old_str: 'HEAD', new_str: big(30) },
  }
  assert.match(guard(viaEditor), /lines > 200/)
})

test("an edit is judged on the arguments dsh's edit applies, whatever else the call carries", () => {
  // dsh's edit reads old_string / new_string and ignores other fields: a decoy old_str
  // that matches nothing read first predicted "no change" and let dsh write past the cap
  const dir = mkdtempSync(join(tmpdir(), 'engramory-decoy-'))
  const path = join(dir, INDEX)
  const { guard } = mount()
  writeFileSync(path, `HEAD\n${big(150)}`, 'utf8')
  const real = { file_path: path, old_string: 'HEAD', new_string: big(300) }
  assert.match(guard({ name: 'edit', arguments: real }), /lines > 200/)
  assert.match(guard({ name: 'edit', arguments: { ...real, old_str: 'NOT THERE', new_str: '' } }),
    /lines > 200/)
  // dsh's edit has no replaceAll: an ambiguous old_string is an error there, nothing changes
  writeFileSync(path, `x\nx\n${big(150)}`, 'utf8')
  assert.equal(guard({ name: 'edit',
    arguments: { file_path: path, old_string: 'x\n', new_string: big(30), replaceAll: true } }), undefined)
  // a tool whose schema is not known here is judged on every reading: one growth refuses
  writeFileSync(path, `HEAD\n${big(150)}`, 'utf8')
  assert.match(guard({ name: 'str_replace',
    arguments: { file_path: path, old_str: 'NOT THERE', new_str: '', old_string: 'HEAD', new_string: big(300) } }),
  /lines > 200/)
})

test("str_replace_editor is judged as it edits: by its own path, matching the text as read", () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-editor-'))
  const path = join(dir, INDEX)
  const { guard } = mount()
  // a decoy file_path beside the editor's real `path` read as a write to another file
  writeFileSync(path, big(29), 'utf8')
  assert.match(guard({ name: 'str_replace_editor', arguments: {
    command: 'insert', path, file_path: join(dir, 'README.md'), insert_line: 0, new_str: big(300) } }),
  /lines > 200/)
  // the editor matches raw text: in a file mixing CRLF and LF, `HEAD\r\nX` is one match,
  // though normalising makes it two (ambiguous, no change) and let the growth through
  writeFileSync(path, `HEAD\r\nX\n${big(150)}\nHEAD\nX\n`, 'utf8')
  assert.match(guard({ name: 'str_replace_editor', arguments: {
    command: 'str_replace', path, old_str: 'HEAD\r\nX', new_str: `HEAD\nX\n${big(100)}` } }),
  /lines > 200/)
  // and writes without the BOM it read through, so a BOM does not count against an insert
  writeFileSync(path, `\uFEFF${'a'.repeat(99)}`, 'utf8')
  assert.equal(mount({ maxBytes: 101 }).guard({ name: 'str_replace_editor',
    arguments: { command: 'insert', path, insert_line: 1, new_str: 'b' } }), undefined)
})

test("another plugin's write taking `path` is still judged on it", () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-scoped-'))
  const path = join(dir, INDEX)
  writeFileSync(path, big(10), 'utf8')
  assert.match(mount().guard({ name: 'write', arguments: { path, content: big(300) } }), /300 lines/)
  // and a decoy file_path beside it does not hide it
  assert.match(mount().guard({ name: 'write',
    arguments: { file_path: join(dir, 'CHANGELOG.md'), path, content: big(300) } }), /300 lines/)
})

test('an index name with replacement patterns is named as written', () => {
  assert.match(mount({ indexName: '$&.md', language: 'en' }).skills[0].description, /through \$&\.md /)
})

test('an insert is simulated: one large insert cannot carry the index past the cap', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-insert-'))
  const path = join(dir, INDEX)
  const { guard } = mount()
  writeFileSync(path, big(150), 'utf8')
  const insert = (new_str, insert_line = 1) =>
    guard({ name: 'str_replace_editor', arguments: { command: 'insert', path, insert_line, new_str } })
  assert.equal(insert(big(10)), undefined, 'an insert within the cap passes')
  assert.match(insert(big(100)), /250 lines > 200/)
  assert.equal(insert(big(100), 999), undefined, 'a line out of range is the tool\'s error: nothing changes')
  assert.match(guard({ name: 'insert', arguments: { path, insert_line: 0, new_str: big(100) } }), /lines > 200/)
})

const crlf = (text) => text.split('\n').join('\r\n')

test('a CRLF index is matched the way dsh matches it: on LF-normalised text', () => {
  // dsh's local backend collapses CRLF in the file, old_string and new_string before
  // matching, then writes the result back as CRLF. Matching the raw text read every
  // LF old_string on a CRLF index as "not found", predicted no change, and let a
  // growing edit through that dsh then applied.
  const dir = mkdtempSync(join(tmpdir(), 'engramory-crlf-'))
  const path = join(dir, INDEX)
  writeFileSync(path, crlf(`HEAD\n${big(190)}\n`), 'utf8')
  const { guard } = mount()
  const grow = {
    name: 'edit',
    arguments: { file_path: path, old_string: 'HEAD\n- line 0', new_string: `${big(30)}\n- line 0` },
  }
  assert.match(guard(grow), /lines > 200/, 'an LF old_string still finds its CRLF lines')
  const viaCrlf = { name: 'edit', arguments: { ...grow.arguments, old_string: 'HEAD\r\n- line 0' } }
  assert.match(guard(viaCrlf), /lines > 200/, 'and so does a CRLF one')
  writeFileSync(path, crlf(`HEAD\n${big(210)}\n`), 'utf8')
  const shrink = {
    name: 'edit',
    arguments: { file_path: path, old_string: `HEAD\n${big(20)}\n`, new_string: '' },
  }
  assert.equal(guard(shrink), undefined, 'a compacting edit of an over-cap CRLF index passes')
})

test('an edit of a CRLF index is sized in CRLF, the way dsh writes it back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-crlf-'))
  const path = join(dir, INDEX)
  const row = (c) => c.repeat(198)
  const current = crlf(`HEAD\n${Array.from({ length: 120 }, () => row('x')).join('\n')}`)
  const added = Array.from({ length: 8 }, () => row('y')).join('\n')
  const args = { file_path: path, old_string: 'HEAD', new_string: `HEAD\n${added}` }
  // The case only means something if LF sizing fits and CRLF sizing does not.
  const asLf = Buffer.byteLength(current.replace('HEAD', args.new_string))
  const asCrlf = Buffer.byteLength(current.replace('HEAD', crlf(args.new_string)))
  assert.ok(asLf <= 25600 && asCrlf > 25600, `${asLf} / ${asCrlf}`)
  writeFileSync(path, current, 'utf8')
  assert.match(mount().guard({ name: 'edit', arguments: args }), /bytes > 25600/)
})

test('an edit is sized as dsh writes it back: no BOM, and no doubled CR at a seam', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-crlf-'))
  const path = join(dir, INDEX)
  const { guard } = mount()
  // dsh decodes with TextDecoder, which drops the BOM, and writes the edit back
  // without it: 3 bytes the guard must not count against the result.
  writeFileSync(path, `\uFEFFHEAD\n${'x'.repeat(25590)}`, 'utf8') // 25598 bytes on disk
  assert.equal(guard({
    name: 'edit', arguments: { file_path: path, old_string: 'HEAD', new_string: 'HEADabcde' },
  }), undefined, 'dsh writes 25600 bytes, which is at the cap, not over it')
  // A lone `\r` followed by an inserted `\n` is one CRLF once dsh re-normalises.
  writeFileSync(path, `H\r\n${'x'.repeat(25592)}\rZ\r\n`, 'utf8') // 25599 bytes
  assert.equal(guard({
    name: 'edit', arguments: { file_path: path, old_string: 'Z', new_string: '\nZ' },
  }), undefined, 'dsh writes 25600 bytes, not 25601')
})

test('an unsimulable partial on an over-cap index is refused, naming the open door', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-dsh-'))
  const path = join(dir, INDEX)
  const { guard } = mount()
  writeFileSync(path, big(10), 'utf8')
  // no old string, so nothing says what it replaces
  const blind = {
    name: 'str_replace_editor',
    arguments: { command: 'str_replace', path, new_str: 'x' },
  }
  assert.equal(guard(blind), undefined, 'a healthy index must stay editable')
  writeFileSync(path, big(300), 'utf8')
  const reason = guard(blind)
  assert.match(reason, /already over/)
  assert.match(reason, /whole-file write/, 'the refusal must say how to compact')
})

test('str_replace_editor create is measured like a whole-file write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-dsh-'))
  const path = join(dir, INDEX)
  const { guard } = mount()
  const create = (text) => ({
    name: 'str_replace_editor',
    arguments: { command: 'create', path, file_text: text },
  })
  assert.match(guard(create(big(300))), /300 lines > 200/)
  writeFileSync(path, big(300), 'utf8')
  assert.equal(guard(create(big(150))), undefined, 'a shrinking create must pass')
})

test('the index name matches case-insensitively', () => {
  // On the case-insensitive filesystems most stores live on (Windows/macOS),
  // `memory.md` IS MEMORY.md; an exact compare let that spelling through.
  const { guard } = mount()
  assert.match(guard(write('/s/memory.md', big(300))), /300 lines/)
  assert.match(guard(write('/s/Memory.MD', big(300))), /300 lines/)
})

test('indexPath pins the guard to one file, so a same-named file elsewhere is free', () => {
  // Without this, the only signal is the basename: an unrelated MEMORY.md in any
  // other project got a real refusal, and renaming `indexName` to dodge it would
  // have unguarded the real index. There was no way out; now there is one.
  // The collision that matters is the SAME basename in a DIFFERENT project — that is
  // what an unrelated repo's MEMORY.md looks like. A differently-named file would be
  // let through by basename matching alone and would prove nothing.
  const dir = mkdtempSync(join(tmpdir(), 'engramory-pin-'))
  const otherProject = mkdtempSync(join(tmpdir(), 'unrelated-'))
  const real = join(dir, 'MEMORY.md')
  const unrelated = join(otherProject, 'MEMORY.md')
  writeFileSync(real, '- x\n')
  writeFileSync(unrelated, '- x\n')
  const over = Array.from({ length: 201 }, (_, i) => `- line ${i}`).join('\n')

  const pinned = mount({ indexPath: real }).guard
  assert.match(pinned({ name: 'write', arguments: { file_path: real, content: over } }),
    /over the Engramory index cap/, 'the pinned index must still be guarded')
  assert.equal(pinned({ name: 'write', arguments: { file_path: unrelated, content: over } }),
    undefined, 'a different file must not be gated just because it exists')
})

test('a pinned path is compared by identity, not by spelling', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-pin-'))
  const real = join(dir, 'MEMORY.md')
  writeFileSync(real, '- x\n')
  const over = Array.from({ length: 201 }, (_, i) => `- line ${i}`).join('\n')
  // Same file reached through a redundant `..` segment.
  const detour = join(dir, '..', basename(dir), 'MEMORY.md')

  const guard = mount({ indexPath: detour }).guard
  assert.match(guard({ name: 'write', arguments: { file_path: real, content: over } }),
    /over the Engramory index cap/, 'a `..` detour is the same file')
})

test('a write to another machine is judged by its spelling, without waiting on that machine', (t) => {
  // `\\host\share` names a network share only on Windows; elsewhere it is a relative path
  if (process.platform !== 'win32') return t.skip('UNC paths are a Windows notion')
  const dir = mkdtempSync(join(tmpdir(), 'engramory-pin-'))
  const real = join(dir, 'MEMORY.md')
  writeFileSync(real, '- x\n')
  const over = Array.from({ length: 201 }, (_, i) => `- line ${i}`).join('\n')
  for (const guard of [mount().guard, mount({ indexPath: real }).guard]) {
    for (const unc of ['\\\\no-such-host.invalid\\share\\x.md', '//no-such-host.invalid/share/x.md',
      '\\\\?\\UNC\\no-such-host.invalid\\share\\x.md']) {
      const { result, touched } = sharesTouched(() =>
        guard({ name: 'write', arguments: { file_path: unc, content: over } }))
      assert.equal(result, undefined)
      assert.deepEqual(touched, [], `${unc} was judged without a lookup`)
    }
  }
  // this machine's own drive in the device namespace is looked up as any path is
  const guard = mount({ indexPath: real }).guard
  assert.match(guard({ name: 'write', arguments: { file_path: `\\\\?\\${real}`, content: over } }),
    /over the Engramory index cap/, 'the pinned index spelled \\\\?\\ is still the index')
  // and so is this machine under its other names: an index there may be the pinned one
  for (const host of ['localhost', '127.1', '0--1.ipv6-literal.net', `${hostname()}.`, 'LOCALHOST@SSL']) {
    const { touched } = sharesTouched(() =>
      guard({ name: 'write', arguments: { file_path: `\\\\${host}\\no-such-share\\x.md`, content: over } }))
    assert.notDeepEqual(touched, [], `\\\\${host}\\ is this machine`)
  }
  // a short name on a share is resolved: it may be the index's
  const { touched } = sharesTouched(() => mount().guard({ name: 'write',
    arguments: { file_path: '\\\\no-such-host.invalid\\share\\MEMORY~1.MD', content: over } }))
  assert.notDeepEqual(touched, [])
  // one share under both spellings is one index
  const onShare = mount({ indexPath: '\\\\no-such-host.invalid\\share\\MEMORY.md' }).guard
  assert.match(onShare({ name: 'write',
    arguments: { file_path: '\\\\?\\UNC\\no-such-host.invalid\\share\\memory.md', content: over } }),
  /over the Engramory index cap/)
})

test('pinning an index that does not exist yet still guards its first write', () => {
  // realpath() throws for a path with no file behind it; falling back to resolve()
  // keeps the very first write to a brand-new index gated.
  const dir = mkdtempSync(join(tmpdir(), 'engramory-pin-'))
  const notYet = join(dir, 'MEMORY.md')
  const over = Array.from({ length: 201 }, (_, i) => `- line ${i}`).join('\n')

  const guard = mount({ indexPath: notYet }).guard
  assert.match(guard({ name: 'write', arguments: { file_path: notYet, content: over } }),
    /over the Engramory index cap/)
})

test('an unpinned refusal tells the user how to stop guarding the wrong file', () => {
  const guard = mount().guard
  const over = Array.from({ length: 201 }, (_, i) => `- line ${i}`).join('\n')
  const reason = guard({
    name: 'write',
    arguments: { file_path: '/some/other/project/MEMORY.md', content: over },
  })
  assert.match(reason, /indexPath/, 'the way out has to be in the refusal itself')

  // ...and once pinned, the hint is noise: it no longer applies.
  const dir = mkdtempSync(join(tmpdir(), 'engramory-pin-'))
  const real = join(dir, 'MEMORY.md')
  writeFileSync(real, '- x\n')
  const pinnedReason = mount({ indexPath: real }).guard(
    { name: 'write', arguments: { file_path: real, content: over } })
  assert.doesNotMatch(pinnedReason, /indexPath/)
})

test('a pinned index under a symlinked ancestor keeps its identity once created', (t) => {
  // The dangerous pairing is "does not exist yet" + "symlinked ancestor". Keying the
  // pin with a plain resolve() fallback stored the ALIAS path at config time, while
  // every later call - the file now existing - resolved to the link's TARGET. The two
  // never matched again, so the guard silently stopped guarding its own index: the
  // exact silent-failure shape this project has shipped before.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engramory-link-')))
  const realDir = join(base, 'real-store')
  const aliasDir = join(base, 'alias')
  mkdirSync(realDir)
  try {
    // 'junction' works without elevation on Windows; 'dir' elsewhere.
    symlinkSync(realDir, aliasDir, process.platform === 'win32' ? 'junction' : 'dir')
  } catch {
    t.skip('no symlink privilege here; the assertions need a real link')
    return
  }

  const pinned = join(aliasDir, 'MEMORY.md')
  const guard = mount({ indexPath: pinned }).guard
  const over = Array.from({ length: 201 }, (_, i) => `- line ${i}`).join('\n')

  assert.match(guard({ name: 'write', arguments: { file_path: pinned, content: over } }),
    /over the Engramory index cap/, 'the first write to a not-yet-created index')

  writeFileSync(join(realDir, 'MEMORY.md'), '- x\n') // that first write lands

  assert.match(guard({ name: 'write', arguments: { file_path: pinned, content: over } }),
    /over the Engramory index cap/, 'GUARD WENT SILENT once the index existed')
  assert.match(
    guard({ name: 'write', arguments: { file_path: join(realDir, 'MEMORY.md'), content: over } }),
    /over the Engramory index cap/, 'the same file by its real path is still the index')
})

test('a refusal names the pinned file, not an indexName that is being ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-pin-'))
  const real = join(dir, 'FOO.md')
  writeFileSync(real, Array.from({ length: 201 }, (_, i) => `- line ${i}`).join('\n'))

  // indexPath wins; quoting `indexName` would send the user after the wrong file.
  const guard = mount({ indexPath: real, indexName: 'BAR.md' }).guard
  // No old_str: the edit's result cannot be simulated, which is the branch that
  // quotes the index name back at the user.
  const reason = guard({ name: 'edit', arguments: { file_path: real, new_str: 'x' } })
  assert.match(reason, /FOO\.md is already over/)
  assert.doesNotMatch(reason, /BAR\.md/)
})

test('the skill states the caps and the index the user configured, and the report rule', () => {
  // it said 200 lines / 25 KB and MEMORY.md whatever the guard was set to enforce
  const en = mount({ maxLines: 100, maxBytes: 10000, indexName: 'INDEX.md', language: 'en' }).skills[0]
  assert.match(en.content, /past 100 lines \/ 10000 bytes/)
  assert.match(en.description, /through INDEX\.md/)
  assert.match(mount({ language: 'en' }).skills[0].content, /past 200 lines \/ 25 KB/)
  const zh = mount({ maxLines: 300, maxBytes: 51200, language: 'zh' }).skills[0].content
  assert.match(zh, /超过 300 行 \/ 50 KB/)
  assert.match(en.content, /After any memory write or sync, report/)
  assert.match(zh, /每次写记忆或同步之后，都汇报/)
})

test('an empty or non-string indexName falls back instead of disabling the guard', () => {
  assert.match(mount({ indexName: '' }).guard(write(`/s/${INDEX}`, big(300))), /300 lines/)
  assert.match(mount({ indexName: 42 }).guard(write(`/s/${INDEX}`, big(300))), /300 lines/)
})

test('an indexName that is not a plain file name falls back too', () => {
  // recall joined `sub/INDEX.md` under the store while the guard matched base names, so
  // the nested file recall read could grow past the cap
  for (const indexName of ['sub/INDEX.md', 'sub\\INDEX.md', 'INDEX.md:stream', '..', '.']) {
    const { guard, skills } = mount({ indexName })
    assert.match(guard(write(`/s/${INDEX}`, big(300))), /300 lines/, indexName)
    assert.equal(guard(write('/s/INDEX.md', big(300))), undefined, indexName)
    assert.match(skills[0].content, /`MEMORY\.md`/, indexName)
  }
  // a plain name of another kind is kept
  assert.match(mount({ indexName: 'INDEX.md' }).guard(write('/s/INDEX.md', big(300))), /300 lines/)
})

test('a relative pinned index is the one in the session\'s directory, as recall reads it', async () => {
  // The guard keyed it once, against the process's directory: the file recall read in
  // each session went uncapped, and a file nobody used was guarded instead.
  const a = realpathSync.native(scratch('pin-a'))
  const b = realpathSync.native(scratch('pin-b'))
  for (const dir of [a, b]) mkdirSync(join(dir, 'notes'))
  const { guard } = mount({ indexPath: 'notes/INDEX.md' }, { workingDirectory: sessionDirs() })
  const writeIn = (cwd, file_path) => ({ name: 'write', agent: { session: { cwd } }, arguments: { file_path, content: big(300) } })
  assert.match(guard(writeIn(a, join(a, 'notes', 'INDEX.md'))), /300 lines/)
  assert.match(guard(writeIn(a, 'notes/INDEX.md')), /300 lines/, 'relative, as the tools resolve it')
  assert.equal(guard(writeIn(a, join(b, 'notes', 'INDEX.md'))), undefined, 'another session\'s file is not this one\'s index')
  assert.match(guard(writeIn(b, join(b, 'notes', 'INDEX.md'))), /300 lines/, 'and in that session it is')
  // recall reads the same file
  const prompt = promptRegistry()
  mount({ indexPath: 'notes/INDEX.md' }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  writeFileSync(join(a, 'notes', 'INDEX.md'), '- [a](a.md) - pinned here\n', 'utf8')
  assert.match(await prompt.recall(at(a)), /pinned here/)
})

test('a write through an 8.3 short name is a write to the file it stands for', (t) => {
  if (process.platform !== 'win32') return t.skip('8.3 short names are a Windows form')
  // Node's JS realpath kept `AVERYV~1.MD`: through it, a pinned index, or one matched by a
  // long name, was written past the cap
  const dir = realpathSync.native(scratch('short-names'))
  const long = join(dir, 'averyveryverylongindexname.md')
  writeFileSync(long, '- x\n', 'utf8')
  const short = execSync(`cmd /c for %I in ("${long}") do @echo %~sI`, { encoding: 'utf8' }).trim()
  // the file's own name must have a short form, not only a folder above it
  if (basename(short).toLowerCase() === basename(long).toLowerCase()) return t.skip('this volume makes no 8.3 names')
  assert.match(mount({ indexPath: long }).guard(write(short, big(300))), /300 lines/, short)
  assert.match(mount({ indexName: basename(long) }).guard(write(short, big(300))), /300 lines/, short)
  // and a shrinking write through it still passes
  assert.equal(mount({ indexPath: long }).guard(write(short, '- y\n')), undefined)
})

test('where the OS will not resolve a path, Node\'s walk does, and a link out of a project stays out', async (t) => {
  if (process.platform !== 'win32') return t.skip('the fallback is Windows-only; POSIX resolves natively as before')
  // C:\Recovery and some volumes refuse the OS's realpath (EPERM) where Node's walk works;
  // a spelling fallback would make a junction out of the project read as in it
  const project = realpathSync.native(scratch('native-fails'))
  mkdirSync(join(project, '.git'))
  store(project, '- [p](p.md) - in the project\n')
  const outside = realpathSync.native(scratch('native-fails-out'))
  store(outside, '- [s](s.md) - a secret line\n')
  const linked = realpathSync.native(scratch('native-fails-linked'))
  mkdirSync(join(linked, '.git'))
  symlinkSync(join(outside, '.engramory-memory'), join(linked, '.engramory-memory'), 'junction')
  const native = realpathSync.native
  realpathSync.native = () => { throw Object.assign(new Error('EPERM: refused'), { code: 'EPERM' }) }
  try {
    const prompt = promptRegistry()
    mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
    const home = scratch('native-fails-home')
    assert.match(await withDshHome(home, () => prompt.recall(at(project))), /in the project/)
    assert.doesNotMatch(await withDshHome(home, () => prompt.recall(at(linked))), /secret line/)
    // and the cap still knows a pinned index through it
    const pin = join(project, '.engramory-memory', INDEX)
    assert.match(mount({ indexPath: pin }).guard(write(pin, big(300))), /300 lines/)
  } finally {
    realpathSync.native = native
  }
})

test('a pinned index whose folder becomes a link after start is still the one guarded', () => {
  // its identity was found once, at start: the folder did not exist yet, so the key named
  // the spelling, and once it was a link the file written through it went unmatched
  const base = realpathSync.native(scratch('pin-later'))
  const vault = join(base, 'vault')
  mkdirSync(vault)
  const pin = join(base, 'store', INDEX)
  const { guard } = mount({ indexPath: pin })
  symlinkSync(vault, join(base, 'store'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.match(guard(write(join(vault, INDEX), big(300))), /300 lines/)
  assert.match(guard(write(pin, big(300))), /300 lines/)
})

test('a pin rooted but naming no drive lands on the session\'s drive, as recall resolves it', async (t) => {
  if (process.platform !== 'win32') return t.skip('a drive-less rooted path is a Windows form')
  // `\Users\...\INDEX.md` is "absolute" to Node, yet a session on C: means C:'s file; keyed
  // once against the process's drive (the repo's, often another), the guard missed it
  const dir = realpathSync.native(scratch('pin-drive'))
  const pin = join(dir.slice(2), 'INDEX.md')
  const { guard } = mount({ indexPath: pin }, { workingDirectory: sessionDirs() })
  const exec = { name: 'write', agent: { session: { cwd: dir } }, arguments: { file_path: join(dir, 'INDEX.md'), content: big(300) } }
  assert.match(guard(exec), /300 lines/)
  // and the memory page, which has no session, does not list it as a fixed place
  const shown = (await withHomeAsync(scratch('pin-drive-home'), () => memoryMount({ indexPath: pin }).call())).body
  assert.deepEqual([shown.stores, shown.pinned], [[], 'relative'])
})

test('a sub-1 positive cap falls back rather than flooring to zero', () => {
  const { guard } = mount({ maxLines: 0.5 })
  assert.equal(guard(write(`/s/${INDEX}`, big(199))), undefined)
})

test('a non-UTF-8 current file cannot fake a shrink', () => {
  // Current size must come from RAW bytes: decoding first turned every bad byte
  // into a 3-byte U+FFFD, inflating the current size ~3x — a genuinely growing
  // over-cap write then compared as a "shrink" and passed.
  const dir = mkdtempSync(join(tmpdir(), 'engramory-dsh-'))
  const path = join(dir, INDEX)
  writeFileSync(path, Buffer.alloc(20_000, 0xff))
  const { guard } = mount()
  assert.match(guard(write(path, 'x'.repeat(26_000))), /bytes > 25600/)
})

test('an unreadable or missing index never blocks work', () => {
  const { guard } = mount()
  const edit = { name: 'edit', arguments: { file_path: '/nope/does-not-exist/MEMORY.md' } }
  assert.equal(guard(edit), undefined)
})

test('a relative path is measured in the session\'s directory, not the process\'s', () => {
  // dsh 0.2: after a `working_directory` cd, write/edit resolve a bare MEMORY.md
  // against the SESSION's directory. Measured against process.cwd(), where no index
  // lives, the growing edit read nothing and passed unmeasured, and the shrinking
  // rewrite was judged against an empty file and refused.
  const dir = mkdtempSync(join(tmpdir(), 'engramory-cwd-'))
  writeFileSync(join(dir, INDEX), `HEAD\n${big(210)}`, 'utf8')
  const { guard } = mount({}, { workingDirectory: sessionDirs() })
  const agent = { session: { cwd: dir } }
  const grow = {
    name: 'edit', agent,
    arguments: { file_path: INDEX, old_string: 'HEAD', new_string: big(30) },
  }
  assert.match(guard(grow), /lines > 200/, 'growth through a relative path must be refused')
  assert.equal(guard({ name: 'write', agent, arguments: { file_path: INDEX, content: big(205) } }),
    undefined, 'a shrinking relative rewrite of an over-cap index must pass')
})

test('a pinned index is still the index through a relative path after a cd', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-cwd-'))
  const real = join(dir, INDEX)
  writeFileSync(real, '- x\n')
  const { guard } = mount({ indexPath: real }, { workingDirectory: sessionDirs() })
  const exec = {
    name: 'write', agent: { session: { cwd: dir } },
    arguments: { file_path: INDEX, content: big(201) },
  }
  assert.match(guard(exec), /over the Engramory index cap/)
})

test('a working-directory service that mounts after the plugin is still used', () => {
  // Same window as the late skill registry: the cap must not wait for the service,
  // and must start using it whenever it arrives.
  const dir = mkdtempSync(join(tmpdir(), 'engramory-cwd-'))
  writeFileSync(join(dir, INDEX), `HEAD\n${big(210)}`, 'utf8')
  const late = mount()
  late.mountLate('workingDirectory', sessionDirs())
  const grow = {
    name: 'edit', agent: { session: { cwd: dir } },
    arguments: { file_path: INDEX, old_string: 'HEAD', new_string: big(30) },
  }
  assert.match(late.guard(grow), /lines > 200/)
})

test('no session directory falls back to the process cwd instead of throwing', () => {
  const abs = join(mkdtempSync(join(tmpdir(), 'engramory-cwd-')), INDEX)
  const broken = { get: () => { throw new Error('unknown session') } }
  for (const workingDirectory of [broken, sessionDirs()]) {
    const { guard } = mount({}, { workingDirectory })
    assert.match(guard(write(abs, big(300))), /300 lines/, 'no agent at all')
    assert.match(guard({ name: 'write', agent: { session: {} }, arguments: { file_path: abs, content: big(300) } }),
      /300 lines/, 'a session with no directory of its own')
  }
})

test('without a session directory, a relative path still resolves against the process cwd', () => {
  // dsh 0.1.x has no workingDirectory service; its tools resolve against the process.
  const dir = mkdtempSync(join(tmpdir(), 'engramory-cwd-'))
  writeFileSync(join(dir, INDEX), `HEAD\n${big(210)}`, 'utf8')
  const before = process.cwd()
  process.chdir(dir)
  try {
    const { guard } = mount()
    assert.match(guard({
      name: 'edit', arguments: { file_path: INDEX, old_string: 'HEAD', new_string: big(30) },
    }), /lines > 200/)
    assert.equal(guard(write(INDEX, big(205))), undefined, 'and a shrinking rewrite passes')
  } finally {
    process.chdir(before)
  }
})

test('dsh 0.1: with no working-directory service, a session\'s directory is the one it was opened in', async () => {
  // dsh 0.1's file tools resolve a relative path against the session header's `cwd`
  // (dsh-tool-fs), which need not be the process's — a session dsh opens for a configured
  // agent, say: the guard measures that file, and recall finds the project store there.
  const dir = scratch('header-cwd')
  writeFileSync(join(dir, INDEX), `HEAD\n${big(210)}`, 'utf8')
  const agent = { session: { header: { cwd: dir } } }
  const { guard } = mount()
  assert.match(guard({ name: 'edit', agent, arguments: { file_path: INDEX, old_string: 'HEAD', new_string: big(30) } }),
    /lines > 200/)
  assert.equal(guard({ name: 'write', agent, arguments: { file_path: INDEX, content: big(205) } }), undefined,
    'and a shrinking rewrite passes')
  // dsh 0.2's own directory owner still decides: it moves with `cd`
  const moved = mount({}, { workingDirectory: sessionDirs() })
  assert.equal(moved.guard({
    name: 'edit', agent: { session: { cwd: scratch('moved'), header: { cwd: dir } } },
    arguments: { file_path: INDEX, old_string: 'HEAD', new_string: big(30) },
  }), undefined, 'no index where the session moved to')
  const project = scratch('header-recall')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount({}, { systemPrompt: prompt })
  assert.match(await withDshHome(scratch('home'), () => prompt.recall({ agent: { session: { header: { cwd: project } } } })),
    /- first$/)
})

test('a process cwd that is gone never makes the guard throw', () => {
  // process.cwd() throws (ENOENT uv_cwd) once the directory is deleted. An absolute
  // path does not need it, so it must still be measured; a relative one is let go.
  const abs = join(mkdtempSync(join(tmpdir(), 'engramory-cwd-')), INDEX)
  const { guard } = mount()
  const real = process.cwd
  process.cwd = () => { throw new Error('ENOENT: no such file or directory, uv_cwd') }
  try {
    assert.match(guard(write(abs, big(300))), /300 lines/)
    assert.equal(guard(write(INDEX, big(300))), undefined)
  } finally {
    process.cwd = real
  }
})

/** A file symlink, or null where this platform/user cannot make one (Windows without the privilege). */
function fileLink(target, link) {
  try {
    symlinkSync(target, link, 'file')
    return link
  } catch {
    return null
  }
}

test('a symlink under another name still writes the index, so it is still the index', (t) => {
  // #20: dsh follows a symlink, so `idx.md -> MEMORY.md` writes the index; a guard
  // that decided on the name it was called by let 300 lines through, pinned or not.
  const dir = mkdtempSync(join(tmpdir(), 'engramory-alias-'))
  const real = join(dir, INDEX)
  writeFileSync(real, big(150), 'utf8')
  const alias = fileLink(real, join(dir, 'idx.md'))
  if (alias === null) return t.skip('no symlink privilege here')
  const grow = { name: 'edit', arguments: { file_path: alias, old_string: '- line 0', new_string: big(300) } }
  for (const config of [{}, { indexPath: real }]) {
    const { guard } = mount(config)
    assert.match(guard(write(alias, big(300))), /300 lines > 200/, JSON.stringify(config))
    assert.match(guard(grow), /lines > 200/, JSON.stringify(config))
  }
  assert.equal(mount().guard(write(join(dir, 'other.md'), big(300))), undefined,
    'a file that is not a link to the index is still none of its business')
})

/**
 * Run guard calls in a child node and report each as allow/deny, so a hang or a heap
 * blow-up fails the test with a reason instead of hanging or killing the runner.
 * `calls` is JS source evaluating to an array of executions, built inside the child.
 */
function guardInChild(calls, nodeArgs = []) {
  const script = `
    import { apply } from ${JSON.stringify(new URL('./index.js', import.meta.url).href)}
    let guard
    apply({ tools: { guard: (g) => { guard = g } }, inject: () => {}, on: () => () => {} })
    console.log((${calls}).map((exec) => guard(exec) === undefined ? 'allow' : 'deny').join(','))`
  const run = spawnSync(process.execPath, [...nodeArgs, '--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 15_000 })
  assert.equal(run.error?.code, undefined, 'the guard did not return in time')
  assert.equal(run.status, 0, run.stderr.slice(-400))
  return run.stdout.trim()
}

/** A write past the cap, a small write, an edit — against one path, in the child. */
const threeCalls = (path) => `[
  { name: 'write', arguments: { file_path: ${JSON.stringify(path)}, content: Array.from({ length: 300 }, (_, i) => '- ' + i).join('\\n') } },
  { name: 'write', arguments: { file_path: ${JSON.stringify(path)}, content: '- x' } },
  { name: 'edit', arguments: { file_path: ${JSON.stringify(path)}, old_string: 'a', new_string: 'b' } },
]`

test('a FIFO named like the index cannot hang the host', (t) => {
  // #21: the read runs inside a synchronous guard, on the host's main thread, and a
  // FIFO blocked it forever. Unreadable counts as empty: past the cap is refused, a
  // small write passes, an edit passes.
  if (process.platform === 'win32') return t.skip('no FIFOs on Windows')
  const dir = mkdtempSync(join(tmpdir(), 'engramory-fifo-'))
  const fifo = join(dir, INDEX)
  if (spawnSync('mkfifo', [fifo]).status !== 0) return t.skip('mkfifo unavailable')
  assert.equal(guardInChild(threeCalls(fifo)), 'deny,allow,allow')
})

test('a symlink to a device, named like the index, cannot flood the host', (t) => {
  // #21: a cloned repo's `MEMORY.md -> /dev/zero` grew the host past a gigabyte.
  if (process.platform === 'win32') return t.skip('no /dev/zero on Windows')
  const dir = mkdtempSync(join(tmpdir(), 'engramory-zero-'))
  const zero = fileLink('/dev/zero', join(dir, INDEX))
  if (zero === null) return t.skip('no symlink privilege here')
  assert.equal(guardInChild(threeCalls(zero), ['--max-old-space-size=64']), 'deny,allow,allow')
})

test('an index too large to read whole is still capped on bytes, and can still be compacted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-huge-'))
  const path = join(dir, INDEX)
  const size = 1024 * 1024 + 4096 // past the read limit
  writeFileSync(path, `${'x'.repeat(99)}\n`.repeat(size / 100 + 1), 'utf8')
  const { guard } = mount()
  assert.equal(guard(write(path, 'y'.repeat(size - 1000))), undefined, 'a shrinking rewrite passes')
  assert.match(guard(write(path, 'y'.repeat(size + 200_000))), /bytes > 25600/, 'growth is refused')
  // An edit's result cannot be simulated without the whole text, and refusing it blind
  // would refuse the compacting edits with the rest: it passes, as on an unreadable index.
  const edit = (old_string, new_string) =>
    guard({ name: 'edit', arguments: { file_path: path, old_string, new_string } })
  assert.equal(edit(`${'x'.repeat(99)}\n`, ''), undefined, 'a compacting edit passes')
  assert.equal(edit('x', 'y'), undefined)
})

test('a `..` after a symlinked directory is walked the way dsh walks it', (t) => {
  // #20, second shape: dsh keeps `link/../idx.md` as spelled and lets the OS walk it,
  // so it reaches the parent of the link's TARGET. Resolving it lexically named the
  // parent of the LINK instead — another file than the one written.
  if (process.platform === 'win32') return t.skip('Windows resolves `..` lexically, as dsh does there')
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'engramory-dotdot-')))
  const [a, b] = [join(base, 'a'), join(base, 'b')]
  mkdirSync(a)
  mkdirSync(join(b, 'sub'), { recursive: true })
  for (const dir of [a, b]) {
    writeFileSync(join(dir, INDEX), big(150), 'utf8')
    if (fileLink(join(dir, INDEX), join(dir, 'idx.md')) === null) return t.skip('no symlink privilege here')
  }
  symlinkSync(join(b, 'sub'), join(a, 'link'), 'dir')
  const spelled = join(a, 'link') + '/../idx.md' // lands on b/MEMORY.md
  assert.match(mount().guard(write(spelled, big(300))), /300 lines/, 'unpinned')
  assert.match(mount({ indexPath: join(b, INDEX) }).guard(write(spelled, big(300))), /300 lines/,
    'pinned to the file it lands on')
  assert.equal(mount({ indexPath: join(a, INDEX) }).guard(write(spelled, big(300))), undefined,
    'pinned elsewhere: not this index, so not refused')
})

test('an edit is sized before it is built, so replace_all cannot make the guard allocate', () => {
  // replace_all multiplies new_string by every match: a kilobyte of `x`, each replaced
  // with 64 KB, is a 64 MB result, and with a megabyte a gigabyte — past V8's string
  // limit, which threw out of the guard. Building either just to measure it is the
  // allocation #21 is about, reached through an edit's arguments instead of the disk;
  // a heap-exhausted host aborts, and no catch survives that. Both are refused by
  // their size alone, in a child whose heap could not hold the first.
  // The fourth is a 4 MB new_string of nothing but CRLF: normalising it to measure it
  // was a copy (and a rope of two million pieces) that exhausted the same heap.
  const path = join(mkdtempSync(join(tmpdir(), 'engramory-sized-')), INDEX)
  writeFileSync(path, `${'x'.repeat(1024)}HEAD`, 'utf8')
  const p = JSON.stringify(path)
  const calls = `[
    { name: 'edit', arguments: { file_path: ${p}, old_string: 'x', new_string: 'y'.repeat(65536), replace_all: true } },
    { name: 'edit', arguments: { file_path: ${p}, old_string: 'x', new_string: 'y'.repeat(1048576), replace_all: true } },
    { name: 'edit', arguments: { file_path: ${p}, old_string: 'x', new_string: '$&$&', replace_all: true } },
    { name: 'edit', arguments: { file_path: ${p}, old_string: 'HEAD', new_string: '\\r\\n'.repeat(2097152) } },
  ]`
  assert.equal(guardInChild(calls, ['--max-old-space-size=32']), 'deny,deny,allow,deny',
    'and a `$&` in new_string is literal text, not a pattern')
})

test('an edit too long to build is sized in UTF-8, whatever the configured cap', () => {
  // Past the read limit the result is judged on lower bounds of its size. Counting
  // UTF-16 units there undercounts what dsh writes — an emoji is two units and four
  // bytes — so with a cap above the 16 MiB read limit an over-cap edit passed.
  const path = join(mkdtempSync(join(tmpdir(), 'engramory-sized-')), INDEX)
  writeFileSync(path, 'HEAD', 'utf8')
  const emoji = String.fromCodePoint(0x1F600).repeat(8_600_000) // 17.2 M units, 34.4 MB
  const { guard } = mount({ maxBytes: 20 * 1024 * 1024 })
  assert.match(guard({ name: 'edit', arguments: { file_path: path, old_string: 'HEAD', new_string: emoji } }),
    /at least 34400000 bytes > 20971520/)
})

test('a lone surrogate cannot inflate the size bound into a false refusal', () => {
  // UTF-8 sizes add up only for well-formed text: a lone low and a lone high surrogate
  // each count three bytes, but meeting at a replacement seam they are one four-byte
  // pair. Summed per replacement, this edit's bound was 16777228 bytes against a
  // result of exactly 16777226 — the cap — and it was refused.
  const path = join(mkdtempSync(join(tmpdir(), 'engramory-surrogate-')), INDEX)
  writeFileSync(path, 'xx', 'utf8')
  const lo = String.fromCharCode(0xDC00)
  const hi = String.fromCharCode(0xD800)
  const exec = {
    name: 'edit',
    arguments: { file_path: path, old_string: 'x', new_string: `${lo}${'a'.repeat(8388608)}${hi}`, replace_all: true },
  }
  assert.equal(mount({ maxBytes: 16777226 }).guard(exec), undefined)
  assert.match(mount({ maxBytes: 16777000 }).guard(exec), /at least \d+ bytes > 16777000/,
    'and the length bound still refuses what is truly over')
})

test('a guard that hits something unexpected lets the call through instead of throwing', () => {
  const { guard } = mount()
  const hostile = { name: 'write', get arguments() { throw new Error('boom') } }
  assert.equal(guard(hostile), undefined)
})

test('a directory named like the index is never read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-dir-'))
  mkdirSync(join(dir, INDEX))
  const { guard } = mount()
  assert.match(guard(write(join(dir, INDEX), big(300))), /300 lines/)
  assert.equal(guard(write(join(dir, INDEX), big(3))), undefined)
})

/** A store as the dsh installer lays it out: `<root>/.engramory-memory/MEMORY.md`. */
function store(root, text) {
  mkdirSync(join(root, '.engramory-memory'), { recursive: true })
  writeFileSync(join(root, '.engramory-memory', INDEX), text, 'utf8')
  return join(root, '.engramory-memory', INDEX)
}

const at = (cwd) => ({ agent: { session: { cwd } } })
const scratch = (tag) => mkdtempSync(join(tmpdir(), `engramory-${tag}-`))

test('the index is sent as a message of its own, from the session\'s project store', async () => {
  const project = scratch('inject')
  store(project, '- [a](a.md) - first {{not-a-variable\n- [b](b.md) - second\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  // in the runtime context: a probe with no text, then the reminder before compaction
  // (empty here: no pressure to read) — no index there, which dsh would send again with
  // every change to any part of it
  assert.deepEqual(prompt.contexts.map((c) => c.name), ['engramory:memory-index', 'engramory:compaction'])
  assert.equal(prompt.contexts[0].interpolate, false)
  const [message] = await withDshHome(scratch('home'), () => prompt.sent(at(project)))
  assert.equal(prompt.render(at(project)), '')
  // as dsh's createUserMessage makes one: a user message of its own id, frozen, under a
  // producer kind of the plugin's own, written by nobody; its text taken literally (no
  // `{{` interpolation reaches a message)
  assert.equal(message.role, 'user')
  assert.match(message.id, /^[0-9a-f-]{36}$/)
  assert.ok(Object.isFrozen(message) && Object.isFrozen(message.content) && Object.isFrozen(message.source))
  assert.deepEqual(message.source, { kind: 'engramory', speaker: { role: 'none' } })
  assert.equal(message.content.length, 1)
  const { text } = message.content[0]
  assert.match(text, /^Engramory memory index, as it stands now: it replaces any earlier Engramory index message in this conversation\.\n\nProject memory index \(`.*MEMORY\.md`\), loaded for you by dsh-engramory/)
  assert.match(text, /first \{\{not-a-variable\n- \[b\]\(b\.md\) - second$/)
  assert.doesNotMatch(text, /User memory index/)
})

test('the index is sent once, and again only when what the session should see changes', async () => {
  const repo = scratch('once')
  mkdirSync(join(repo, '.git'))
  mkdirSync(join(repo, 'src'))
  const path = store(repo, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  const session = { cwd: repo }
  const step = () => withDshHome(home, () => prompt.recall({ agent: { session } }, { commit: true }))
  assert.match(await step(), /- first$/)
  assert.equal(await step(), '', 'held already: nothing more')
  session.cwd = join(repo, 'src') // a cd within the project: the same index
  assert.equal(await step(), '', 'a cd that changes nothing the index shows sends nothing')
  writeFileSync(path, '- [a](a.md) - first\n- [b](b.md) - saved since\n', 'utf8')
  assert.match(await step(), /- saved since$/, 'a save: the index again, whole')
  assert.equal(await step(), '')
  assert.equal(session.events.filter((e) => e.data.source.kind === 'engramory').length, 2)
  // a session of its own is sent its own copy
  assert.match(await withDshHome(home, () => prompt.recall(at(repo))), /- saved since$/)
})

test('an index taken out of the conversation by a compaction is sent again', async () => {
  const project = scratch('compacted')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  const session = { cwd: project }
  const step = () => withDshHome(home, () => prompt.recall({ agent: { session } }, { commit: true }))
  const replace = (fields) => session.events.push({
    type: 'user/message', seq: session.events.length,
    data: { role: 'user', id: `c-${session.events.length}`, source: { kind: 'compact-checkpoint' } }, ...fields,
  })
  assert.match(await step(), /- first$/)
  const seq = session.events.at(-1).seq
  // dsh-compaction-basic's checkpoint names what it shadows, and its range
  replace({ sourceEventSeqs: [seq + 100], surfaceOp: { op: 'replace', startSeq: seq + 50, endSeq: seq + 60 } })
  assert.equal(await step(), '', 'a replacement elsewhere leaves it where it is')
  replace({ sourceEventSeqs: [0, seq], surfaceOp: { op: 'replace', startSeq: 0, endSeq: seq } })
  assert.match(await step(), /- first$/, 'shadowed: sent again')
  assert.equal(await step(), '')
  // a range runs in the conversation's order, not in seq order (a replaced tool result is a
  // newer seq in an older place): one that spans the message's seq says nothing about it
  const held = session.events.at(-1).seq
  replace({ sourceEventSeqs: [held - 1], surfaceOp: { op: 'replace', startSeq: 0, endSeq: held + 5 } })
  assert.equal(await step(), '', 'only what the replacement names is gone')
  replace({ surfaceOp: 'append', sourceEventSeqs: [held] }) // an append replaces nothing
  assert.equal(await step(), '')
})

test('each assembly says whether the coming step may carry the index, and a refresh carries no yes over', async () => {
  // dsh refreshes the runtime context it accepted before the request; a preset that turns
  // optional runtime context off for the next assembly must still keep the index out of it
  const project = scratch('gate')
  const path = store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  const session = { cwd: project }
  const step = (options) => withDshHome(home, () => prompt.recall({ agent: { session } }, { commit: true, ...options }))
  assert.match(await step(), /- first$/)
  writeFileSync(path, '- [a](a.md) - changed\n', 'utf8')
  assert.equal(await step({ optionalOff: true }), '', 'that assembly left the memory context out')
  assert.match(await step(), /- changed$/)
})

test('a request retried after a compaction for its length gets back the copy the compaction took', async () => {
  // dsh-compaction-basic compacts on `agent/request-error` and retries within the step,
  // with no pre-step; the copy goes back in as its summary does, appended to the session
  const project = scratch('overflow')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  const { requestError } = mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  const session = { cwd: project, append: (type, data, options) => session.events.push({ type, data, seq: session.events.length, ...options }) }
  const context = { agent: { session } }
  const failed = (action) => withDshHome(home, () => requestError(context.agent, action))
  assert.match(await withDshHome(home, () => prompt.recall(context, { commit: true })), /- first$/)
  const seq = session.events.at(-1).seq
  assert.deepEqual(await failed({ kind: 'retry' }), { kind: 'retry' })
  assert.equal(session.events.length, 1, 'a retry that took nothing out adds nothing')
  session.events.push({ type: 'user/message', seq: session.events.length, surfaceOp: { op: 'replace', startSeq: 0, endSeq: seq },
    sourceEventSeqs: [seq], data: { role: 'user', id: 'cp', source: { kind: 'compact-checkpoint' }, content: [] } })
  assert.equal(await failed(undefined), undefined, 'no retry: nothing to put back')
  assert.equal(session.events.length, 2)
  assert.deepEqual(await failed({ kind: 'retry' }), { kind: 'retry' })
  const back = session.events.at(-1)
  assert.equal(back.type, 'user/message')
  assert.equal(back.surfaceOp, 'append')
  assert.equal(back.data.source.kind, 'engramory')
  assert.match(back.data.content[0].text, /- first$/)
  assert.equal(await withDshHome(home, () => prompt.recall(context, { commit: true })), '', 'held again')
  // a session it cannot append to keeps the retry going
  let tried = 0
  const stuck = { cwd: project, events: session.events.slice(0, 2), append: () => { tried++; throw new Error('closed') } }
  await withDshHome(home, () => prompt.assembleFor({ agent: { session: stuck } }))
  assert.deepEqual(await withDshHome(home, () => requestError({ session: stuck }, { kind: 'retry' })), { kind: 'retry' })
  assert.equal(tried, 1)
})

test('a step dsh rejects, or one aborted, carries no index; what dsh queued comes first', async () => {
  const project = scratch('reject')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  const { listeners } = mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  const steps = listeners.get('agent/pre-step')
  assert.equal(steps.length, 1)
  const [recall] = steps
  const run = (decision, signal = new AbortController().signal) => withDshHome(home, async () => {
    const context = at(project)
    await prompt.assembleFor(context)
    return recall({ agent: context.agent, signal }, () => Promise.resolve(decision))
  })
  assert.deepEqual(await run({ kind: 'reject', reason: 'no' }), { kind: 'reject', reason: 'no' })
  const aborted = new AbortController()
  aborted.abort()
  assert.deepEqual(await run({ kind: 'enter', messages: [] }, aborted.signal), { kind: 'enter', messages: [] })
  assert.deepEqual(await run({ kind: 'enter' }), { kind: 'enter' }, 'a decision without messages is left alone')
  const queued = { role: 'user', id: 'q', source: { kind: 'user' }, content: [] }
  const entered = await run({ kind: 'enter', messages: [queued] })
  assert.equal(entered.messages[0], queued, 'what dsh queued comes first, untouched')
  assert.equal(entered.messages[1].source.kind, 'engramory')
})

test('a persona preset that turns optional runtime context off gets no index; companion mode still does', async () => {
  const project = scratch('optional')
  store(project, '- [a](a.md) - first\n')
  const home = scratch('home')
  const plain = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: plain })
  assert.equal(await withDshHome(home, () => plain.recall(at(project), { optionalOff: true })), '',
    'as the index was optional runtime context before')
  assert.match(await withDshHome(home, () => plain.recall(at(project))), /- first$/)
  const companion = promptRegistry()
  mount({ companion: true }, { workingDirectory: sessionDirs(), systemPrompt: companion })
  assert.match(await withDshHome(home, () => companion.recall(at(project), { optionalOff: true })), /- first$/)
  // a step whose context dsh never resolved (no prompt registry): nothing to go by, nothing sent
  const { preStep } = mount({}, { workingDirectory: sessionDirs() })
  const decision = await withDshHome(home, () => preStep(at(project).agent))
  assert.deepEqual(decision.messages, [])
})

test('without its projection the index is not sent, rather than sent on every step', async () => {
  const project = scratch('noproj')
  store(project, '- [a](a.md) - first\n')
  const home = scratch('home')
  const refusing = projectionRegistry()
  refusing.register = (unit) => { throw new Error(`${unit.key} is taken`) }
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt, projections: refusing })
  assert.equal(await withDshHome(home, () => prompt.recall(at(project))), '')
  const none = promptRegistry()
  const late = mount({}, { workingDirectory: sessionDirs(), systemPrompt: none, projections: null })
  assert.equal(await withDshHome(home, () => none.recall(at(project))), '')
  late.mountLate('sessionProjections', projectionRegistry())
  assert.match(await withDshHome(home, () => none.recall(at(project))), /- first$/, 'a registry that comes up late')
})

test('an index the session should no longer see is withdrawn once, by a note', async () => {
  const project = scratch('withdrawn')
  const path = store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount({ language: 'en' }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  const session = { cwd: project }
  const step = () => withDshHome(home, () => prompt.sent({ agent: { session } }, { commit: true }))
  assert.equal((await step()).length, 1)
  rmSync(path)
  const [note] = await step()
  assert.equal(note.content[0].text,
    'Engramory: no memory index is loaded now; earlier Engramory index messages in this conversation no longer apply.')
  assert.deepEqual(note.source, { kind: 'engramory', speaker: { role: 'none' }, cleared: true })
  assert.deepEqual(await step(), [], 'said once')
  store(project, '- [a](a.md) - back\n')
  assert.match((await step())[0].content[0].text, /- back$/)
  // a session never sent an index is told nothing
  assert.deepEqual(await withDshHome(home, () => prompt.sent(at(scratch('empty')))), [])
})

test('the index projection folds only its own messages, and refuses a state that is not one', () => {
  const projections = projectionRegistry()
  mount({}, { projections })
  const unit = projections.units.get('engramory:recall')
  assert.equal(unit.stateVersion, 1)
  const init = unit.init({}, 0)
  assert.deepEqual(init, { seq: null, digest: null })
  const ours = (seq, text, extra = {}) => ({ type: 'user/message', seq, surfaceOp: 'append',
    data: { role: 'user', id: `r-${seq}`, content: [{ type: 'text', text }], source: { kind: 'engramory', ...extra } } })
  const one = unit.apply(init, ours(3, 'index'))
  assert.equal(one.seq, 3)
  assert.match(one.digest, /^[0-9a-f]{64}$/)
  assert.equal(unit.apply(one, { type: 'user/message', seq: 4, surfaceOp: 'append',
    data: { role: 'user', id: 'u', source: { kind: 'user' }, content: [] } }), one, 'anyone else\'s message changes nothing')
  assert.equal(unit.apply(one, { type: 'assistant/message', seq: 4, surfaceOp: 'append', data: {} }), one)
  assert.equal(unit.apply(one, { type: 'step/start', data: {} }), one, 'an event off the surface')
  assert.deepEqual(unit.apply(one, ours(5, 'x', { cleared: true })), { seq: 5, digest: '' })
  assert.deepEqual(unit.apply(one, { type: 'tool/result', seq: 6, surfaceOp: { op: 'replace' }, sourceEventSeqs: [3] }), init)
  for (const bad of [null, {}, { seq: 1, digest: null }, { seq: null, digest: 'x' }, { seq: -1, digest: '' },
    { seq: 1.5, digest: '' }, { seq: 1, digest: '', more: true }]) {
    assert.throws(() => unit.stateSchema.parse(bad), /not a state of this unit/, JSON.stringify(bad))
  }
  assert.deepEqual(unit.stateSchema.parse(one), one)
  const off = projectionRegistry()
  mount({ injectIndex: false }, { projections: off })
  assert.equal(off.units.size, 0, 'nothing to fold when no index is sent')
})

test('the global store under $DSH_HOME is injected too, and one file only once', async () => {
  const project = scratch('inject')
  const home = scratch('home')
  store(project, '- [p](p.md) - project\n')
  store(home, '- [u](u.md) - user\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const both = await withDshHome(home, () => prompt.recall(at(project)))
  assert.match(both, /Project memory index[\s\S]*- project[\s\S]*User memory index[\s\S]*- user/)
  const once = await withDshHome(home, () => prompt.recall(at(home)))
  assert.equal(once.match(/memory index \(/g).length, 1, 'a session in $DSH_HOME itself sees it once')
})

test('no store means no injection, and a pinned indexPath is the only index injected', async () => {
  const empty = scratch('inject')
  const home = scratch('home')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  assert.equal(await withDshHome(home, () => prompt.recall(at(empty))), '')

  store(empty, '- [p](p.md) - project\n')
  const pinned = join(scratch('pinned'), INDEX)
  writeFileSync(pinned, '- [x](x.md) - pinned\n', 'utf8')
  const pinnedPrompt = promptRegistry()
  mount({ indexPath: pinned }, { workingDirectory: sessionDirs(), systemPrompt: pinnedPrompt })
  const text = await withDshHome(home, () => pinnedPrompt.recall(at(empty)))
  assert.match(text, /^Memory index/)
  assert.match(text, /- pinned$/)
  assert.doesNotMatch(text, /- project/)
})

test('recall does not look into a session directory on another machine', async (t) => {
  if (process.platform !== 'win32') return t.skip('UNC paths are a Windows notion')
  const home = scratch('home')
  store(home, '- [u](u.md) - user\n')
  const unc = '\\\\no-such-host.invalid\\share\\repo'
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const seen = await sharesTouched(() => withDshHome(home, () => prompt.recall(at(unc))))
  assert.deepEqual(seen.touched, [], 'no lookup on the share')
  assert.match(seen.result, /^User memory index[\s\S]*- user$/, 'the store the user placed by name still is')
  // nor a pin relative to it
  const pinPrompt = promptRegistry()
  mount({ indexPath: 'notes/MEMORY.md' }, { workingDirectory: sessionDirs(), systemPrompt: pinPrompt })
  const pinned = await sharesTouched(() => withDshHome(home, () => pinPrompt.recall(at(unc))))
  assert.deepEqual(pinned, { result: '', touched: [] })
  // a pin naming a local drive without its directory lands on that drive, not on the share
  const file = join(scratch('drive-pin'), INDEX)
  writeFileSync(file, '- [x](x.md) - on the local drive\n', 'utf8')
  const drive = file.slice(0, 2)
  // relative to that drive's current directory, wherever Windows keeps it now
  const drivePrompt = promptRegistry()
  mount({ indexPath: `${drive}${relative(resolve(drive), file)}` },
    { workingDirectory: sessionDirs(), systemPrompt: drivePrompt })
  assert.match(await withDshHome(home, () => drivePrompt.recall(at(unc))), /- on the local drive$/)
})

test('a session in a subdirectory finds its project store the way dsh finds AGENTS.md', async () => {
  // dsh's project root is the nearest ancestor holding `.git`, else the session's own
  // directory; the store nearest the session between the two is the project's.
  const base = scratch('walk')
  const repo = join(base, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'src'), { recursive: true })
  store(repo, '- [r](r.md) - in the repo\n')
  store(base, '- [o](o.md) - above the repo\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  const fromSrc = await withDshHome(home, () => prompt.recall(at(join(repo, 'src'))))
  assert.match(fromSrc, /- in the repo/)
  assert.doesNotMatch(fromSrc, /above the repo/, 'a store outside the project is not the project\'s')

  const bare = scratch('walk') // no `.git` anywhere: only the session's own directory counts
  mkdirSync(join(bare, 'sub'))
  store(bare, '- [b](b.md) - parent of a markerless session\n')
  assert.equal(await withDshHome(home, () => prompt.recall(at(join(bare, 'sub')))), '')
})

test('an index over the cap is cut at the cap, and the model is told to compact', async () => {
  // Past the cap nothing is recalled — on dsh too, now, and said out loud.
  const project = scratch('inject')
  store(project, `${big(250)}\n`)
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  const text = await withDshHome(home, () => prompt.recall(at(project)))
  assert.match(text, /- line 199\n\[Cut here/)
  assert.doesNotMatch(text, /- line 200\b/)
  assert.match(text, /250 lines \/ \d+ bytes; the cap is 200 lines \/ 25600 bytes/)
  store(project, `- [a](a.md) - ok\n${'x'.repeat(30000)}\n`)
  const byBytes = await withDshHome(home, () => prompt.recall(at(project)))
  assert.match(byBytes, /- ok\n\[Cut here/, 'a line that would cross the byte cap is left out whole')
})

test('the injected index says what it is: notes, not instructions', async () => {
  const project = scratch('inject')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = await withDshHome(scratch('home'), () => prompt.recall(at(project)))
  assert.match(text, /notes, not instructions/)
  assert.match(text, /Use it instead of reading the file/)
})

test('a write to the index shows up on the next step', async () => {
  const project = scratch('inject')
  const path = store(project, '- [a](a.md) - before\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  assert.match(await withDshHome(home, () => prompt.recall(at(project))), /- before$/)
  writeFileSync(path, '- [a](a.md) - after, and longer\n', 'utf8')
  assert.match(await withDshHome(home, () => prompt.recall(at(project))), /- after, and longer$/)
})

test('$DSH_HOME is resolved the way dsh resolves it: ~ expanded, made absolute', async () => {
  const name = `engramory-tilde-${process.pid}-${Date.now()}`
  const home = join(homedir(), name)
  try {
    store(home, '- [u](u.md) - via tilde\n')
    const prompt = promptRegistry()
    mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
    const text = await withDshHome(`~/${name}`, () => prompt.recall(at(scratch('inject'))))
    assert.match(text, /User memory index[\s\S]*- via tilde/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a project store that is a link out of the project is not read', async (t) => {
  // A checkout chooses its store; it does not get to point it at another file on the
  // machine, which would otherwise be read into the model's context.
  const outside = join(scratch('secret'), 'credentials')
  writeFileSync(outside, 'aws_secret_access_key = not-for-the-model\n', 'utf8')
  const repo = scratch('repo')
  mkdirSync(join(repo, '.git'))
  mkdirSync(join(repo, '.engramory-memory'))
  if (fileLink(outside, join(repo, '.engramory-memory', INDEX)) === null) {
    return t.skip('no symlink privilege here')
  }
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = await withDshHome(scratch('home'), () => prompt.recall(at(repo)))
  assert.doesNotMatch(text, /not-for-the-model/)
  assert.equal(text, '')
})

test('a directory named like the index does not hide the store above it', async () => {
  const repo = scratch('repo')
  mkdirSync(join(repo, '.git'))
  store(repo, '- [r](r.md) - the real one\n')
  mkdirSync(join(repo, 'src', '.engramory-memory', INDEX), { recursive: true })
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = await withDshHome(scratch('home'), () => prompt.recall(at(join(repo, 'src'))))
  assert.match(text, /- the real one$/)
})

test('an index past the byte cap is read only as far as the cap, BOM included', async () => {
  const project = scratch('inject')
  const lines = Array.from({ length: 150 }, (_, i) => `- [n${i}](n${i}.md) - ${'x'.repeat(240)}`)
  store(project, `\uFEFF${lines.join('\n')}\n`)
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = await withDshHome(scratch('home'), () => prompt.recall(at(project)))
  assert.match(text, /\[Cut here: the index is over the Engramory cap \(\d+ bytes; the cap is 200 lines \/ 25600 bytes\)/)
  const body = text.slice(text.indexOf('\n\n') + 2, text.lastIndexOf('\n['))
  assert.ok(Buffer.byteLength(body) + 3 <= 25600, 'what is shown fits the cap with the BOM counted')
  assert.doesNotMatch(body, /\uFEFF/, 'and the BOM itself is not shown')
  assert.match(body, /^- \[n0\]/)
})

test('the skill only says the index is in context when it is', () => {
  const { skills } = mount()
  const flat = skills[0].content.replace(/\s+/g, ' ')
  assert.match(flat, /when one is there, use it instead of reading the file; when none is, read the index of the store above/)
  assert.match(flat, /"Memory index"/)
})

test('a project index that is itself a symlink is not read, even into the project', async (t) => {
  // `.engramory-memory/MEMORY.md -> ../.env` stays inside the checkout and would pass a
  // containment check alone; SKILL.md never reads an index that is a symlink.
  const repo = scratch('repo')
  mkdirSync(join(repo, '.git'))
  writeFileSync(join(repo, '.env'), 'API_KEY=not-for-the-model\n', 'utf8')
  mkdirSync(join(repo, '.engramory-memory'))
  if (fileLink(join(repo, '.env'), join(repo, '.engramory-memory', INDEX)) === null) {
    return t.skip('no symlink privilege here')
  }
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  assert.equal(await withDshHome(scratch('home'), () => prompt.recall(at(repo))), '')
})

test('a project store refused as a link does not hide the user store it points at', async (t) => {
  const home = scratch('home')
  const user = store(home, '- [u](u.md) - the user store\n')
  const repo = scratch('repo')
  mkdirSync(join(repo, '.git'))
  mkdirSync(join(repo, '.engramory-memory'))
  if (fileLink(user, join(repo, '.engramory-memory', INDEX)) === null) {
    return t.skip('no symlink privilege here')
  }
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = await withDshHome(home, () => prompt.recall(at(repo)))
  assert.match(text, /^User memory index[\s\S]*- the user store$/)
})

test('an index replaced by a same-sized file with the same mtime is still re-read', async () => {
  const project = scratch('inject')
  const path = store(project, '- [a](a.md) - before\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  assert.match(await withDshHome(home, () => prompt.recall(at(project))), /- before$/)
  const { mtime } = statSync(path)
  const next = `${path}.next`
  writeFileSync(next, '- [a](a.md) - after!\n', 'utf8') // same length as "before"
  utimesSync(next, mtime, mtime)
  renameSync(next, path)
  assert.match(await withDshHome(home, () => prompt.recall(at(project))), /- after!$/)
})

test('a read that failed once is tried again on the next step', async (t) => {
  if (process.platform === 'win32' || process.getuid?.() === 0) {
    return t.skip('needs POSIX permissions that bind this user')
  }
  const project = scratch('inject')
  const path = store(project, '- [a](a.md) - readable again\n')
  chmodSync(path, 0o000)
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  try {
    assert.equal(await withDshHome(home, () => prompt.recall(at(project))), '')
  } finally {
    chmodSync(path, 0o644)
  }
  assert.match(await withDshHome(home, () => prompt.recall(at(project))), /- readable again$/)
})

/** Run the async `fn` while the synchronous fs `call` fails with `code` — for `path`, or for any fd. */
async function failing(call, code, path, fn) {
  const saved = fs[call]
  fs[call] = function (p, ...rest) {
    if (typeof p !== 'string' || resolve(p) === resolve(path)) {
      throw Object.assign(new Error(`${code}: ${call}`), { code })
    }
    return saved.call(this, p, ...rest)
  }
  syncBuiltinESMExports()
  try {
    return await fn()
  } finally {
    fs[call] = saved
    syncBuiltinESMExports()
  }
}

test('an index found but not read just now is not news that it went away, for a step', async () => {
  // a lock, a refusal or a disk that hiccupped: the session keeps the copy it holds, rather
  // than being told no index applies and then sent the whole index again
  const project = scratch('hiccup')
  const path = store(project, '- [a](a.md) - first\n')
  const home = scratch('home')
  const session = { cwd: project }
  const stepOf = (prompt) => () => withDshHome(home, () => prompt.sent({ agent: { session } }, { commit: true }))
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const step = stepOf(prompt)
  assert.equal((await step()).length, 1)
  // each time changed meanwhile (its size too), so the step reads it again
  let version = 1
  const change = () => writeFileSync(path, `- [a](a.md) - version ${++version} ${'+'.repeat(version)}\n`, 'utf8')
  const latest = () => new RegExp(`- version ${version} \\+{${version}}$`)
  for (const [call, code] of [['openSync', 'EBUSY'], ['statSync', 'EACCES'], ['readSync', 'EIO']]) {
    change()
    assert.deepEqual(await failing(call, code, path, step), [], `${call} ${code}: nothing sent on that step`)
    assert.match((await step())[0].content[0].text, latest(), `${call} ${code}: read again, the change whole`)
  }
  // nor after dsh restarts, with nothing of the index in memory
  const restarted = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: restarted })
  assert.deepEqual(await failing('statSync', 'EACCES', path, stepOf(restarted)), [])
  // not read on the next step either: told as before, as if it were gone
  const [held, told] = await failing('statSync', 'EACCES', path, async () => [await step(), await step()])
  assert.deepEqual(held, [])
  assert.equal(told[0].source.cleared, true)
  assert.match((await step())[0].content[0].text, latest(), 'and sent it again once it is read')
  // one that is gone is withdrawn at once — and a hiccup after that sends nothing back
  rmSync(path)
  assert.equal((await step())[0].source.cleared, true)
  assert.deepEqual(await failing('statSync', 'EACCES', path, async () => [...await step(), ...await step()]), [])
})

test('a store not read for longer than a step holds back no other store\'s index', async () => {
  const repo = scratch('two-stores')
  mkdirSync(join(repo, '.git'))
  const project = store(repo, '- [p](p.md) - project one\n')
  const home = scratch('home')
  const user = store(home, '- [u](u.md) - user\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const session = { cwd: repo }
  const step = () => withDshHome(home, () => prompt.sent({ agent: { session } }, { commit: true }))
  // A save made later, as a real one is: on Windows two writes of one size a few ms apart
  // can keep the same times (a timestamp ticks coarser than that), and recall, which knows a
  // file by its size and times, would take the second for the first (seen on CI).
  let saves = 0
  const save = (text) => {
    writeFileSync(project, text, 'utf8')
    const later = new Date(Date.now() + ++saves * 2000)
    fs.utimesSync(project, later, later)
  }
  assert.match((await step())[0].content[0].text, /- project one[\s\S]*- user$/)
  save('- [p](p.md) - project two\n')
  const [held, told, later] = await failing('statSync', 'EACCES', user, async () => {
    const steps = [await step(), await step()]
    save('- [p](p.md) - project three\n')
    return [...steps, await step()]
  })
  assert.deepEqual(held, [])
  assert.match(told[0].content[0].text, /- project two$/)
  assert.doesNotMatch(told[0].content[0].text, /- user/)
  assert.match(later[0].content[0].text, /- project three$/, 'held back once in a run of such steps, not again')
  assert.match((await step())[0].content[0].text, /- project three[\s\S]*- user$/, 'read again: the whole index')
  // a session holding no copy (a compaction took it) is sent what can be read at once
  const fresh = { cwd: repo }
  const [first] = await failing('statSync', 'EACCES', user,
    () => withDshHome(home, () => prompt.sent({ agent: { session: fresh } }, { commit: true })))
  assert.match(first.content[0].text, /- project three$/)
})

test('a request dsh retries within a step keeps the index held back on that step', async () => {
  // dsh retries a request that failed on the network within its step: no compaction took
  // the copy the session holds, so a store not read just now is still no news
  const project = scratch('retry-held')
  const path = store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  const { requestError } = mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  const session = {
    cwd: project, append: (type, data, options) => session.events.push({ type, data, seq: session.events.length, ...options }),
  }
  const context = { agent: { session } }
  assert.equal((await withDshHome(home, () => prompt.sent(context, { commit: true }))).length, 1)
  await failing('statSync', 'EACCES', path, async () => {
    assert.deepEqual(await withDshHome(home, () => prompt.sent(context, { commit: true })), [], 'held back on the step')
    const before = session.events.length
    assert.deepEqual(await withDshHome(home, () => requestError(context.agent, { kind: 'retry' })), { kind: 'retry' })
    assert.equal(session.events.length, before, 'nothing withdrawn by the retry')
  })
})

test('a project index once shown, then reached through a link out of the project, is not shown again', async () => {
  // the check a project store passes is made again whenever it is re-read, and a hiccup
  // after it was refused brings nothing back
  const repo = scratch('cached-link')
  mkdirSync(join(repo, '.git'))
  const path = store(repo, '- [a](a.md) - first\n')
  const outside = scratch('outside')
  writeFileSync(join(outside, INDEX), '- [s](s.md) - secret\n', 'utf8')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  const session = { cwd: repo }
  const step = () => withDshHome(home, () => prompt.sent({ agent: { session } }, { commit: true }))
  assert.match((await step())[0].content[0].text, /- first$/)
  renameSync(join(repo, '.engramory-memory'), join(repo, 'moved-away'))
  symlinkSync(outside, join(repo, '.engramory-memory'), process.platform === 'win32' ? 'junction' : 'dir')
  const [note] = await step()
  assert.equal(note.source.cleared, true)
  assert.doesNotMatch(note.content[0].text, /secret|first/)
  assert.deepEqual(await failing('statSync', 'EACCES', path, step), [], 'nor does a hiccup bring the old copy back')
})

test('an index read a few bytes at a time is read whole, into one buffer', async () => {
  // a file system may answer a read with less than it asked for: every byte is still read,
  // and no allocation is kept per read
  const project = scratch('short')
  const path = store(project, `${big(150)}\n`)
  const saved = fs.readSync
  const allocUnsafe = Buffer.allocUnsafe
  let reads = 0
  let buffers = 0 // read buffers, not the small ones Node pools
  fs.readSync = function (fd, buffer, offset, length, position) {
    reads++
    return saved.call(this, fd, buffer, offset, Math.min(length, 7), position)
  }
  Buffer.allocUnsafe = function (size) {
    if (size >= 4096) buffers++
    return allocUnsafe.call(this, size)
  }
  syncBuiltinESMExports()
  try {
    const prompt = promptRegistry()
    mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
    assert.match(await withDshHome(scratch('home'), () => prompt.recall(at(project))),
      /\n\n- line 0\n- line 1\n[\s\S]*\n- line 149$/)
    const { guard } = mount()
    assert.match(guard({ name: 'edit', arguments: { file_path: path, old_string: '- line 0\n', new_string: `${big(60)}\n` } }),
      /lines > 200/)
    assert.equal(guard(write(path, big(100))), undefined)
  } finally {
    fs.readSync = saved
    Buffer.allocUnsafe = allocUnsafe
    syncBuiltinESMExports()
  }
  assert.ok(reads > 600, `${reads} reads`)
  assert.ok(buffers <= 6, `${buffers} read buffers for three reads of the index`)
})

test('recall reads no further than the read ceiling, whatever the configured cap', async () => {
  const project = scratch('inject')
  const row = `- [n](n.md) - ${'x'.repeat(1000)}\n`
  store(project, row.repeat(17 * 1024)) // ~17 MiB, past the 16 MiB ceiling
  const prompt = promptRegistry()
  mount({ maxBytes: 64 * 1024 * 1024, maxLines: 1e6 }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = await withDshHome(scratch('home'), () => prompt.recall(at(project)))
  assert.match(text, /\[Cut here: only the first part of this \d+-byte index is shown\.\]$/)
  assert.ok(Buffer.byteLength(text) < 17 * 1024 * 1024)
})

test('past the read ceiling, a line-cap breach is still reported as one', async () => {
  const project = scratch('inject')
  const row = `- [n](n.md) - ${'x'.repeat(1000)}\n`
  store(project, row.repeat(17 * 1024)) // ~17 MiB and 17408 lines
  const prompt = promptRegistry()
  mount({ maxBytes: 64 * 1024 * 1024 }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = await withDshHome(scratch('home'), () => prompt.recall(at(project)))
  assert.match(text, /over the Engramory cap \(more than 200 lines, \d+ bytes; the cap is 200 lines/)
  assert.match(text, /compact the index\.\]$/)
})

test('$DSH_HOME padded with spaces is taken as dsh takes it, not trimmed', async () => {
  const home = scratch('home')
  store(home, '- [u](u.md) - user\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = await withDshHome(` ${home} `, () => prompt.recall(at(scratch('inject'))))
  assert.doesNotMatch(text, /User memory index/)
})

test('injection can be turned off, and a host without runtime context keeps the cap', () => {
  const prompt = promptRegistry()
  mount({ injectIndex: false }, { systemPrompt: prompt })
  // only the reminder before compaction is left, and it says nothing without pressure
  assert.deepEqual(prompt.contexts.map((c) => c.name), ['engramory:compaction'])
  assert.equal(prompt.render(at(scratch('off'))), '')
  const none = promptRegistry()
  mount({ injectIndex: false, compactionReminder: false }, { systemPrompt: none })
  assert.equal(none.contexts.length, 0)
  const { guard } = mount({}, { systemPrompt: {} }) // a registry with no context()
  assert.match(guard(write(`/s/${INDEX}`, big(300))), /300 lines/)
})

test('a prompt registry that mounts after the plugin still gets the index', () => {
  const late = mount({}, { workingDirectory: sessionDirs() })
  const prompt = promptRegistry()
  late.mountLate('systemPrompt', prompt)
  assert.equal(prompt.contexts[0].name, 'engramory:memory-index')
})

test('recall never fails a request', async () => {
  const prompt = promptRegistry()
  mount({}, { workingDirectory: { get: () => { throw new Error('boom') } }, systemPrompt: prompt })
  const real = process.cwd
  process.cwd = () => { throw new Error('ENOENT: uv_cwd') }
  try {
    assert.equal(await prompt.recall(at('/nowhere')), '')
  } finally {
    process.cwd = real
  }
})

test('malformed executions are ignored rather than thrown on', () => {
  const { guard } = mount()
  for (const exec of [undefined, {}, { name: 'write' }, { name: 'write', arguments: null },
    { name: 'write', arguments: { file_path: 42 } },
    { name: 'write', arguments: { file_path: `/s/${INDEX}` } }]) {
    assert.equal(guard(exec), undefined)
  }
})

test('the protocol skill is registered, and carries the parts that matter', () => {
  const { skills } = mount()
  assert.equal(skills.length, 1)
  const skill = skills[0]
  assert.equal(skill.name, 'engramory')
  assert.equal(skill.source, 'runtime')
  assert.ok(skill.description.length > 0 && skill.whenToUse.length > 0)
  // The metadata is what a progressive-disclosure host matches on, so the task
  // bound has to be in it too — not only in the body it loads afterwards.
  assert.match(skill.description, /is not a task/)
  assert.match(skill.description, /never judge that by length/)
  assert.match(skill.whenToUse, /starts no task/)
  assert.match(skill.whenToUse, /Unsure\? Treat it as a task/)
  assert.match(skill.content, /type: user \| feedback \| project \| reference/)
  assert.match(skill.content, /How to apply/)
  assert.match(skill.content, /settled facts/)
  // The write-side rules a downstream store got wrong, asserted on the REGISTERED
  // content rather than the source file, so a comment or dead code cannot satisfy
  // them. Line wrapping is normalised away first: these sentences are wrapped for
  // readability in the source and must not be pinned to a particular break.
  const flat = skill.content.replace(/\s+/g, ' ')
  assert.match(flat, /ACTIVE store is flat/)
  assert.match(flat, /`archive\/` is the one reserved subdirectory/)
  assert.match(flat, /AT MOST ONE live `project` note/)
  assert.match(flat, /Update it IN PLACE/)
  assert.match(flat, /never a second handoff log indexed beside it/)
  assert.match(flat, /A turn, a message, or a session is NOT BY ITSELF a task/)
  assert.match(flat, /NEVER INFER THIS FROM LENGTH/)
  assert.match(flat, /HAVING THE MATERIAL IN HAND does not make work a non-task/)
  assert.match(flat, /CORRECT handling could depend/)
  assert.doesNotMatch(flat, /is BY ITSELF a task/)
  assert.doesNotMatch(flat, /it is false that/i)
  assert.match(flat, /curation checkpoint/)
  assert.match(flat, /judgement, not a write/)
  assert.match(flat, /per-turn log TO THE STORE/)
  assert.match(flat, /timestamp is not a memory/)
})

test('language: zh registers the same rules in Chinese, and how a Chinese store is written', () => {
  const { skills } = mount({ language: 'zh-CN' })
  const skill = skills[0]
  // The metadata carries the task bound too, as in English.
  assert.match(skill.description, /不算任务/)
  assert.match(skill.description, /绝不按长短判断/)
  assert.match(skill.whenToUse, /不开启任务/)
  assert.match(skill.whenToUse, /拿不准就当成任务/)
  // Rule for rule with the English assertions above; emphasis and wrapping removed.
  const flat = skill.content.replace(/\*\*/g, '').replace(/\s+/g, '')
  for (const rule of [
    'type:user|feedback|project|reference',
    '活跃库是平的', '`archive/`是唯一保留的子目录',
    '最多保留一条活的`project`笔记', '就地更新', '绝不在旁边再索引一份交接日志',
    '一轮对话、一条消息、一次会话，本身都不算任务', '绝不按长短判断',
    '材料已经在手上也不会让工作变成非任务', '正确处理可能取决于库里内容',
    '只存定论，不存当前状态',
    '策展检查', '它是一次判断，不是一次写入', '绝不往库里追加逐轮日志', '时间戳不是记忆',
    // §1.1: what changes in a Chinese store, and what does not
    '`为什么：`', '`怎么用：`', 'frontmatter的键和`type:`的取值保持英文',
    '`##用户`/`##反馈`/`##项目`/`##参考`', '一个类型绝不留两个标题', '全库唯一',
  ]) assert.ok(flat.includes(rule), 'zh skill lacks: ' + rule)
})

test('the skill says where the store is: the global one the AI creates, a project\'s only the user does', () => {
  // A plugin-only install used to say nowhere: a model in a fresh workspace searched the
  // disk, then wrote its first index into the session's directory, where recall and the
  // memory page never look.
  const home = scratch('skillhome')
  const global = join(home, '.engramory-memory')
  // wrapping is not part of a rule: English collapses whitespace, Chinese drops it
  const flatten = { en: (s) => s.replace(/\s+/g, ' '), zh: (s) => s.replace(/\*\*/g, '').replace(/\s+/g, '') }
  for (const [language, rules] of [
    ['en', [`Your store is the global one: \`${global}\`, its index \`MEMORY.md\``,
      'create the folder and the index if they do not exist yet',
      'only the user creates one — never create it yourself',
      'what holds only in that project goes there',
      'anything you are unsure of go in the global store',
      'Never write `MEMORY.md` or a note anywhere else, and never search the disk for memory',
      'when none is, read the index of the store above, if there is one yet']],
    ['zh', [`你的记忆库是全局库：\`${global}\`，索引是 \`MEMORY.md\``,
      '文件夹或索引还不存在就新建', '只能由用户来建，你绝不自己建', '只在这个项目成立的事记在那里',
      '以及拿不准的，记在全局库', '绝不在别处写 `MEMORY.md` 或笔记，也绝不满盘搜索记忆',
      '没有就读上面那个记忆库的索引']],
  ]) {
    const flat = flatten[language]
    const content = flat(withDshHome(home, () => mount({ language })).skills[0].content)
    for (const rule of rules) assert.ok(content.includes(flat(rule)), `${language}: ${rule}`)
    // a companion's own life is not a project's
    const companion = flat(withDshHome(home, () => mount({ language, companion: true })).skills[0].content)
    assert.ok(companion.includes(flat(language === 'en' ? 'the user, your own life, how' : '关于用户的、你自己的人生、')), language)
    // a pinned index is the one store: no global store, no project stores
    const pinned = join(home, 'notes', 'INDEX.md')
    const one = flat(withDshHome(home, () => mount({ language, indexPath: pinned })).skills[0].content)
    assert.ok(one.includes(flat(language === 'en' ? `This host pins one index: \`${pinned}\`` : `本宿主固定了一个索引：\`${pinned}\``)), language)
    assert.ok(one.includes(flat(language === 'en' ? 'Never write `INDEX.md`' : '绝不在别处写 `INDEX.md`')), language)
    assert.ok(!one.includes(flat(global)), language)
    assert.ok(!one.includes(flat(language === 'en' ? 'never create it yourself' : '你绝不自己建')), language)
    // without the index in context, where a project's own store would be, and only there
    const blind = flat(withDshHome(home, () => mount({ language, injectIndex: false })).skills[0].content)
    assert.ok(blind.includes(flat(language === 'en'
      ? 'Look for its index there, nearest first, and nowhere else, and skip an index that is a link or leads out of the project'
      : '只在这一段里找它的索引，离工作目录近的优先，别处都不找；索引是链接、或指到项目外面的，跳过')), language)
    assert.ok(!blind.includes(flat(language === 'en' ? 'context shows its index' : '上下文里会出现它的「项目记忆索引」')), language)
    // with the index in context, a pointer line is added without reading the index whole
    // again: dsh 0.2 asks only that the file was read once before an edit
    const rereadNot = language === 'en'
      ? 'add that line without reading the whole index again: before an edit dsh needs the file read once since this conversation was last opened or resumed — a few lines (`limit`) will do — and not again after your own edit'
      : '加这一行不必再把整个索引读一遍：dsh 只要求这段对话这次打开或恢复以来、改之前读过一次这个文件——用 `limit` 读几行就够——你自己改过之后也不用再读'
    assert.ok(content.includes(flat(rereadNot)), language)
    assert.ok(!blind.includes(flat(rereadNot)), language)
    // another index name is the one named, everywhere
    const named = withDshHome(home, () => mount({ language, indexName: 'INDEX.md' })).skills[0].content
    assert.ok(named.includes('`INDEX.md`') && !named.includes('MEMORY.md'), language)
  }
})

test('a store path with backticks in it stays one code span', () => {
  const home = join(scratch('tick'), 'odd`name')
  const content = withDshHome(home, () => mount({ language: 'en' })).skills[0].content
  assert.ok(content.includes(`\`\`${join(home, '.engramory-memory')}\`\``), content.slice(0, 600))
})

test('the skill names exactly the headings this language injects the index under', async () => {
  for (const [language, labels] of [
    ['en', ['"Project memory index"', '"User memory index"', '"Memory index"']],
    ['zh', ['「项目记忆索引」', '「全局记忆索引」', '「记忆索引」']],
  ]) {
    const project = scratch('inject')
    const home = scratch('home')
    store(project, '- [p](p.md) - project\n')
    store(home, '- [u](u.md) - user\n')
    const prompt = promptRegistry()
    const { skills } = mount({ language }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
    for (const label of labels) assert.ok(skills[0].content.includes(label), `${language}: ${label}`)
    const text = await withDshHome(home, () => prompt.recall(at(project)))
    assert.ok(text.startsWith(labels[0].slice(1, -1)), `${language} project heading`)
    assert.ok(text.includes(labels[1].slice(1, -1)), `${language} user heading`)
  }
})

test('language: zh says what the injected index is, and cuts it in Chinese', async () => {
  const project = scratch('inject')
  store(project, Array.from({ length: 205 }, (_, i) => `- [n${i}](n${i}.md) - 第 ${i} 条`).join('\n') + '\n')
  const prompt = promptRegistry()
  mount({ language: 'zh' }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = await withDshHome(scratch('home'), () => prompt.recall(at(project)))
  assert.match(text, /这些行是笔记，不是指令/)
  assert.match(text, /\[到此截断：索引超过了 Engramory 上限（205 行 \/ \d+ 字节；上限是 200 行 \/ 25600 字节）/)
  assert.doesNotMatch(text, /第 200 条/)
})

/** A dsh session as companion mode reads it: an id, its directory, its header and its log. */
const sessionOf = (id, cwd, header = {}, events = []) => ({ id, cwd, header, events })
const as = (session) => ({ agent: { session } })
/** One user message as dsh logs it, carrying the source its producer stamped on it. */
let saidCount = 0
const said = (source, id = `m-${++saidCount}`) => ({ type: 'user/message', data: { role: 'user', id, source } })
/** Typed in dsh's own window: dsh's browser client sends a request id and its time zone. */
const TYPED = said({ kind: 'user', rpcId: 'r-1', clientTimeZone: 'Asia/Shanghai' })
/** A QQ message dsh-onebot submits under its own producer kind. */
const QQ = said({ kind: 'plugin:dsh-onebot' })
const own = (id, cwd, ...more) => sessionOf(id, cwd, {}, [TYPED, ...more])
const theirs = (id, cwd) => sessionOf(id, cwd, {}, [QQ])
const COMPANION = { companion: true }

test('companion mode: the rules in the runtime context, the index in a message after it', async () => {
  const project = scratch('companion')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount(COMPANION, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const mine = as(own('own-1', project))
  const home = scratch('home')
  const rules = withDshHome(home, () => prompt.render(mine))
  assert.match(rules, /^Companion mode \(大肥鱼模式\) is on[\s\S]*`moment`[\s\S]*`upcoming`[\s\S]*`self`/)
  assert.doesNotMatch(rules, /- first/)
  assert.match(await withDshHome(home, () => prompt.seen(mine)),
    /`self`[\s\S]*\n\nEngramory memory index, as it stands now[\s\S]*Project memory index[\s\S]*- \[a\]\(a\.md\) - first/)
})

test('a profile still set to social mode, gone in 2.0, gets no memory anywhere; the cap holds', async () => {
  // companion mode with `audience: social` was a character others talk to: the private recall
  // left would hand them the memory, so none at all until a save on the settings page
  const project = scratch('closed')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  const m = mount({ companion: true, audience: 'social' }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  assert.equal(m.skills.length, 0, 'no skill')
  assert.deepEqual(prompt.contexts, [], 'no rules, no index context, no reminder')
  const home = scratch('home')
  assert.doesNotMatch(await withDshHome(home, () => prompt.seen(as(own('own-1', project)))), /first|Companion/)
  assert.match(m.guard(write(`/s/${INDEX}`, big(300))), /200/)
  // without companion mode the old setting never did anything, and still does not
  assert.equal(mount({ audience: 'social' }).skills.length, 1)
})

test('outside social mode, an index the session should no longer see is withdrawn by a note', async () => {
  // private companion mode: every conversation is the user's; the store going away is what
  // takes the index from it
  const project = scratch('companion')
  const path = store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount({ companion: true }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  const session = theirs('qq-private', project)
  const step = () => withDshHome(home, () => prompt.sent(as(session), { commit: true }))
  assert.match((await step())[0].content[0].text, /- first/)
  rmSync(path)
  const [withdrawn] = await step()
  assert.equal(withdrawn.source.cleared, true)
  assert.deepEqual(await step(), [])
  assert.match(prompt.render(as(session)), /Companion mode/, 'its own message made nobody a stranger')
})

test('companion rules name the three life headings and keep "delete only when asked" to moment and self', () => {
  for (const [language, ...rules] of [
    ['en', 'Delete a `moment` or `self` note only when the user asks you to forget it',
      '`## moment`', '`## upcoming`', '`## self`', 'rewrite it as a `moment`',
      'never inventing an outcome', 'When you play a character for the user here'],
    ['zh', '`moment` 和 `self` 笔记只有用户说忘掉才删',
      '`## 经历`', '`## 约定`', '`## 我自己`', '问到结果再改写成 `moment`', '结果绝不自己编',
      '你在这里为用户扮演角色时'],
  ]) {
    const project = scratch('companion')
    const prompt = promptRegistry()
    mount({ ...COMPANION, language }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
    const text = withDshHome(scratch('home'), () => prompt.render(as(own('own-1', project))))
    for (const rule of rules) assert.ok(text.includes(rule), `${language}: ${rule}`)
  }
})

test('companion mode tells the skill a companion conversation is the exception to "not a task"', () => {
  for (const [language, mark] of [['en', 'Companion mode is the exception'], ['zh', '大肥鱼模式是例外']]) {
    const on = mount({ ...COMPANION, language }).skills[0]
    assert.ok(on.description.includes(mark), `${language} description`)
    assert.ok(on.content.includes(mark), `${language} body`)
    const off = mount({ language }).skills[0]
    assert.ok(!off.description.includes(mark) && !off.content.includes(mark), `${language} off`)
  }
})

test('companion mode adds the three life types to the skill, in either language', () => {
  for (const [language, marks] of [
    ['en', ['## Companion mode: three types for your life', '`moment` (`## moment`)',
      '`upcoming` (`## upcoming`)', '`self` (`## self`)', 'archive/moments-2026-10.md',
      'never record an outcome you were not told',
      '`moment`, name it with the date it happened (usually the name it has), move its',
      'without a date in its name', '`feedback`; what you',
      'These lifecycles override "store settled facts" and "delete memories that turn out',
      'say never happened at all', 'day it was saved — and with a plain name while it has none',
      'note until you learn it', 'a lasting fact it settled (the new job is theirs) goes into',
      'never a second copy of the `user` fact', 'rename it once it has a date',
      '"call yourself 小胖"', 'corrected in place (renaming it, with its index line,',
      'one where you', 'play a character for the user']],
    ['zh', ['## 大肥鱼模式：再加三类，记你的人生', '`moment`（`## 经历`）',
      '`upcoming`（`## 约定`）', '`self`（`## 我自己`）', 'archive/经历-2026-10.md',
      '没听用户说过的结果绝不自己编', '类型改成 `moment`，名字用实际发生的日期',
      '名字不带日期', '（用户平时怎么叫你）记 `self`', '「以后叫自己小胖」', '有了日期再改名',
      '就连文件名和索引行',
      '优先于上面的「只存定论」和「发现记错了的记忆就删掉」', '用户说某件事根本没发生过也算',
      '绝不写记下它的那天', '还没日期就先用普通名字', '问到之前笔记一直留着', '同时记进 `user`',
      '不再抄一遍 `user` 里的事实', '（你为用户扮演角色的对话）']],
  ]) {
    const on = mount({ ...COMPANION, language }).skills[0]
    assert.match(on.content, /type: user \| feedback \| project \| reference \| moment \| upcoming \| self/)
    for (const mark of marks) assert.ok(on.content.includes(mark), `${language}: ${mark}`)
    assert.ok(on.whenToUse.length > mount({ language }).skills[0].whenToUse.length)
    const off = mount({ language }).skills[0]
    assert.doesNotMatch(off.content, /`moment`|`upcoming`|`self`|\| moment/)
  }
  // only `companion: true` turns it on, not a string that reads like it
  for (const value of ['true', 1, 'yes']) {
    assert.doesNotMatch(mount({ companion: value }).skills[0].content, /\| moment/, String(value))
  }
})

test('companion mode keeps its rules with injectIndex: false, which only drops the index', async () => {
  const project = scratch('companion')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount({ ...COMPANION, injectIndex: false, language: 'zh' },
    { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  const mine = as(own('own-1', project))
  assert.match(withDshHome(home, () => prompt.render(mine)), /^大肥鱼模式已打开。你在这里为用户扮演角色时/)
  assert.doesNotMatch(await withDshHome(home, () => prompt.seen(mine)), /first/, 'no index')
})

test('the memory language follows dsh: the config first, then dsh\'s own choice, then the system\'s', () => {
  const chinese = (skill) => skill.content.startsWith('# Engramory — 策展式文件记忆')
  const locale = (preference) => ({ configEditor: { entries: () => [
    { options: { id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: preference === undefined ? {} : { preference } } },
  ] } })
  systemLocale = 'zh-CN'
  try {
    assert.equal(chinese(mount({}).skills[0]), true, 'nothing chosen: the system\'s')
    assert.equal(chinese(mount({}, { services: locale(undefined) }).skills[0]), true, 'dsh left to the system')
    assert.equal(chinese(mount({}, { services: locale('en') }).skills[0]), false, 'dsh set to English')
    assert.equal(chinese(mount({ language: 'en' }, { services: locale('zh') }).skills[0]), false, 'the config wins')
    // an editor that fails, or none: the system's
    assert.equal(chinese(mount({}, { services: { configEditor: { entries: () => { throw new Error('x') } } } }).skills[0]), true)
  } finally {
    systemLocale = 'en-US'
  }
  assert.equal(chinese(mount({}).skills[0]), false)
  assert.equal(chinese(mount({}, { services: locale('zh-CN') }).skills[0]), true, 'dsh set to Chinese')
  assert.equal(chinese(mount({ language: 'zh' }).skills[0]), true)
})

test('a profile editor that comes up after the plugin still sets the language, skill and index alike', async () => {
  // dsh activates services in no fixed order: the editor that holds dsh's language may
  // arrive after this plugin has registered its skill in the system's language
  const project = scratch('lang')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  systemLocale = 'zh-CN'
  try {
    const m = mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
    assert.equal(m.skills.length, 1)
    assert.ok(m.skills[0].content.startsWith('# Engramory — 策展式文件记忆'))
    // the index already shown, and its project store remembered, before the editor arrives
    const home = scratch('home')
    const session = { cwd: project }
    const step = () => withDshHome(home, () => prompt.sent({ agent: { session } }, { commit: true }))
    const [zh] = await step()
    assert.match(zh.content[0].text, /^Engramory 记忆索引，现在的样子[\s\S]*\n\n项目记忆索引/)
    m.mountLate('configEditor', { entries: () => [
      { options: { id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'en' } } },
    ] })
    assert.equal(m.skills.length, 1, 'registered again, not twice')
    assert.ok(m.skills[0].content.startsWith('# Engramory — curated file-based memory'))
    // the conversation that holds the Chinese index is sent the English one
    const [en] = await step()
    assert.match(withoutHead(en.content[0].text), /^Project memory index/)
  } finally {
    systemLocale = 'en-US'
  }
})

test('an unknown language falls back to English', () => {
  for (const language of ['fr', '', 42, 'zhx']) {
    const { skills } = mount({ language })
    assert.match(skills[0].description, /is not a task/, String(language))
  }
})

test('skill registration can be declined, and a skill-less host still gets the cap', () => {
  assert.equal(mount({ registerSkill: false }).skills.length, 0)
  const { guard } = mount({}, { withSkills: false })
  assert.match(guard(write(`/s/${INDEX}`, big(300))), /200/)
})

test('a skill registry that activates after the plugin still gets the skill', () => {
  // Adversarial review of the issue-#8 fix caught this window: a one-shot
  // ctx.get() probe silently skipped registration whenever the registry's fiber
  // activated later than this plugin's. The reactive ctx.inject() child must pick
  // it up whenever it arrives — and a declined registration must stay declined.
  const late = mount({}, { withSkills: false })
  assert.equal(late.skills.length, 0)
  late.mountSkillsLate()
  assert.equal(late.skills.length, 1)
  assert.equal(late.skills[0].name, 'engramory')

  const declined = mount({ registerSkill: false }, { withSkills: false })
  declined.mountSkillsLate()
  assert.equal(declined.skills.length, 0)
})


test('companion context is required, so a persona preset with optional context off keeps it', async () => {
  // dsh-persona `includeRuntimeContext: false` (the shipped `minimal` preset) drops
  // optional contexts; seen on a real dsh, the owner then got no memory at all
  const project = scratch('companion')
  store(project, '- [birthday](birthday.md) - May 3\n')
  const prompt = promptRegistry()
  mount(COMPANION, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const off = (session) => withDshHome(scratch('home'),
    () => prompt.seen(as(session), { optionalOff: true }))
  const owner = await off(own('own-1', project))
  assert.match(owner, /- \[birthday\]\(birthday\.md\) - May 3/)
  assert.match(owner, /Companion mode \(大肥鱼模式\)/)
  assert.deepEqual(prompt.contexts.map((c) => [c.name, c.required === true]),
    [['engramory:memory', true], ['engramory:compaction', true]])

  // without companion mode the index stays optional, as every preset expects — `audience:
  // social` alone changes nothing
  for (const config of [{}, { audience: 'social' }]) {
    const plain = promptRegistry()
    mount(config, { workingDirectory: sessionDirs(), systemPrompt: plain })
    assert.deepEqual(plain.contexts.map((c) => [c.name, 'required' in c]),
      [['engramory:memory-index', false], ['engramory:compaction', false]])
  }
})

/**
 * dsh's services as the reminder before compaction reads them: the token meter, the session
 * projections with the `contextPressure` unit, the compaction engine (its `config`; by
 * default as dsh 0.1.7 on resolves it, headroom and all) and the model registry — each
 * session's `tokens` and `window` from `now`. `compaction: null` is a dsh with none.
 */
function pressureOf(now, { projections = projectionRegistry(), compaction = { config: { headroomTokens: 65536 } }, llm } = {}) {
  const fold = projections.stateOf
  projections.stateOf = (session, key) => {
    if (key !== 'contextPressure') return fold(session, key)
    const { window } = now(session)
    return window === undefined ? { surfaceTokens: 0 } : { surfaceTokens: 0, contextWindow: window }
  }
  return {
    projections,
    services: {
      tokenMeter: { measure: (session) => ({ totalTokens: now(session).tokens }) },
      ...(compaction === null ? {} : { compaction }),
      ...(llm === undefined ? {} : { llm }),
    },
  }
}

/** A session routed to a model, as dsh's request header has it, with `config` over it. */
const routed = (config = {}) => ({
  id: 's', requestHeader: () => ({ config: { provider: 'deepseek', model: 'flash', ...config } }),
})

/**
 * A mount's reminder before compaction, and `said(tokens, session?)` for what it says then;
 * the session by default reserves 250000 output tokens of its request.
 */
function reminderOf(now, config = {}, options = {}) {
  const prompt = promptRegistry()
  mount(config, { systemPrompt: prompt, ...pressureOf(() => now, options) })
  const reminder = prompt.contexts.find((c) => c.name === 'engramory:compaction')
  const fallback = routed({ maxTokens: 250000 })
  const said = (tokens, session = fallback) => {
    now.tokens = tokens
    return reminder?.text({ agent: { session } })
  }
  return { prompt, reminder, said }
}

test('before dsh compacts a conversation, its model is told to save what is worth keeping', () => {
  // a 1M window, 250000 reserved: dsh compacts past min(800000, 1000000 - 250000 - 65536) = 684464
  const now = { tokens: 0, window: 1000000 }
  const { prompt, reminder, said } = reminderOf(now)
  assert.equal(reminder.order > prompt.contexts[0].order, true) // after the index
  assert.equal(said(580000), '')
  assert.match(said(582000), /close to its context limit[\s\S]*save it now[\s\S]*No need to tell the user/)
  // on until the conversation is well below where it came on, so it does not flicker
  assert.notEqual(said(480000), '')
  assert.equal(said(479000), '')
  assert.equal(said(580000), '')
  // one fixed sentence: dsh sends the runtime context again whenever it changes
  assert.equal(said(600000), said(680000))
  // a compaction leaves the conversation small, and the reminder goes
  assert.equal(said(100000), '')
  // each conversation by itself
  said(600000)
  assert.equal(said(500000, routed({ maxTokens: 250000 })), '')
})

test('the reminder comes before dsh compacts as dsh is set up: the output reserved, its ratio, a model\'s own policy', async () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  // the request's own output cap: min(800000, 1000000 - 100000 - 65536) = 800000, on at 680000
  let { said } = reminderOf({ window: 1000000 })
  assert.equal(said(679000, routed({ maxTokens: 100000 })), '')
  assert.notEqual(said(681000, routed({ maxTokens: 100000 })), '')
  // else the model's default, asked of dsh once, in the background: nothing until it answers
  const asked = []
  const answer = { defaultMaxTokens: 400000 }
  const llm = { resolveModelInfo: async (provider, model, signal) => {
    asked.push([provider, model, signal instanceof AbortSignal])
    return answer
  } }
  ;({ said } = reminderOf({ window: 1000000 }, {}, { llm }))
  const s = routed()
  assert.equal(said(900000, s), '')
  await tick()
  // min(800000, 1000000 - 400000 - 65536) = 534464, on at 454294
  assert.equal(said(454000, s), '')
  assert.notEqual(said(455000, s), '')
  assert.deepEqual(asked, [['deepseek', 'flash', true]])
  // a model with no default reserves nothing, as the engine has it: 800000, on at 680000
  delete answer.defaultMaxTokens
  const other = routed({ model: 'plain' })
  said(0, other)
  await tick()
  assert.equal(said(679000, other), '')
  assert.notEqual(said(681000, other), '')
  // a lookup that fails gives no reminder, and is not asked again at once
  let failures = 0
  const failing = { resolveModelInfo: () => { failures++; throw new Error('no such model') } }
  ;({ said } = reminderOf({ window: 1000000 }, {}, { llm: failing }))
  assert.equal(said(900000, routed()), '')
  await tick()
  assert.equal(said(900000, routed()), '')
  assert.equal(failures, 1)
  // the engine's own ratio and headroom, a model's own policy over them
  const compaction = { config: { thresholdRatio: 0.5, headroomTokens: 0,
    modelPolicies: [{ provider: 'deepseek', model: 'pro', thresholdRatio: 0.6 }] } }
  ;({ said } = reminderOf({ window: 1000000 }, {}, { compaction }))
  assert.equal(said(424000), '') // min(500000, 750000) = 500000, on at 425000
  assert.notEqual(said(426000), '')
  const pro = routed({ model: 'pro', maxTokens: 250000 })
  assert.equal(said(509000, pro), '') // 600000, on at 510000
  assert.notEqual(said(511000, pro), '')
  // dsh 0.1.5's engine, whose config has no headroom: the window times the ratio, nothing else
  ;({ said } = reminderOf({ window: 64000 }, {}, { compaction: { config: { thresholdRatio: 0.8 } } }))
  assert.equal(said(43000, routed({ maxTokens: 8192 })), '') // 51200, on at 43520
  assert.notEqual(said(44800, routed({ maxTokens: 8192 })), '')
  // two routes that would read alike joined by a slash are asked about apart
  const defaults = { 'a/b|c': 100000, 'a|b/c': 400000 }
  const routes = { resolveModelInfo: async (provider, model) => ({ defaultMaxTokens: defaults[`${provider}|${model}`] }) }
  ;({ said } = reminderOf({ window: 1000000 }, {}, { llm: routes }))
  const first = routed({ provider: 'a/b', model: 'c' })
  const second = routed({ provider: 'a', model: 'b/c' })
  said(0, first)
  said(0, second)
  await tick()
  assert.equal(said(460000, first), '') // 800000, on at 680000
  assert.notEqual(said(460000, second), '') // 534464, on at 454294
})

test('no reminder where the engine would refuse to compact: a kept tail no smaller than the point', () => {
  // 0.1.7 on: min(800000, 1000000 - 250000 - 640000) = 110000, the tail 0.16 of 750000 = 120000
  const big = { compaction: { config: { headroomTokens: 640000 } } }
  assert.equal(reminderOf({ window: 1000000 }, {}, big).said(100000), '')
  // a model's own tail over the engine's: 50000 kept of 110000, so it compacts, on at 93500
  const own = { compaction: { config: { headroomTokens: 640000,
    modelPolicies: [{ provider: 'deepseek', model: 'flash', retainTokens: 50000 }] } } }
  assert.notEqual(reminderOf({ window: 1000000 }, {}, own).said(100000), '')
  // 0.1.5: 80000 to compact at, 90000 to keep
  const old = { compaction: { config: { thresholdRatio: 0.8, retainTokens: 90000 } } }
  assert.equal(reminderOf({ window: 100000 }, {}, old).said(85000), '')
})

test('no reminder of a compaction that will not come, or without a measure and a window; it can be turned off', () => {
  const at = (now, config = {}, options = {}) => reminderOf(now, config, options).said(now.tokens)
  const full = { tokens: 900000, window: 1000000 }
  assert.notEqual(at(full), '')
  assert.equal(at(full, {}, { compaction: null }), '') // no compaction engine
  assert.equal(at(full, {}, { compaction: { config: { auto: false } } }), '') // none on its own
  // a conversation not yet routed to a model, which the engine does not compact
  assert.equal(reminderOf(full).said(900000, { id: 's' }), '')
  assert.equal(at({ tokens: 900000 }), '') // no request has recorded a window yet
  assert.equal(at({ tokens: 900000, window: 0 }), '')
  assert.equal(at({ tokens: Number.NaN, window: 1000000 }), '')
  // 300000 - 250000 - 65536 < 0: no room to compact in, which dsh itself refuses to work with
  assert.equal(at({ tokens: 290000, window: 300000 }), '')
  assert.equal(at(full, { compactionReminder: false }), undefined)
  assert.match(at(full, { language: 'zh' }), /快到上下文上限了[\s\S]*现在照 Engramory skill 存好/)
  // no meter or no projections on this host, or a meter that throws: nothing, and the request goes on
  const bare = promptRegistry()
  mount({}, { systemPrompt: bare, projections: null, services: { compaction: { config: {} } } })
  assert.equal(bare.contexts.find((c) => c.name === 'engramory:compaction').text({ agent: { session: routed() } }), '')
  const failing = promptRegistry()
  mount({}, { systemPrompt: failing, services: { compaction: { config: {} },
    tokenMeter: { measure: () => { throw new Error('replay') } } } })
  assert.equal(failing.contexts.find((c) => c.name === 'engramory:compaction').text({ agent: { session: routed() } }), '')
})

// --- the settings page's routes (client.js) ---

/** A mount with dsh's web server, the profile editor on this plugin's own row, and `extra`. */
/** The bundle patch's own row config: what a profile override is compared with. */
const BUNDLE_ROW = { indexName: 'MEMORY.md', maxLines: 200, maxBytes: 25600 }

function webMount(config = {}, { rowConfig = config, extra = {}, editor: makeEditor, rowId } = {}) {
  const m = mount(config, { rowId })
  const routes = []
  const edits = []
  const entry = { fiber: m.fiber, options: { id: 'engramory', name: 'dsh-engramory', config: rowConfig } }
  const editor = makeEditor ? makeEditor(entry, edits) : {
    entries: () => [entry],
    // like dsh's editor: `change(current, inherited)`; a result equal to the inherited
    // config drops the override (recorded here as `null`)
    edit: async (target, change) => {
      const next = change(structuredClone(target.options.config ?? {}), structuredClone(BUNDLE_ROW))
      const dropped = JSON.stringify(next) === JSON.stringify(BUNDLE_ROW)
      edits.push(dropped ? null : next)
      target.options.config = next
    },
  }
  for (const [key, service] of Object.entries({ configEditor: editor, ...extra })) {
    if (service !== undefined) m.mountLate(key, service)
  }
  m.mountLate('connection', {
    fetch: {
      // dsh's registry takes a path once and throws on a second (dsh-client-connection)
      register: (route) => {
        if (routes.some((r) => r.path === route.path)) {
          throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
        }
        routes.push(route)
        return async () => {}
      },
    },
  })
  const call = async (method, body) => {
    const route = routes.find((r) => r.methods.includes(method) && r.path === '/api/engramory/settings')
    const init = { method }
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body)
      init.headers = { 'content-type': 'application/json' }
    }
    const response = await route.fetch(new Request(`http://127.0.0.1${route.path}`, init))
    return { status: response.status, body: await response.json() }
  }
  return { ...m, routes, call, edits, entry }
}

const saveBody = (revision, patch = {}) => ({
  revision, companion: true, maxLines: 200, maxBytes: 25600, ...patch,
})

test('settings routes: none without a web server, one exact route for both methods with it', () => {
  const headless = mount({})
  assert.ok(headless.guard) // a headless dsh mounts the cap as before
  const { routes } = webMount({})
  // the memory page's route, the store's and its chooser's come with it, from the same row
  assert.deepEqual(routes.map((r) => [r.path, r.methods.join(), r.requestBody]),
    [['/api/engramory/settings', 'GET,POST', 'buffered'], ['/api/engramory/memory', 'GET,POST', 'buffered'],
      ['/api/engramory/store', 'GET,POST', 'buffered'], ['/api/engramory/store/pick', 'POST', 'buffered']])
})

test('settings GET: the row settings as the plugin reads them, and whether a save can land', async () => {
  const { call } = webMount({}, {
    rowConfig: { indexName: 'MEMORY.md', language: 'zh-CN', companion: true, audience: 'social', maxLines: 0 },
    // the language follows dsh: the page neither shows nor writes it
  })
  const { status, body } = await call('GET')
  assert.equal(status, 200)
  const shown = { companion: true, maxLines: 200, maxBytes: 25600 }
  // still set to social mode, gone in 2.0: the page says the memory is closed (closedBySocial)
  assert.deepEqual(body, { ...shown, closed: true, revision: JSON.stringify(shown), editable: true })
  // only `true` is companion mode on, as apply() reads it
  const other = (await webMount({}, { rowConfig: { companion: 'yes', audience: 'social' } }).call('GET')).body
  assert.equal(other.companion, false)
  assert.equal(other.closed, undefined)
})

test('settings POST on a row still set to social mode takes it out, and the memory is back', async () => {
  const w = webMount({}, { rowConfig: { ...BUNDLE_ROW, companion: true, audience: 'social' } })
  const { body: shown } = await w.call('GET')
  assert.equal(shown.closed, true)
  assert.deepEqual(await w.call('POST', saveBody(shown.revision)), { status: 200, body: { ok: true } })
  assert.deepEqual(w.edits.at(-1), { indexName: 'MEMORY.md', companion: true })
  assert.equal((await w.call('GET')).body.closed, undefined)
})

test('settings route: served by the bundle\'s own row, never by a second row of the package', () => {
  assert.equal(webMount({}, { rowId: 'engramory' }).routes.length, 4) // settings, memory, store and its chooser
  // a second row would claim the same paths, or claim them first and have the page save it
  assert.equal(webMount({}, { rowId: 'engramory-2' }).routes.length, 0)
})

test('settings route: a row of the same id in a nested include does not fail to mount', () => {
  const taken = new Set(['/api/engramory/settings'])
  const m = mount({}, { rowId: 'engramory' })
  assert.doesNotThrow(() => m.mountLate('connection', {
    fetch: {
      register: (route) => {
        if (taken.has(route.path)) throw new Error(`connection: exact Fetch route ${route.path} is already registered`)
        return async () => {}
      },
    },
  }))
})

test('settings: a setting written as a !!js expression makes the page read-only, and is never taken for a default', async () => {
  const expression = { __jsExpr: 'true' } // how dsh hands an unevaluated `!!js` value to the editor
  // the whole row's config as one expression: none of the fields is there to check
  const whole = webMount({}, { rowConfig: { __jsExpr: "({ companion: true, audience: 'social' })" } })
  const { body: wholeShown } = await whole.call('GET')
  assert.equal(wholeShown.editable, false)
  assert.equal(wholeShown.readOnly, 'expression')
  assert.deepEqual(await whole.call('POST', saveBody(wholeShown.revision)),
    { status: 409, body: { ok: false, error: 'expression' } })
  assert.equal(whole.edits.length, 0)
  for (const key of ['companion', 'maxLines']) {
    const w = webMount({}, { rowConfig: { ...BUNDLE_ROW, [key]: expression } })
    const { body } = await w.call('GET')
    assert.equal(body.editable, false, key)
    assert.equal(body.readOnly, 'expression', key)
    assert.deepEqual(await w.call('POST', saveBody(body.revision)),
      { status: 409, body: { ok: false, error: 'expression' } })
    assert.equal(w.edits.length, 0)
  }

  // an inherited expression: saving the defaults must not hand it back as "the defaults"
  const inheritedExpr = webMount({}, {
    rowConfig: { indexName: 'MEMORY.md', companion: true },
    editor: (entry, edits) => ({
      entries: () => [entry],
      edit: async (target, change) => {
        edits.push(change(structuredClone(target.options.config), { indexName: 'MEMORY.md', companion: expression }))
      },
    }),
  })
  const { body: shown } = await inheritedExpr.call('GET')
  await inheritedExpr.call('POST', saveBody(shown.revision, { companion: false }))
  assert.deepEqual(inheritedExpr.edits.at(-1), { indexName: 'MEMORY.md' }) // an override, so the expression no longer applies
})

test('settings POST refuses a save when the profile it would rewrite now holds an expression', async () => {
  // the editor reads the profile afresh: a `!!js` value written in between reads as a
  // default, and the revision alone would not tell
  const w = webMount({}, {
    rowConfig: { ...BUNDLE_ROW },
    editor: (entry, edits) => ({
      entries: () => [entry],
      edit: async (target, change) => {
        edits.push(change({ ...BUNDLE_ROW, companion: { __jsExpr: 'true' } }, structuredClone(BUNDLE_ROW)))
      },
    }),
  })
  const { body: shown } = await w.call('GET')
  assert.deepEqual(await w.call('POST', saveBody(shown.revision, { companion: false })),
    { status: 409, body: { ok: false, error: 'expression' } })
  assert.equal(w.edits.length, 0)
})

test('settings GET without the editor: read-only, from the plugin config', async () => {
  const { call } = webMount({ companion: true }, { editor: () => undefined })
  const { body } = await call('GET')
  assert.equal(body.editable, false)
  assert.equal(body.readOnly, 'editor')
  assert.equal(body.companion, true)
})

test('settings POST saves through the profile editor, keeping other fields and writing defaults as absence', async () => {
  const w = webMount({}, {
    rowConfig: { indexName: 'MEMORY.md', indexPath: '/pinned/MEMORY.md', maxLines: 200, maxBytes: 25600,
      injectIndex: false },
  })
  const { body: shown } = await w.call('GET')
  const saved = await w.call('POST', saveBody(shown.revision, { maxLines: 150 }))
  assert.deepEqual(saved, { status: 200, body: { ok: true } })
  // the caps go in only where they differ from the plugin's defaults, so a later default is
  // not masked; a key this page does not know is carried over as it is
  assert.deepEqual(w.edits.at(-1), {
    indexName: 'MEMORY.md', indexPath: '/pinned/MEMORY.md', injectIndex: false, maxLines: 150,
    companion: true,
  })
  // back to the defaults: a field the page does not edit (indexPath) keeps the override
  const { body: again } = await w.call('GET')
  await w.call('POST', saveBody(again.revision, { companion: false }))
  assert.deepEqual(w.edits.at(-1), { indexName: 'MEMORY.md', indexPath: '/pinned/MEMORY.md', injectIndex: false })
})

test('settings POST back to the defaults on a bundle-only row hands back the inherited config, dropping the override', async () => {
  const w = webMount({}, { rowConfig: { ...BUNDLE_ROW } })
  const { body: shown } = await w.call('GET')
  await w.call('POST', saveBody(shown.revision))
  assert.deepEqual(w.edits.at(-1), { indexName: 'MEMORY.md', companion: true })
  const { body: again } = await w.call('GET')
  await w.call('POST', saveBody(again.revision, { companion: false }))
  assert.equal(w.edits.at(-1), null) // equal to the inherited config: the editor drops the override
})

test('settings POST accepts any positive cap a profile may already carry', async () => {
  const w = webMount({}, { rowConfig: { maxLines: 250000, maxBytes: 300 * 1024 * 1024 } })
  const { body: shown } = await w.call('GET')
  const result = await w.call('POST', saveBody(shown.revision, { maxLines: 250000, maxBytes: 300 * 1024 * 1024 }))
  assert.deepEqual(result, { status: 200, body: { ok: true } })
})

test('settings POST refuses a save made against settings that changed in between', async () => {
  const w = webMount({}, { rowConfig: { maxLines: 200 } })
  const { body: shown } = await w.call('GET')
  w.entry.options.config = { maxLines: 200, companion: true } // edited elsewhere
  const result = await w.call('POST', saveBody(shown.revision, { companion: false }))
  assert.deepEqual(result, { status: 409, body: { ok: false, error: 'stale' } })
  assert.equal(w.edits.length, 0)
  assert.equal(w.entry.options.config.companion, true)
})

test('settings POST rejects malformed values, naming the field, and writes nothing', async () => {
  const w = webMount({})
  const { body: shown } = await w.call('GET')
  for (const [patch, field] of [
    [{ companion: 'true' }, 'companion'],
    [{ companion: undefined }, 'companion'],
    [{ maxLines: 0 }, 'maxLines'],
    [{ maxBytes: 1.5 }, 'maxBytes'],
    [{ revision: undefined }, 'revision'],
  ]) {
    const result = await w.call('POST', saveBody(shown.revision, patch))
    assert.deepEqual(result, { status: 400, body: { ok: false, error: 'invalid', field } }, field)
  }
  assert.deepEqual(await w.call('POST', 'not json'),
    { status: 400, body: { ok: false, error: 'invalid', field: 'body' } })
  assert.equal(w.edits.length, 0)
})

test('settings POST reports what the profile editor refused', async () => {
  for (const [message, status, error] of [
    ['Configuration for "engramory" is overridden by a home patch or command-line overlay', 409, 'overridden'],
    ['Profile patch must be a YAML sequence', 500, 'failed'],
  ]) {
    const w = webMount({}, {
      editor: (entry) => ({ entries: () => [entry], edit: async () => { throw new Error(message) } }),
    })
    const { body: shown } = await w.call('GET')
    const result = await w.call('POST', saveBody(shown.revision))
    assert.deepEqual(result, { status, body: { ok: false, error, message } })
  }
})

test('settings POST writes only this plugin own row, never another of the same package', async () => {
  const w = webMount({}, {
    editor: (entry, edits) => {
      const other = { fiber: { name: 'another row' }, options: { ...entry.options, id: 'engramory-2' } }
      return { entries: () => [other], edit: async (target, change) => { edits.push(change({}, {})) } }
    },
  })
  const { body: shown } = await w.call('GET')
  assert.equal(shown.editable, false)
  assert.deepEqual(await w.call('POST', saveBody(shown.revision)),
    { status: 409, body: { ok: false, error: 'unavailable' } })
  assert.equal(w.edits.length, 0)
})

test('settings: the own row found as dsh 0.2.2 keeps its fiber, an awaitable object over it', async () => {
  // dsh 0.2.2-rc.1 (cordis-plugin-loader 1.1.0) keeps on a row what cordis' plugin() returns,
  // Object.create(fiber) with a `then`, where 0.2.1 kept `.ctx.fiber`, the fiber itself.
  // A real fiber's ctx.fiber is the fiber; the plugin's own ctx.fiber is the fiber.
  const awaitable = (fiber) => {
    fiber.ctx = { fiber }
    const held = Object.create(fiber)
    held.then = (resolve) => resolve(fiber)
    return held
  }
  const w = webMount({}, {
    editor: (entry, edits) => {
      const own = { ...entry, fiber: awaitable(entry.fiber) }
      // another row of the package, held the same way over its own fiber
      const other = { fiber: awaitable({ name: 'another row' }), options: { ...entry.options, id: 'engramory-2' } }
      return {
        entries: () => [other, own],
        edit: async (target, change) => {
          assert.equal(target, own)
          const next = change(structuredClone(target.options.config ?? {}), structuredClone(BUNDLE_ROW))
          edits.push(next)
          target.options.config = next
        },
      }
    },
  })
  const { body: shown } = await w.call('GET')
  assert.equal(shown.editable, true)
  assert.equal(shown.readOnly, undefined)
  assert.deepEqual(await w.call('POST', saveBody(shown.revision)),
    { status: 200, body: { ok: true } })
  assert.equal(w.edits.length, 1)
  assert.equal(w.edits[0].companion, true)
})

test('settings: a row held over another fiber is not this plugin own', async () => {
  const w = webMount({}, {
    editor: (entry, edits) => {
      const stranger = { name: 'another row' }
      stranger.ctx = { fiber: stranger }
      const held = Object.create(stranger)
      return {
        entries: () => [{ ...entry, fiber: held }],
        edit: async (target, change) => { edits.push(change({}, {})) },
      }
    },
  })
  const { body: shown } = await w.call('GET')
  assert.equal(shown.editable, false)
  assert.equal(shown.readOnly, 'editor')
  assert.deepEqual(await w.call('POST', saveBody(shown.revision)),
    { status: 409, body: { ok: false, error: 'unavailable' } })
  assert.equal(w.edits.length, 0)
})

test('settings: two rows that both hold this plugin fiber, either way, are neither written', async () => {
  const w = webMount({}, {
    editor: (entry, edits) => {
      const fiber = entry.fiber
      fiber.ctx = { fiber }
      const held = Object.create(fiber)
      const twice = { ...entry, fiber: held, options: { ...entry.options, id: 'engramory-2' } }
      return {
        entries: () => [entry, twice],
        edit: async (target, change) => { edits.push(change({}, {})) },
      }
    },
  })
  const { body: shown } = await w.call('GET')
  assert.equal(shown.editable, false)
  assert.equal(shown.readOnly, 'editor')
  assert.deepEqual(await w.call('POST', saveBody(shown.revision)),
    { status: 409, body: { ok: false, error: 'unavailable' } })
  assert.equal(w.edits.length, 0)
})

// --- the memory page's route (client.js) ---

/** dsh's session controller as the memory page uses it: it can open, and keeps what it was handed. */
const openerStub = (opened) => ({
  canOpenWorkspacePath: () => true,
  openWorkspacePath: async (request, signal) => {
    assert.ok(signal instanceof AbortSignal)
    opened.push(request)
  },
})

/** A mount with dsh's web server and, when given, its workspace registry and session controller. */
function memoryMount(config = {}, { workspaces, opener } = {}) {
  const m = mount(config)
  const routes = []
  const opened = []
  let lists = 0
  if (workspaces !== undefined) {
    m.mountLate('workspaceRegistry', { list: () => { lists++; return workspaces } })
  }
  if (opener !== undefined) m.mountLate('sessionController', opener === true ? openerStub(opened) : opener)
  m.mountLate('connection', { fetch: { register: (route) => { routes.push(route); return async () => {} } } })
  const route = routes.find((r) => r.path === '/api/engramory/memory')
  const call = async (method = 'GET', body) => {
    const init = { method }
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body)
      init.headers = { 'content-type': 'application/json' }
    }
    const response = await route.fetch(new Request(`http://127.0.0.1${route.path}`, init))
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  return { ...m, call, opened, lists: () => lists }
}

/** Run the async `fn` with `$DSH_HOME` set to `home`, then put it back. */
async function withHomeAsync(home, fn) {
  const before = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn()
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
}

/** A note as the protocol writes one, of `type` (written as given, quotes and all). */
const noteOf = (type) =>
  `---\nname: x\ndescription: a secret line\ntype: ${type}\ncreated: 2026-10-30\nupdated: 2026-10-30\n---\n\nthe fact\n`

/** A global store under a fresh `$DSH_HOME`, with an index and an archive folder. */
function globalStore(tag, index = '# Memory\n- [a](a.md)\n- [b](b.md)\n') {
  const home = scratch(tag)
  const dir = join(home, '.engramory-memory')
  mkdirSync(join(dir, 'archive'), { recursive: true })
  writeFileSync(join(dir, INDEX), index, 'utf8')
  return { home, dir }
}

test('memory GET: the global store by name only — the index size, the notes by type, the archive', async () => {
  const { home, dir } = globalStore('mem-global')
  writeFileSync(join(dir, 'user_name.md'), noteOf('user'), 'utf8')
  writeFileSync(join(dir, 'fb.md'), `\uFEFF${noteOf('"feedback"')}`, 'utf8') // BOM, quoted
  writeFileSync(join(dir, 'cc.md'), '---\nname: cc\nmetadata:\n  type: project\n---\nthe fact\n', 'utf8')
  writeFileSync(join(dir, 'crlf.md'), noteOf('moment').replace(/\n/g, '\r\n'), 'utf8')
  writeFileSync(join(dir, '经历-生日.md'), noteOf('moment'), 'utf8')
  writeFileSync(join(dir, 'odd.md'), noteOf('Feedback'), 'utf8') // not a protocol type
  writeFileSync(join(dir, 'twice.md'), '---\ntype: user\ntype: project\n---\n', 'utf8')
  writeFileSync(join(dir, 'open.md'), '---\ntype: user\n', 'utf8') // never closed
  writeFileSync(join(dir, 'late.md'), `---\n${'x: y\n'.repeat(1200)}type: user\n---\n`, 'utf8') // past the head
  writeFileSync(join(dir, 'notes.txt'), 'not a note', 'utf8')
  writeFileSync(join(dir, '.hidden.md'), noteOf('user'), 'utf8')
  mkdirSync(join(dir, 'folder.md'))
  writeFileSync(join(dir, 'archive', 'moments-2026-09.md'), noteOf('moment'), 'utf8')
  const { status, body, headers } = await withHomeAsync(home, () => memoryMount().call())
  assert.equal(status, 200)
  assert.equal(headers.get('cache-control'), 'no-store')
  assert.equal(body.canOpen, false) // no session controller to open with
  assert.deepEqual(body.cap, { maxLines: 200, maxBytes: 25600 })
  assert.equal(body.more, false)
  assert.equal(body.stores.length, 1)
  const [s] = body.stores
  assert.deepEqual([s.id, s.kind, s.dir, s.titles, s.more], ['user', 'user', dir, [], false])
  assert.deepEqual(s.index, { name: INDEX, bytes: 33, lines: 3, over: false })
  assert.deepEqual(Object.fromEntries(s.notes.map((n) => [n.name, n.type])), {
    'user_name.md': 'user', 'fb.md': 'feedback', 'cc.md': 'project', 'crlf.md': 'moment',
    '经历-生日.md': 'moment', 'odd.md': 'other', 'twice.md': 'other', 'open.md': 'other', 'late.md': 'other',
  })
  assert.deepEqual(s.archive, ['moments-2026-09.md'])
  // names and types only: no note's text reaches the page
  assert.doesNotMatch(JSON.stringify(body), /secret line|the fact/)
})

/** Whether the disk under `dir` opens a name in any case: probed, as a volume may differ from its OS's default. */
function caselessAt(dir) {
  const probe = join(dir, 'case-probe.tmp')
  writeFileSync(probe, '')
  try {
    return fs.existsSync(join(dir, 'CASE-PROBE.TMP'))
  } finally {
    rmSync(probe)
  }
}

test('memory GET: the check-up names the index\'s pointers to nothing and the notes it does not name', async () => {
  const { home, dir } = globalStore('mem-health', [
    '# Memory — a secret line',
    '- [a](a.md) · [a again](<a.md> "title") · [section](a.md#why)',
    '- [gone](gone.md) — not there',
    '- [old](archive/old.md) · [lost](archive/lost.md)',
    '- [web](https://example.com/x.md) · [up](../x.md) · [rooted](/x.md) · [drive](C:/x.md)',
    '- [sub](sub/x.md) · [self](MEMORY.md) · [hidden](.hidden.md) · [folder](folder.md)',
    '- [here](./here.md) · [B](B.md)',
    '',
  ].join('\n'))
  for (const n of ['a.md', 'b.md', 'here.md', 'c.md']) writeFileSync(join(dir, n), noteOf('user'), 'utf8')
  writeFileSync(join(dir, 'odd.md'), 'no frontmatter', 'utf8')
  writeFileSync(join(dir, 'archive', 'old.md'), noteOf('moment'), 'utf8')
  mkdirSync(join(dir, 'folder.md'))
  const { body } = await withHomeAsync(home, () => memoryMount().call())
  const { health } = body.stores[0]
  // a case-insensitive disk finds B.md as b.md, as it would for the AI; a case-sensitive one does not
  const caseless = caselessAt(dir)
  // in the index's order, a folder where a note should be among them; a URL, a path out of
  // the store or into a subfolder, the index itself, a name no note can have: not judged
  assert.deepEqual([health.checked, health.broken, health.brokenMore],
    [true, ['gone.md', 'archive/lost.md', 'folder.md', ...(caseless ? [] : ['B.md'])], false])
  assert.deepEqual([...health.unindexed].sort(), ['c.md', 'odd.md', ...(caseless ? [] : ['b.md'])].sort())
  // the index's text is read for its pointers, and stays on the host
  assert.doesNotMatch(JSON.stringify(body), /secret line|not there/)
})

test('memory GET: with no index every note is out of it; past the cap, or listed in part, no check-up', async () => {
  const { home, dir } = globalStore('mem-health-none')
  writeFileSync(join(dir, 'a.md'), noteOf('user'), 'utf8')
  rmSync(join(dir, INDEX))
  let s = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  assert.deepEqual(s.health, { checked: true, broken: [], brokenMore: false, unindexed: ['a.md'] })
  writeFileSync(join(dir, INDEX), `${big(250)}\n- [gone](gone.md)\n`, 'utf8')
  s = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  assert.deepEqual(s.health, { checked: false, reason: 'over' })
  // under a cap past recall's read the index is not read whole: too large to check
  writeFileSync(join(dir, INDEX), 'x'.repeat(17 * 1024 * 1024), 'utf8')
  s = (await withHomeAsync(home, () => memoryMount({ maxBytes: 20000000 }).call())).body.stores[0]
  assert.deepEqual(s.health, { checked: false, reason: 'large' })
  // an index that is there but cannot be read is not taken for none
  rmSync(join(dir, INDEX))
  mkdirSync(join(dir, INDEX))
  s = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  assert.deepEqual([s.index, s.health], [null, { checked: false, reason: 'unreadable' }])
  rmSync(join(dir, INDEX), { recursive: true })
  writeFileSync(join(dir, INDEX), '- [a](a.md)\n', 'utf8')
  for (let i = 0; i <= 2000; i++) writeFileSync(join(dir, `f${i}.txt`), '')
  s = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  assert.deepEqual(s.health, { checked: false, reason: 'partial' })
})

test('memory GET: a store whose folder cannot be read to its end gets no check-up', async () => {
  const { home, dir } = globalStore('mem-health-eio')
  writeFileSync(join(dir, 'a.md'), noteOf('user'), 'utf8')
  const { syncBuiltinESMExports } = await import('node:module')
  const promises = (await import('node:fs/promises')).default
  const native = promises.opendir
  promises.opendir = async (p, ...rest) => {
    if (String(p) === dir) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
    return native(p, ...rest)
  }
  syncBuiltinESMExports()
  try {
    const s = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
    assert.deepEqual(s.health, { checked: false, reason: 'unreadable' })
  } finally {
    promises.opendir = native
    syncBuiltinESMExports()
  }
})

test('memory GET: the check-up names at most 200 pointers to nothing, and says there are more', async () => {
  // five a line, so the index stays within the cap and is checked
  const index = Array.from({ length: 41 }, (_, l) =>
    Array.from({ length: 5 }, (_, k) => `[n${l * 5 + k}](n${l * 5 + k}.md)`).join(' ')).join('\n')
  const { home } = globalStore('mem-health-many', `${index}\n`)
  const { health } = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  assert.equal(health.broken.length, 200)
  assert.deepEqual([health.broken[0], health.broken.at(-1), health.brokenMore], ['n0.md', 'n199.md', true])
})

test('memory GET: the check-up reads pointers as the doctor does, in time linear in the index', async () => {
  const long = `${'n'.repeat(600)}.md`
  const { home, dir } = globalStore('mem-health-shape', [
    // the doctor's pointer ends at a delimiter or the index's end: not at a control
    // character, and a run past a name's length is no pointer
    `- [ctl](ctl.md\u0001) · [long](${long}) · [ok](a.md)`,
    `- ${'](x'.repeat(4000)}`, // a crafted run of link openings, within the cap
    '- [last](gone.md',
  ].join('\n'))
  writeFileSync(join(dir, 'a.md'), noteOf('user'), 'utf8')
  const started = performance.now()
  const { health } = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  assert.ok(performance.now() - started < 1000)
  assert.deepEqual([health.checked, health.broken, health.unindexed], [true, ['gone.md'], []])
})

test('memory GET: past 1000 names only the disk could judge, the check-up does not guess', async () => {
  // names no note has: each is looked up, past the 200 listed too
  const { home } = globalStore('mem-health-lookups', `${Array.from({ length: 101 }, (_, l) =>
    Array.from({ length: 10 }, (_, k) => `[d](d${l * 10 + k}.md)`).join(' ')).join('\n')}\n`)
  const { health } = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  assert.deepEqual(health, { checked: false, reason: 'large' })
})

test('memory GET: past 200 pointers to nothing, the rest are still judged', async () => {
  const missing = Array.from({ length: 20 }, (_, l) =>
    Array.from({ length: 10 }, (_, k) => `[g](g${l * 10 + k}.md)`).join(' ')).join('\n')
  const { home, dir } = globalStore('mem-health-after', `${missing}\n- [b](B.md)\n`)
  writeFileSync(join(dir, 'b.md'), noteOf('user'), 'utf8')
  const { health } = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  const caseless = caselessAt(dir)
  // a case-insensitive disk opens B.md as b.md: 200 pointers to nothing, b.md in the index
  assert.deepEqual([health.broken.length, health.brokenMore, health.unindexed],
    caseless ? [200, false, []] : [200, true, ['b.md']])
})

test('memory GET: the disk decides the archive\'s and the index\'s case; a file named archive holds nothing', async () => {
  const { home, dir } = globalStore('mem-health-case', '- [old](ARCHIVE/old.md) · [self](memory.md)\n')
  writeFileSync(join(dir, 'archive', 'old.md'), noteOf('moment'), 'utf8')
  const caseless = caselessAt(dir)
  let { health } = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  assert.deepEqual(health.broken, caseless ? [] : ['ARCHIVE/old.md', 'memory.md'])
  rmSync(join(dir, 'archive'), { recursive: true })
  writeFileSync(join(dir, 'archive'), 'not a folder', 'utf8')
  writeFileSync(join(dir, INDEX), '- [old](archive/old.md)\n', 'utf8')
  ;({ health } = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0])
  assert.deepEqual(health.broken, ['archive/old.md'])
})

test('memory GET: the check-up never looks through a link — a note\'s, or the archive\'s', async (t) => {
  const { home, dir } = globalStore('mem-health-links', '- [x](x.md) · [y](archive/y.md) · [z](Archive/z.md)\n')
  const outside = scratch('mem-health-out')
  writeFileSync(join(outside, 'x.md'), noteOf('user'), 'utf8')
  rmSync(join(dir, 'archive'), { recursive: true })
  symlinkSync(outside, join(dir, 'archive'), process.platform === 'win32' ? 'junction' : 'dir')
  const linkedNote = fileLink(join(outside, 'x.md'), join(dir, 'x.md'))
  // every lookup is of the entry itself: nothing reaches the folder the links lead to
  const { syncBuiltinESMExports } = await import('node:module')
  const promises = (await import('node:fs/promises')).default
  const seen = []
  const natives = { stat: promises.stat, lstat: promises.lstat }
  for (const name of ['stat', 'lstat']) {
    promises[name] = async (p, ...rest) => { seen.push([name, String(p)]); return natives[name](p, ...rest) }
  }
  syncBuiltinESMExports()
  let health
  try {
    ;({ health } = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0])
  } finally {
    Object.assign(promises, natives)
    syncBuiltinESMExports()
  }
  // a link is not judged; with no link made, x.md is simply not there; and Archive is the
  // linked archive only on a disk that takes it for archive — elsewhere it is not there
  assert.deepEqual([health.checked, health.broken], [true,
    [...(linkedNote === null ? ['x.md'] : []), ...(caselessAt(dir) ? [] : ['Archive/z.md'])]])
  // (the store's own folder is stat'ed when it is found, before any check-up)
  const real = realpathSync.native(dir)
  assert.deepEqual(seen.filter(([name, p]) => (name === 'stat' && p !== dir && p !== real) || p.startsWith(outside)), [])
  assert.ok(!seen.some(([, p]) => /[\\/][yz]\.md$/.test(p)), JSON.stringify(seen))
  if (linkedNote === null) t.diagnostic('no symlink privilege here: the linked note was not made')
})

test('memory GET: on a case-sensitive disk, notes one case apart are two notes, and memory.md is one', async (t) => {
  const { home, dir } = globalStore('mem-health-twins', '- [a](a.md) · [A](A.md)\n')
  if (caselessAt(dir)) return t.skip('this disk takes a.md and A.md for one file')
  for (const n of ['a.md', 'A.md', 'memory.md']) writeFileSync(join(dir, n), noteOf('user'), 'utf8')
  const s = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  assert.deepEqual(s.notes.map((n) => n.name).sort(), ['A.md', 'a.md', 'memory.md'])
  assert.deepEqual([s.health.broken, s.health.unindexed], [[], ['memory.md']])
})

test('memory GET: on a disk with no file ids, the index is told by its name as before', async (t) => {
  // an index and a note whose names are one apart in Unicode form only: two files on NTFS and ext4
  const nfc = 'é.md'
  const nfd = 'é.md'
  const { home, dir } = globalStore('mem-health-noid', '- [n](n.md)\n')
  writeFileSync(join(dir, nfc), '- [n](n.md)\n', 'utf8')
  writeFileSync(join(dir, nfd), noteOf('user'), 'utf8')
  if (fs.readdirSync(dir).filter((n) => n.endsWith('.md')).length < 3) return t.skip('this disk takes the two forms for one name')
  const listed = async () => (await withHomeAsync(home, () => memoryMount({ indexName: nfc }).call())).body.stores[0].notes
    .map((n) => n.name).filter((n) => n !== INDEX)
  assert.deepEqual(await listed(), [nfd])
  // every file id 0, as some network and FAT volumes give: the note is still a note
  const { syncBuiltinESMExports } = await import('node:module')
  const promises = (await import('node:fs/promises')).default
  const native = promises.lstat
  promises.lstat = async (p, options) => {
    const info = await native(p, options)
    return options?.bigint ? Object.assign(Object.create(Object.getPrototypeOf(info)), info, { dev: 1n, ino: 0n }) : info
  }
  syncBuiltinESMExports()
  try {
    assert.deepEqual(await listed(), [nfd])
  } finally {
    promises.lstat = native
    syncBuiltinESMExports()
  }
})

test('memory GET: on a case-insensitive disk, the index under another spelling is still the index', async (t) => {
  const { home, dir } = globalStore('mem-health-spelling', '- [a](a.md)\n')
  if (!caselessAt(dir)) return t.skip('this disk keeps MEMORY.md and memory.md apart')
  renameSync(join(dir, INDEX), join(dir, 'memory.md'))
  writeFileSync(join(dir, 'a.md'), noteOf('user'), 'utf8')
  const s = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  assert.deepEqual([s.notes.map((n) => n.name), s.health.unindexed], [['a.md'], []])
})

test('memory GET: a note that cannot be read is no note without a type: no check-up', async () => {
  const { home, dir } = globalStore('mem-health-unread', '- [a](a.md)\n')
  writeFileSync(join(dir, 'a.md'), noteOf('user'), 'utf8')
  const { syncBuiltinESMExports } = await import('node:module')
  const promises = (await import('node:fs/promises')).default
  const native = promises.open
  promises.open = async (p, ...rest) => {
    if (String(p) === join(dir, 'a.md')) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' })
    return native(p, ...rest)
  }
  syncBuiltinESMExports()
  try {
    const s = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
    assert.deepEqual([s.notes, s.health], [[{ name: 'a.md', type: 'other', unread: true }], { checked: false, reason: 'unreadable' }])
  } finally {
    promises.open = native
    syncBuiltinESMExports()
  }
})

test('memory GET: the whole listing names at most 1000 pointers to nothing, lookups or not', async () => {
  // archived names under no archive: each is nothing without a lookup
  const index = `${Array.from({ length: 20 }, (_, l) =>
    Array.from({ length: 10 }, (_, k) => `[x](archive/x${l * 10 + k}.md)`).join(' ')).join('\n')}\n`
  const home = scratch('mem-health-total')
  const workspaces = []
  for (let w = 0; w < 6; w++) {
    const repo = realpathSync.native(scratch(`mem-health-total-${w}`))
    mkdirSync(join(repo, '.git'))
    store(repo, index)
    workspaces.push({ id: `w${w}`, path: repo, title: `w${w}` })
  }
  const { body } = await withHomeAsync(home, () => memoryMount({}, { workspaces }).call())
  const health = body.stores.map((s) => [s.health.broken.length, s.health.brokenMore])
  assert.deepEqual(health, [[200, false], [200, false], [200, false], [200, false], [200, false], [0, true]])
})

test('memory GET: a note that is a link is not listed', async (t) => {
  const { home, dir } = globalStore('mem-link')
  const outside = join(scratch('mem-outside'), 'id.md')
  writeFileSync(outside, noteOf('user'), 'utf8')
  if (fileLink(outside, join(dir, 'link.md')) === null) return t.skip('no symlink privilege here')
  const { body } = await withHomeAsync(home, () => memoryMount().call())
  assert.deepEqual(body.stores[0].notes, [])
})

test('memory GET: each workspace\'s project store, found as recall finds one, listed once', async () => {
  const home = scratch('mem-nohome') // no global store
  const repo = realpathSync.native(scratch('mem-repo'))
  mkdirSync(join(repo, '.git'))
  mkdirSync(join(repo, 'src'))
  store(repo, '- [a](a.md)\n')
  writeFileSync(join(repo, '.engramory-memory', 'a.md'), noteOf('project'), 'utf8')
  const plain = realpathSync.native(scratch('mem-plain'))
  const workspaces = [
    { id: 'w1', path: repo, title: 'repo' },
    { id: 'w2', path: join(repo, 'src'), title: 'src' }, // the same store, from below
    { id: 'w3', path: plain, title: 'plain' }, // no store
    { id: 'w4', path: '\\\\server\\share\\repo', title: 'unc' }, // a network path: never looked into
    { id: 'w5', path: 'relative/path', title: 'bad' },
    { path: repo, title: 'no id' },
  ]
  const m = memoryMount({}, { workspaces })
  const { body } = await withHomeAsync(home, () => m.call())
  assert.equal(body.stores.length, 1)
  const [s] = body.stores
  assert.deepEqual([s.id, s.kind, s.titles, s.dir], ['ws:w1', 'project', ['repo', 'src'], join(repo, '.engramory-memory')])
  assert.deepEqual(s.notes, [{ name: 'a.md', type: 'project', bytes: Buffer.byteLength(noteOf('project')) }])
  // no registry: the global store alone, as before
  assert.deepEqual((await withHomeAsync(home, () => memoryMount().call())).body.stores, [])
})

test('memory GET: a workspace whose path now leads elsewhere, or whose index is a link, lists nothing', async (t) => {
  const home = scratch('mem-nohome2')
  const elsewhere = scratch('mem-elsewhere')
  mkdirSync(join(elsewhere, '.git'))
  store(elsewhere, '- a secret line\n')
  // dsh recorded a plain directory here; it has since become a link to another tree
  const moved = join(scratch('mem-moved'), 'ws')
  symlinkSync(elsewhere, moved, process.platform === 'win32' ? 'junction' : 'dir')
  const m = memoryMount({}, { workspaces: [{ id: 'w', path: moved, title: 'ws' }] })
  assert.deepEqual((await withHomeAsync(home, () => m.call())).body.stores, [])

  const repo = realpathSync.native(scratch('mem-linkrepo'))
  mkdirSync(join(repo, '.git'))
  mkdirSync(join(repo, '.engramory-memory'))
  const secret = join(scratch('mem-secret'), 'secret.md')
  writeFileSync(secret, '- a secret line\n', 'utf8')
  if (fileLink(secret, join(repo, '.engramory-memory', INDEX)) === null) return t.skip('no symlink privilege here')
  const linked = memoryMount({}, { workspaces: [{ id: 'w', path: repo, title: 'r' }] })
  assert.deepEqual((await withHomeAsync(home, () => linked.call())).body.stores, [])
})

test('memory GET: each note comes with its size, so the page can point out one past what a fact needs', async () => {
  const { home, dir } = globalStore('mem-sizes')
  const big = `${noteOf('project')}${'a timeline, round by round\n'.repeat(600)}`
  writeFileSync(join(dir, 'a.md'), noteOf('user'), 'utf8')
  writeFileSync(join(dir, 'b.md'), big, 'utf8')
  const [s] = (await withHomeAsync(home, () => memoryMount().call())).body.stores
  assert.deepEqual(s.notes.map((n) => [n.name, n.bytes]).sort(),
    [['a.md', Buffer.byteLength(noteOf('user'))], ['b.md', Buffer.byteLength(big)]])
  assert.ok(Buffer.byteLength(big) > 12 * 1024)
})

test('memory GET: a store that cannot be read is left out and counted; one not there yet is neither', async () => {
  const { home, dir } = globalStore('mem-unreadable')
  let { body } = await withHomeAsync(home, () => memoryMount().call())
  assert.deepEqual([body.stores.length, body.unreadable], [1, undefined])
  // the page reads node:fs/promises through its ES namespace: patch the module, then sync it
  const { syncBuiltinESMExports } = await import('node:module')
  const promises = (await import('node:fs/promises')).default
  // refused past resolving it (Node's walk would get round a refused realpath, as recall does):
  // the folder as resolved, which a runner's temp path is not (an 8.3 name, macOS's /private)
  const real = realpathSync.native(dir).toLowerCase()
  const native = promises.stat
  promises.stat = async (p, ...rest) => {
    if (String(p).toLowerCase() === real) throw Object.assign(new Error('EACCES: refused'), { code: 'EACCES' })
    return native(p, ...rest)
  }
  syncBuiltinESMExports()
  try {
    ;({ body } = await withHomeAsync(home, () => memoryMount().call()))
    assert.deepEqual([body.stores, body.unreadable], [[], 1])
  } finally {
    promises.stat = native
    syncBuiltinESMExports()
  }
  // the global store before its first note: nothing there, and nothing it could not read
  ;({ body } = await withHomeAsync(scratch('mem-nostore'), () => memoryMount().call()))
  assert.deepEqual([body.stores, body.unreadable], [[], undefined])
})

test('memory GET: a project whose index could not be looked at is counted unreadable, not taken for no store', async () => {
  const home = scratch('mem-proj-home')
  const repo = realpathSync.native(scratch('mem-proj-locked'))
  mkdirSync(join(repo, '.git'))
  store(repo, '- [a](a.md)\n')
  mkdirSync(join(repo, 'src'))
  const plain = realpathSync.native(scratch('mem-proj-plain')) // no store: none, and nothing unreadable
  const index = join(repo, '.engramory-memory', INDEX).toLowerCase()
  const below = join(repo, 'src', '.engramory-memory', INDEX).toLowerCase()
  const both = [{ id: 'w', path: repo, title: 'r' }, { id: 's', path: join(repo, 'src'), title: 's' }]
  const listed = async (workspaces, refused, call = 'lstat') => {
    const { syncBuiltinESMExports } = await import('node:module')
    const promises = (await import('node:fs/promises')).default
    const native = promises[call]
    promises[call] = async (p, ...rest) => {
      if (refused.includes(String(p).toLowerCase())) throw Object.assign(new Error('EACCES: refused'), { code: 'EACCES' })
      return native(p, ...rest)
    }
    syncBuiltinESMExports()
    try {
      const { body } = await withHomeAsync(home, () => memoryMount({}, { workspaces }).call())
      return [body.stores.map((s) => s.id), body.unreadable]
    } finally {
      promises[call] = native
      syncBuiltinESMExports()
    }
  }
  assert.deepEqual(await listed([...both, { id: 'p', path: plain, title: 'p' }], []), [['ws:w'], undefined])
  // the project's index refused: counted, not taken for no store — once, though two workspaces reach it
  assert.deepEqual(await listed([...both, { id: 'p', path: plain, title: 'p' }], [index]), [[], 1])
  // the store's folder found but refused: counted once too, by its folder
  assert.deepEqual(await listed(both, [join(repo, '.engramory-memory').toLowerCase()], 'stat'), [[], 1])
  // a level below refused: passed over, as recall passes over it, and the store above still found
  assert.deepEqual(await listed([{ id: 's', path: join(repo, 'src'), title: 's' }], [below]), [['ws:s'], undefined])
})

test('memory GET: where the OS will not resolve a project\'s index, Node\'s walk does', async (t) => {
  if (process.platform !== 'win32') return t.skip('the fallback is Windows-only; POSIX resolves natively as before')
  const home = scratch('mem-native-home')
  const repo = realpathSync.native(scratch('mem-native-repo'))
  mkdirSync(join(repo, '.git'))
  store(repo, '- [a](a.md)\n')
  const index = join(repo, '.engramory-memory', INDEX).toLowerCase()
  // the page reads node:fs/promises through its ES namespace: patch the module, then sync it
  const { syncBuiltinESMExports } = await import('node:module')
  const promises = (await import('node:fs/promises')).default
  const native = promises.realpath
  promises.realpath = async (p, ...rest) => {
    if (String(p).toLowerCase() === index) throw Object.assign(new Error('EPERM: refused'), { code: 'EPERM' })
    return native(p, ...rest)
  }
  syncBuiltinESMExports()
  try {
    const m = memoryMount({}, { workspaces: [{ id: 'w', path: repo, title: 'r' }] })
    assert.deepEqual((await withHomeAsync(home, () => m.call())).body.stores.map((s) => s.id), ['ws:w'])
  } finally {
    promises.realpath = native
    syncBuiltinESMExports()
  }
})

test('memory GET: a pinned index lists its own directory alone; a relative pin cannot be listed', async () => {
  const dir = realpathSync.native(scratch('mem-pinned'))
  writeFileSync(join(dir, 'INDEX.md'), '- one\n', 'utf8')
  writeFileSync(join(dir, 'a.md'), noteOf('user'), 'utf8')
  const { home } = globalStore('mem-pinhome')
  const m = memoryMount({ indexPath: join(dir, 'INDEX.md') }, { workspaces: [] })
  const { body } = await withHomeAsync(home, () => m.call())
  assert.deepEqual(body.stores.map((s) => [s.id, s.kind, s.index.name, s.notes.map((n) => n.name)]),
    [['pinned', 'pinned', 'INDEX.md', ['a.md']]])
  const relative = memoryMount({ indexPath: 'notes/MEMORY.md' }, { workspaces: [] })
  const shown = (await withHomeAsync(home, () => relative.call())).body
  assert.deepEqual([shown.stores, shown.pinned], [[], 'relative'])
})

test('memory GET: an index over the cap says so; past what recall reads, its lines are not counted', async () => {
  const { home, dir } = globalStore('mem-over', `${big(250)}\n`)
  let s = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  assert.deepEqual([s.index.lines, s.index.over], [250, true])
  writeFileSync(join(dir, INDEX), 'x'.repeat(30000), 'utf8')
  s = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  assert.deepEqual(s.index, { name: INDEX, bytes: 30000, over: true })
  // a store with no index yet is still a store
  rmSync(join(dir, INDEX))
  s = (await withHomeAsync(home, () => memoryMount().call())).body.stores[0]
  assert.equal(s.index, null)
})

test('memory GET: a directory past the entries looked at says there is more', async () => {
  const { home, dir } = globalStore('mem-many')
  for (let i = 0; i <= 2000; i++) writeFileSync(join(dir, `f${i}.txt`), '')
  const { body } = await withHomeAsync(home, () => memoryMount().call())
  assert.equal(body.stores[0].more, true)
})

test('memory GET: pages asking at once share one listing', async () => {
  const home = scratch('mem-once')
  const m = memoryMount({}, { workspaces: [] })
  await withHomeAsync(home, () => Promise.all([m.call(), m.call()]))
  assert.equal(m.lists(), 1)
  await withHomeAsync(home, () => m.call())
  assert.equal(m.lists(), 2) // a later page starts its own
})

test('memory POST opens a note, the index, an archived note by its real path; shows the folder', async () => {
  const { home, dir } = globalStore('mem-open')
  writeFileSync(join(dir, 'a.md'), noteOf('user'), 'utf8')
  writeFileSync(join(dir, 'archive', 'old.md'), noteOf('moment'), 'utf8')
  const real = realpathSync.native(dir)
  const m = memoryMount({}, { opener: true })
  await withHomeAsync(home, async () => {
    assert.equal((await m.call()).body.canOpen, true)
    for (const [body, asked] of [
      [{ store: 'user', file: 'a.md' }, { path: join(real, 'a.md') }],
      [{ store: 'user', file: INDEX }, { path: join(real, INDEX) }],
      [{ store: 'user', file: 'old.md', archive: true }, { path: join(real, 'archive', 'old.md') }],
      // the folder is shown, never opened: the file manager, with the index selected
      [{ store: 'user' }, { path: join(real, INDEX), action: 'reveal' }],
    ]) {
      const { status, body: reply } = await m.call('POST', body)
      assert.deepEqual([status, reply], [200, asked.action === 'reveal' ? { ok: true, revealed: true } : { ok: true }],
        JSON.stringify(body))
      assert.deepEqual(m.opened.at(-1), asked)
    }
    // a store with no index has nothing to show its folder by (Linux would show the one above)
    rmSync(join(dir, INDEX))
    assert.equal((await m.call('POST', { store: 'user' })).status, 404)
    assert.equal(m.opened.length, 4)
  })
})

test('memory GET: a store linked to its project\'s root is listed, as recall reads its index', async () => {
  const home = scratch('mem-rootlink')
  const repo = realpathSync.native(scratch('mem-rootrepo'))
  mkdirSync(join(repo, '.git'))
  writeFileSync(join(repo, INDEX), '- [a](a.md)\n', 'utf8')
  writeFileSync(join(repo, 'a.md'), noteOf('user'), 'utf8')
  symlinkSync(repo, join(repo, '.engramory-memory'), process.platform === 'win32' ? 'junction' : 'dir')
  const m = memoryMount({}, { workspaces: [{ id: 'w', path: repo, title: 'repo' }], opener: true })
  const { body } = await withHomeAsync(home, () => m.call())
  assert.deepEqual(body.stores.map((s) => [s.id, s.notes.map((n) => n.name)]), [['ws:w', ['a.md']]])
  assert.equal((await withHomeAsync(home, () => m.call('POST', { store: 'ws:w', file: 'a.md' }))).status, 200)
  assert.deepEqual(m.opened, [{ path: join(repo, 'a.md') }])
})

test('memory POST opens nothing that is not a listed note, and says why', async (t) => {
  const { home, dir } = globalStore('mem-refuse')
  writeFileSync(join(dir, 'a.md'), noteOf('user'), 'utf8')
  writeFileSync(join(dir, 'a.txt'), 'x', 'utf8')
  writeFileSync(join(dir, '.hidden.md'), noteOf('user'), 'utf8')
  mkdirSync(join(dir, 'folder.md'))
  const outside = join(scratch('mem-out'), 'out.md')
  writeFileSync(outside, noteOf('user'), 'utf8')
  const link = fileLink(outside, join(dir, 'link.md'))
  const m = memoryMount({}, { opener: true })
  await withHomeAsync(home, async () => {
    for (const body of [
      { store: 'user', file: '../MEMORY.md' }, { store: 'user', file: 'archive/../a.md' },
      { store: 'user', file: outside }, { store: 'user', file: 'a.txt' },
      { store: 'user', file: '.hidden.md' }, { store: 'user', file: 'a.md:stream' },
      { store: 'user', file: 'missing.md' }, { store: 'user', file: 'folder.md' },
      { store: 'user', file: 'a.md', archive: true }, { store: 'ws:nope', file: 'a.md' },
      { store: 'pinned' }, ...(link === null ? [] : [{ store: 'user', file: 'link.md' }]),
    ]) {
      assert.deepEqual(await m.call('POST', body).then((r) => [r.status, r.body]),
        [404, { ok: false, error: 'missing' }], JSON.stringify(body))
    }
    for (const [body, field] of [
      ['not json', 'body'], [{}, 'store'], [{ store: 'user', file: 3 }, 'file'],
      [{ store: 'user', archive: 'yes' }, 'archive'],
    ]) {
      assert.deepEqual(await m.call('POST', body).then((r) => [r.status, r.body]),
        [400, { ok: false, error: 'invalid', field }], JSON.stringify(body))
    }
  })
  assert.deepEqual(m.opened, [])
  if (link === null) t.diagnostic('no symlink privilege here: the link case was not run')
})

test('memory POST without a desktop to open on, or when it fails, says so', async () => {
  const { home, dir } = globalStore('mem-desk')
  writeFileSync(join(dir, 'a.md'), noteOf('user'), 'utf8')
  const open = { store: 'user', file: 'a.md' }
  await withHomeAsync(home, async () => {
    for (const opener of [undefined, { canOpenWorkspacePath: () => false, openWorkspacePath: async () => {} },
      { canOpenWorkspacePath: () => { throw new Error('x') }, openWorkspacePath: async () => {} }]) {
      const m = memoryMount({}, { opener })
      assert.equal((await m.call()).body.canOpen, false)
      assert.deepEqual(await m.call('POST', open).then((r) => [r.status, r.body]),
        [409, { ok: false, error: 'unavailable' }])
    }
    const failing = memoryMount({}, {
      opener: { canOpenWorkspacePath: () => true, openWorkspacePath: async () => { throw new Error('no handler for .md') } },
    })
    assert.deepEqual(await failing.call('POST', open).then((r) => [r.status, r.body]),
      [502, { ok: false, error: 'failed', message: 'no handler for .md' }])
  })
})

test('memory GET: a frontmatter is read up to the head\'s last byte, with any line ending', async () => {
  const { home, dir } = globalStore('mem-head')
  // exactly the head, its closing fence the file's last three bytes
  const open = '---\ntype: user\n'
  const filler = `# ${'x'.repeat(4096 - open.length - '---'.length - 3)}\n`
  writeFileSync(join(dir, 'edge.md'), `${open}${filler}---`, 'utf8')
  assert.equal(Buffer.byteLength(`${open}${filler}---`), 4096)
  // the same fence, its line ending right after the head, the body following
  writeFileSync(join(dir, 'edge-body.md'), `${open}${filler}---\n\nthe fact\n`, 'utf8')
  // a fence the head cuts in two is no fence
  writeFileSync(join(dir, 'edge-cut.md'), `${open}${filler}--- not a fence\n`, 'utf8')
  writeFileSync(join(dir, 'cr-end.md'), '---\ntype: feedback\n---\r', 'utf8')
  writeFileSync(join(dir, 'cr-only.md'), '---\rtype: project\r---\rthe fact\r', 'utf8')
  const { body } = await withHomeAsync(home, () => memoryMount().call())
  assert.deepEqual(Object.fromEntries(body.stores[0].notes.map((n) => [n.name, n.type])), {
    'edge.md': 'user', 'edge-body.md': 'user', 'edge-cut.md': 'other', 'cr-end.md': 'feedback',
    'cr-only.md': 'project',
  })
})

test('memory GET: an index past recall\'s read under a larger cap is not called over it', async () => {
  // a cap above 16 MiB: recall reads 16 MiB of it, and the index is still under the cap
  const { home, dir } = globalStore('mem-huge')
  writeFileSync(join(dir, INDEX), 'x'.repeat(17 * 1024 * 1024), 'utf8')
  const s = (await withHomeAsync(home, () => memoryMount({ maxBytes: 20000000 }).call())).body.stores[0]
  assert.deepEqual(s.index, { name: INDEX, bytes: 17 * 1024 * 1024, over: false })
})

test('memory GET: past the workspaces looked into, the page says there is more', async () => {
  const home = scratch('mem-wsmany')
  const nowhere = join(scratch('mem-nowhere'), 'gone')
  const workspaces = Array.from({ length: 205 }, (_, i) => ({ id: `w${i}`, path: join(nowhere, `w${i}`), title: `w${i}` }))
  const { body } = await withHomeAsync(home, () => memoryMount({}, { workspaces }).call())
  assert.deepEqual([body.stores, body.more], [[], true])
  const few = await withHomeAsync(home, () => memoryMount({}, { workspaces: workspaces.slice(0, 200) }).call())
  assert.equal(few.body.more, false)
  // past the limit nothing more is looked at, not even whether an entry is usable
  const tail = [...workspaces.slice(0, 200), ...Array.from({ length: 50 }, () => ({ title: 'no id' }))]
  assert.equal((await withHomeAsync(home, () => memoryMount({}, { workspaces: tail }).call())).body.more, true)
})

test('memory POST: a click while a lookup runs is told to wait; the next one opens', async () => {
  const { home, dir } = globalStore('mem-busy')
  writeFileSync(join(dir, 'a.md'), noteOf('user'), 'utf8')
  writeFileSync(join(dir, 'b.md'), noteOf('user'), 'utf8')
  const m = memoryMount({}, { opener: true })
  await withHomeAsync(home, async () => {
    const replies = await Promise.all(['a.md', 'b.md', 'b.md'].map((file) => m.call('POST', { store: 'user', file })))
    assert.deepEqual(replies.map((r) => r.status).sort(), [200, 409, 409])
    assert.deepEqual(replies.filter((r) => r.status === 409).map((r) => r.body),
      [{ ok: false, error: 'busy' }, { ok: false, error: 'busy' }])
    assert.equal(m.opened.length, 1)
    assert.equal((await m.call('POST', { store: 'user', file: 'b.md' })).status, 200)
    assert.equal(m.opened.length, 2)
  })
})

test('memory POST: a pinned index of any name is found by that name, only in the store itself', async () => {
  const dir = realpathSync.native(scratch('mem-pinname'))
  writeFileSync(join(dir, 'INDEX'), '- one\n', 'utf8')
  mkdirSync(join(dir, 'archive'))
  writeFileSync(join(dir, 'archive', 'INDEX'), '- old\n', 'utf8')
  const m = memoryMount({ indexPath: join(dir, 'INDEX') }, { opener: true })
  assert.deepEqual((await m.call('POST', { store: 'pinned', file: 'INDEX' })).body, { ok: true, revealed: true })
  // not a `.md`: shown in its folder, not handed to whatever app its name calls up
  assert.deepEqual(m.opened, [{ path: join(dir, 'INDEX'), action: 'reveal' }])
  assert.equal((await m.call('POST', { store: 'pinned', file: 'INDEX', archive: true })).status, 404)
  if (process.platform === 'win32') {
    // a case-insensitive disk finds it under any case, and the opener gets its real name
    assert.equal((await m.call('POST', { store: 'pinned', file: 'index' })).status, 200)
    assert.deepEqual(m.opened.at(-1), { path: join(dir, 'INDEX'), action: 'reveal' })
  }
})

test('memory POST: an index named like a program is shown in its folder, never run', async () => {
  // a project's checkout may hold a file under any name the user gave the index
  const { home, dir } = globalStore('mem-cmdname')
  const real = realpathSync.native(dir)
  for (const name of ['MEMORY.cmd', 'MEMORY.lnk', 'MEMORY.url']) {
    writeFileSync(join(dir, name), '- one\n', 'utf8')
    const m = memoryMount({ indexName: name }, { opener: true })
    await withHomeAsync(home, async () => {
      assert.deepEqual((await m.call('POST', { store: 'user', file: name })).body, { ok: true, revealed: true })
    })
    assert.deepEqual(m.opened, [{ path: join(real, name), action: 'reveal' }], name)
  }
  // a note, and an index that is one, still open in the desktop's own app
  writeFileSync(join(dir, 'a.md'), noteOf('user'), 'utf8')
  const m = memoryMount({ indexName: 'Memory.MD' }, { opener: true })
  writeFileSync(join(dir, 'Memory.MD'), '- one\n', 'utf8')
  await withHomeAsync(home, async () => {
    for (const file of ['a.md', 'Memory.MD']) assert.equal((await m.call('POST', { store: 'user', file })).status, 200)
  })
  assert.deepEqual(m.opened.map((o) => o.action), [undefined, undefined])
})

// --- where the global store is, and moving it (the store route) ---

const POINTER = '.engramory-memory.json'
const pointerIn = (home) => JSON.parse(fs.readFileSync(join(home, POINTER), 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value), 'utf8')
const digest = (text) => createHash('sha256').update(text).digest('hex')
const linkKind = process.platform === 'win32' ? 'junction' : 'dir'

/** A home whose default store holds `files` (relative path -> text). */
function homeStore(tag, files = {
  [INDEX]: '- [a](a.md) — who the user is\n',
  'a.md': noteOf('user'),
  'archive/old.md': noteOf('moment'),
}) {
  const home = scratch(tag)
  const dir = join(home, '.engramory-memory')
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), text, 'utf8')
  }
  return { home, dir }
}

/** A folder's files, relative path -> text. */
function treeOf(dir, rel = '') {
  const out = {}
  for (const entry of fs.readdirSync(dir).sort()) {
    const path = join(dir, entry)
    const key = rel === '' ? entry : `${rel}/${entry}`
    if (fs.lstatSync(path).isDirectory()) Object.assign(out, treeOf(path, key))
    else out[key] = fs.readFileSync(path, 'utf8')
  }
  return out
}

/** Wait until `check` holds (a move carried on in the background), or fail. */
async function until(check, what) {
  for (let i = 0; i < 2000; i++) {
    if (await check()) return
    await new Promise((done) => setTimeout(done, 5))
  }
  throw new Error(`never: ${what}`)
}

/**
 * A mount under `$DSH_HOME` = `home` with dsh's web server: `call` its store route, `move`
 * the store (answered once it is done), `guardAt` the guard under that home.
 */
function storeMount(home, config = {}, options = {}) {
  const m = withDshHome(home, () => mount(config, options))
  const routes = []
  m.mountLate('connection', { fetch: { register: (route) => { routes.push(route); return async () => {} } } })
  const route = routes.find((r) => r.path === '/api/engramory/store')
  const call = (method = 'GET', body, query = '') => withHomeAsync(home, async () => {
    const init = { method }
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body)
      init.headers = { 'content-type': 'application/json' }
    }
    const response = await route.fetch(new Request(`http://127.0.0.1${route.path}${query}`, init))
    return { status: response.status, body: await response.json() }
  })
  const move = (to) => call('POST', { to })
  const guardAt = (exec) => withDshHome(home, () => m.guard(exec))
  return { ...m, call, move, guardAt, routes }
}

/**
 * Run `during` while `m` moves its store to `to` and waits before it copies (MOVE_DRAIN_MS, held
 * at 300 ms here), then let the move finish: what it answered.
 */
async function duringMove(m, to, during) {
  const before = process.env.ENGRAMORY_MOVE_WAIT_MS
  process.env.ENGRAMORY_MOVE_WAIT_MS = '300'
  try {
    const moving = m.move(to)
    await until(async () => (await m.call('GET')).body.moving === true, 'the move under way')
    await during()
    return await moving
  } finally {
    process.env.ENGRAMORY_MOVE_WAIT_MS = before
  }
}

test('store: moved with every file, the old place kept beside it as a backup, and recall, the skill and the memory page follow it', async () => {
  const { home, dir } = homeStore('mv-home')
  const before = treeOf(dir)
  const to = join(scratch('mv-to'), 'AI记忆')
  const prompt = promptRegistry()
  const m = storeMount(home, { language: 'en' }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  assert.deepEqual((await m.call('GET')).body, { store: dir, default: dir, file: join(home, POINTER) })
  assert.ok(m.skills[0].content.includes(dir))

  const moved = await m.move(to)
  assert.equal(moved.status, 200)
  const { backup } = moved.body
  assert.deepEqual(moved.body, { ok: true, to, backup })
  assert.equal(dirname(backup), home)
  assert.match(basename(backup), /^\.engramory-memory\.backup-\d{8}-\d{6}$/)
  assert.deepEqual(treeOf(to), before, 'every file, as it was')
  assert.deepEqual(treeOf(backup), before, 'and the old store kept whole')
  assert.equal(fs.existsSync(dir), false, 'renamed aside: nothing reaches it by its old name')
  assert.deepEqual(pointerIn(home), { version: 1, store: to, retired: [dir] })
  assert.deepEqual(fs.readdirSync(home).filter((n) => n.startsWith('.engramory-memory')).sort(),
    [basename(backup), POINTER].sort(), 'no copy left in the home')
  assert.deepEqual(fs.readdirSync(dirname(to)), ['AI记忆'], 'nor beside the new place')
  assert.equal((await m.call('GET')).body.store, to)

  const cwd = scratch('mv-cwd')
  assert.match(await withDshHome(home, () => prompt.recall(at(cwd))), /User memory index[\s\S]*who the user is/)
  await withDshHome(home, () => prompt.assembleFor(at(cwd)))
  assert.equal(m.skills.length, 1)
  assert.ok(m.skills[0].content.includes(to), 'the skill names the new place')
  const listed = await withHomeAsync(home, () => memoryMount().call())
  assert.deepEqual(listed.body.stores.map((s) => [s.kind, s.dir]), [['user', to]])
})

test('store: moved back to its default place, and a move to where it is does nothing', async () => {
  const { home, dir } = homeStore('mv-back')
  const to = join(scratch('mv-back-to'), 'vault')
  const m = storeMount(home)
  await m.move(to)
  const before = treeOf(to)
  const back = await m.move(null)
  assert.deepEqual(back.body, { ok: true, to: dir, backup: back.body.backup })
  assert.match(basename(back.body.backup), /^vault\.backup-/)
  assert.deepEqual(treeOf(dir), before)
  assert.deepEqual(treeOf(back.body.backup), before)
  assert.equal(fs.existsSync(to), false)
  assert.deepEqual(pointerIn(home), { version: 1, retired: [to] }, 'the default place is named by no file')
  assert.equal((await m.call('GET')).body.store, dir)
  assert.deepEqual(await m.call('POST', { to: null }), { status: 200, body: { ok: true, same: true } })
  assert.deepEqual(await m.call('POST', { to: `${dir}${process.platform === 'win32' ? '\\' : '/'}` }),
    { status: 200, body: { ok: true, same: true } })
})

test('store: with no store yet, a move names the new place and makes its folder', async () => {
  const home = scratch('mv-none')
  const to = join(scratch('mv-none-to'), 'vault')
  const m = storeMount(home)
  assert.deepEqual((await m.move(to)).body, { ok: true, to }, 'nothing to keep as a backup')
  assert.deepEqual(pointerIn(home), { version: 1, store: to, retired: [join(home, '.engramory-memory')] })
  assert.deepEqual(fs.readdirSync(to), [])
  // a moved store that is not there now is not one not made yet: a drive not mounted, say
  rmSync(to, { recursive: true })
  assert.deepEqual(await m.call('POST', { to: join(scratch('mv-none-2'), 'v') }),
    { status: 400, body: { ok: false, error: 'source', reason: 'unavailable' } })
})

test('store: a move the home\'s file could not name is refused, and nothing is written', async () => {
  // a dsh home so deep that its default place is past the depth the home's file may name
  const home = join(scratch('mv-deep'), ...Array.from({ length: 32 }, () => 'd'))
  mkdirSync(home, { recursive: true })
  const m = storeMount(home)
  assert.deepEqual(await m.call('POST', { to: join(scratch('mv-deep-to'), 'v') }),
    { status: 400, body: { ok: false, error: 'place', reason: 'invalid' } })
  assert.deepEqual(fs.readdirSync(home), [], 'nothing written')
})

test('store: a place a move refuses, by name or as the disk has it, and nothing is written', async () => {
  const { home, dir } = homeStore('mv-bad')
  const m = storeMount(home)
  const full = scratch('mv-full')
  writeFileSync(join(full, 'x.txt'), 'x', 'utf8')
  const file = join(scratch('mv-file'), 'f')
  writeFileSync(file, 'x', 'utf8')
  const project = scratch('mv-proj')
  const cases = [
    ['relative/vault', 'relative'],
    [` ${join(full, 'v')}`, 'invalid'],
    // a last name ending in a space once resolved (refused by name on Windows, as read back elsewhere)
    [`${join(full, 'v ')}${process.platform === 'win32' ? '\\' : '/'}`, 'invalid'],
    [resolve('/'), 'root'],
    [home, 'reserved'],
    [join(home, 'profiles', 'web'), 'reserved'],
    [homedir(), 'reserved'],
    [dirname(homedir()), 'reserved'],
    [join(project, '.engramory-memory'), 'reserved'],
    [join(project, '.engramory-memory-old-abcdefgh'), 'reserved'],
    [full, 'notEmpty'],
    [file, 'notDir'],
    [join(dir, 'inner'), 'reserved'],
  ]
  if (process.platform === 'win32') {
    cases.push(['\\\\host\\share\\vault', 'network'], ['D:vault', 'relative'], ['\\vault', 'relative'],
      [join(full, 'vault.'), 'invalid'], [join(full, 'con'), 'invalid'], [join(full, 'a:b'), 'invalid'])
  }
  for (const [to, reason] of cases) {
    assert.deepEqual(await m.call('POST', { to }), { status: 400, body: { ok: false, error: 'place', reason } }, to)
  }
  for (const [body, field] of [[{ to: 3 }, 'to'], [{}, 'body'], ['nope', 'body'], [[], 'body']]) {
    assert.deepEqual(await m.call('POST', body), { status: 400, body: { ok: false, error: 'invalid', field } })
  }
  assert.deepEqual(fs.readdirSync(home), ['.engramory-memory'], 'nothing written')
})

test('store: a place that is the store, or inside it, under another name', async () => {
  const { home } = homeStore('mv-alias-place')
  const to = join(scratch('mv-alias-to'), 'vault')
  const m = storeMount(home)
  await m.move(to)
  assert.deepEqual(await m.call('POST', { to: join(to, 'sub') }),
    { status: 400, body: { ok: false, error: 'place', reason: 'nested' } })
  assert.deepEqual(await m.call('POST', { to: dirname(to) }),
    { status: 400, body: { ok: false, error: 'place', reason: 'nested' } })
  const alias = join(scratch('mv-alias-link'), 'alias')
  symlinkSync(to, alias, linkKind)
  assert.deepEqual(await m.call('POST', { to: alias }), { status: 200, body: { ok: true, same: true } })
  assert.deepEqual(await m.call('POST', { to: join(alias, 'sub') }),
    { status: 400, body: { ok: false, error: 'place', reason: 'nested' } })
  const empty = scratch('mv-alias-empty')
  const link = join(scratch('mv-alias-link2'), 'link')
  symlinkSync(empty, link, linkKind)
  assert.deepEqual(await m.call('POST', { to: link }),
    { status: 400, body: { ok: false, error: 'place', reason: 'link' } })
})

test('store: a store that is a link, or holds one, is not moved, and nothing changes', async () => {
  const { home, dir } = homeStore('mv-link')
  symlinkSync(scratch('mv-link-out'), join(dir, 'out'), linkKind)
  const to = join(scratch('mv-link-to'), 'vault')
  const m = storeMount(home)
  assert.deepEqual(await m.move(to), { status: 500, body: { ok: false, error: 'link' } })
  assert.equal(fs.existsSync(to), false)
  assert.deepEqual(fs.readdirSync(dirname(to)), [], 'no copy left beside it')
  assert.deepEqual(fs.readdirSync(home), ['.engramory-memory'], 'no home file')
  assert.ok(fs.existsSync(join(dir, 'a.md')))
  assert.equal(m.guardAt(write(join(dir, 'a.md'), 'x')), undefined, 'writes are let through again')

  const linked = homeStore('mv-link2')
  const vault = scratch('mv-link2-vault')
  fs.renameSync(linked.dir, join(vault, 'moved'))
  symlinkSync(join(vault, 'moved'), linked.dir, linkKind)
  assert.deepEqual(await storeMount(linked.home).call('POST', { to: join(scratch('mv-link2-to'), 'v') }),
    { status: 400, body: { ok: false, error: 'source', reason: 'link' } })
})

test('store: a pinned index, a home on another machine, a move under way: no move', async (t) => {
  const { home } = homeStore('mv-no')
  const to = join(scratch('mv-no-to'), 'v')
  assert.deepEqual(await storeMount(home, { indexPath: join(scratch('mv-pin'), INDEX) }).call('POST', { to }),
    { status: 409, body: { ok: false, error: 'pinned' } })
  const m = storeMount(home)
  const moved = await duringMove(m, to, async () => {
    assert.deepEqual(await m.call('POST', { to: join(scratch('mv-no-2'), 'v') }),
      { status: 409, body: { ok: false, error: 'busy' } })
  })
  assert.equal(moved.body.ok, true)
  // what a 1.5 move left in the home (its journal, its lock) is nothing to this one
  writeJson(join(home, '.engramory-memory-move.json'), { version: 1, id: 'abcdefgh', phase: 'staged', from: to, to: home })
  writeJson(join(home, '.engramory-memory.lock'), { id: 'abcdefgh', pid: process.ppid, at: Date.now() })
  assert.equal((await m.call('GET')).body.problem, undefined)
  assert.equal((await m.move(null)).body.ok, true)
  if (process.platform !== 'win32') return t.skip('UNC paths are a Windows notion')
  const remote = storeMount('\\\\no-such-host.invalid\\share\\.dsh')
  assert.deepEqual(await remote.call('POST', { to }), { status: 409, body: { ok: false, error: 'remote' } })
})

test('store: dsh\'s file tools are held off both places while a move runs, and turned from the old one after', async () => {
  const { home, dir } = homeStore('mv-hold')
  const to = join(scratch('mv-hold-to'), 'vault')
  const m = storeMount(home, { language: 'en' })
  const moved = await duringMove(m, to, () => {
    for (const path of [join(dir, 'a.md'), join(to, 'b.md'), join(dir, INDEX)]) {
      assert.match(m.guardAt(write(path, 'x')) ?? '', /being moved/, path)
    }
    assert.match(m.guardAt({ name: 'str_replace_editor',
      arguments: { command: 'create', path: join(to, 'c.md'), file_text: 'x' } }) ?? '', /being moved/)
    assert.match(m.guardAt({ name: 'str_replace_editor', arguments: { command: 'undo_edit', path: join(dir, INDEX) } }) ?? '',
      /being moved/, 'an editor command dsh\'s own tool does not have too')
    assert.equal(m.guardAt({ name: 'str_replace_editor', arguments: { command: 'view', path: join(dir, INDEX) } }), undefined)
    assert.equal(m.guardAt(write(join(scratch('mv-else'), 'a.md'), 'x')), undefined, 'anywhere else is not')
    assert.equal(m.guardAt({ name: 'read', arguments: { file_path: join(dir, 'a.md') } }), undefined, 'reads are not')
  })
  assert.equal(moved.body.ok, true)
  // done: a write to the old place is sent to the new one
  const reason = m.guardAt(write(join(dir, 'a.md'), 'x')) ?? ''
  assert.match(reason, /has moved to/)
  assert.ok(reason.includes(to))
  assert.equal(m.guardAt(write(join(to, 'a.md'), 'x')), undefined)
})

test('store: a write is judged again at dsh\'s last hook before it lands, after any approval it waited for', async () => {
  // dsh-tool-fs asks to widen the sandbox inside the call, after the guard; a move started
  // while that waits must still hold the write off (fs/write-intent, fs/edit-intent), and
  // apply_patch's delete (fs/delete-intent)
  const { home, dir } = homeStore('mv-intent')
  const to = join(scratch('mv-intent-to'), 'vault')
  // dsh's read-before-write policy (dsh-fs-observation-policy) is there first and answers
  // these hooks without passing them on: this plugin's listener must run ahead of it
  const policy = () => 'intent'
  const hooks = ['fs/write-intent', 'fs/edit-intent', 'fs/delete-intent']
  const m = storeMount(home, { language: 'en' }, { listeners: Object.fromEntries(hooks.map((h) => [h, [policy]])) })
  for (const hook of hooks) assert.deepEqual([m.listeners.get(hook)?.length, m.listeners.get(hook)?.[1]], [2, policy], hook)
  // a dsh waterfall: each listener gets the target, the actor and the rest of the chain
  const intent = (hook, target) => withDshHome(home, () => {
    const list = m.listeners.get(hook)
    const run = (i) => (i < list.length ? list[i](target, {}, () => run(i + 1)) : undefined)
    return { passed: true, value: run(0) }
  })
  const at = (p) => ({ displayPath: p, targetKey: p })
  // no move: every write goes on, with what the rest of the chain decides
  for (const hook of hooks) assert.deepEqual(intent(hook, at(join(dir, 'a.md'))), { passed: true, value: 'intent' })
  // a move under way: both places refused, the guard's reason, the chain not run
  await duringMove(m, to, () => {
    for (const hook of hooks) {
      for (const path of [join(dir, 'a.md'), join(to, 'b.md')]) {
        assert.throws(() => intent(hook, at(path)), /being moved/, `${hook} ${path}`)
      }
      // the resolved key alone is enough: a link spelled elsewhere that dsh resolved into the store
      assert.throws(() => intent(hook, { displayPath: join(scratch('mv-intent-link'), 'a.md'), targetKey: join(dir, 'a.md') }),
        /being moved/)
      assert.deepEqual(intent(hook, at(join(scratch('mv-intent-else'), 'a.md'))), { passed: true, value: 'intent' })
      // a target dsh did not resolve cannot be placed while a move runs
      assert.throws(() => intent(hook, { displayPath: 'a.md' }), /being moved/)
    }
  })
  // done: the old place turns the write to the new one; the new one takes it
  assert.throws(() => intent('fs/write-intent', at(join(dir, 'a.md'))), (error) => error.message.includes(to))
  assert.deepEqual(intent('fs/write-intent', at(join(to, 'a.md'))), { passed: true, value: 'intent' })
  assert.deepEqual(intent('fs/write-intent', { displayPath: 'a.md' }), { passed: true, value: 'intent' },
    'after a move, a target that cannot be placed goes on, as at the guard')
})

test('store: a home file that cannot be taken as written names no place', async () => {
  const { home, dir } = homeStore('mv-broken')
  writeFileSync(join(home, POINTER), '{ not json', 'utf8')
  const prompt = promptRegistry()
  const m = storeMount(home, { language: 'en' }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const cwd = scratch('mv-broken-cwd')
  assert.equal(await withDshHome(home, () => prompt.recall(at(cwd))), '', 'no index is guessed at')
  assert.match(m.skills[0].content, /cannot be read just now/)
  assert.deepEqual((await m.call('GET')).body,
    { store: null, default: dir, file: join(home, POINTER), problem: 'pointer' })
  assert.deepEqual(await m.call('POST', { to: join(scratch('mv-broken-to'), 'v') }),
    { status: 409, body: { ok: false, error: 'problem' } })
  assert.equal((await withHomeAsync(home, () => memoryMount().call())).body.location, 'unknown')
  // fixed, it is seen again
  writeJson(join(home, POINTER), { version: 1 })
  assert.match(await withDshHome(home, () => prompt.recall(at(cwd))), /User memory index/)
})

test('store: the home file is taken only as written', async () => {
  const home = scratch('mv-pointer')
  const m = storeMount(home)
  const shown = async (text) => {
    writeFileSync(join(home, POINTER), text, 'utf8')
    return (await m.call('GET')).body
  }
  for (const value of [{ version: 2 }, [], { version: 1, store: 'relative/v' }, { version: 1, store: 3 },
    { version: 1, store: join(home, 'profiles', 'x') }, { version: 1, store: homedir() },
    { version: 1, store: join(scratch('mv-p'), '.engramory-memory') }, { version: 1, retired: 'x' },
    { version: 1, retired: Array.from({ length: 9 }, (_, i) => join(scratch('mv-r'), `r${i}`)) }]) {
    assert.equal((await shown(JSON.stringify(value))).problem, 'pointer', JSON.stringify(value))
  }
  const to = join(scratch('mv-pointer-to'), 'v')
  // a hand edit's byte order mark, and the store among the places it moved from, are fine
  const fine = await shown(`\uFEFF${JSON.stringify({ version: 1, store: to, retired: [to] })}`)
  assert.equal(fine.problem, undefined)
  assert.equal(fine.store, to)
})

test('store: the skill names where the store is again once another dsh has moved it', async () => {
  const home = scratch('mv-skill')
  const prompt = promptRegistry()
  const m = withDshHome(home, () => mount({ language: 'en' }, { workingDirectory: sessionDirs(), systemPrompt: prompt }))
  assert.ok(m.skills[0].content.includes(join(home, '.engramory-memory')))
  const to = join(scratch('mv-skill-to'), 'vault')
  writeJson(join(home, POINTER), { version: 1, store: to })
  await withDshHome(home, () => prompt.assembleFor(at(scratch('mv-skill-cwd'))))
  assert.equal(m.skills.length, 1)
  assert.ok(m.skills[0].content.includes(to))
  // a skill of the user's own is left as written
  const own = withDshHome(home, () => mount({ skill: '# my rules' }))
  assert.equal(own.skills[0].content, '# my rules')
})

test('store GET: what a move would meet — a pinned index, a skill of the user\'s own, the installer\'s AGENTS.md block', async () => {
  const home = scratch('mv-flags')
  writeFileSync(join(home, 'AGENTS.md'),
    '# mine\n\n<!-- BEGIN ENGRAMORY DSH -->\nrules\n<!-- END ENGRAMORY DSH -->\n', 'utf8')
  const { body } = await storeMount(home, { indexPath: join(scratch('mv-flags-pin'), INDEX), skill: '# mine' }).call('GET')
  assert.deepEqual([body.pinned, body.customSkill, body.legacyRules], [true, true, true])
  const plain = (await storeMount(scratch('mv-flags-2')).call('GET')).body
  assert.deepEqual([plain.pinned, plain.customSkill, plain.legacyRules], [undefined, undefined, undefined])
})

test('store: a project\'s store that is the global store under another name is shown once, as the global one', async () => {
  const home = scratch('mv-twin')
  const project = scratch('mv-twin-repo')
  mkdirSync(join(project, '.git'))
  const vault = join(project, 'vault')
  mkdirSync(vault)
  writeFileSync(join(vault, INDEX), '- [u](u.md) - the user\n', 'utf8')
  symlinkSync(vault, join(project, '.engramory-memory'), linkKind)
  writeJson(join(home, POINTER), { version: 1, store: vault })
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = await withDshHome(home, () => prompt.recall(at(project)))
  assert.match(text, /^User memory index/)
  assert.equal(text.match(/memory index \(/g).length, 1)
})

test('store: a store gone between the ask and the copy (a drive pulled out) is not taken for none', async () => {
  const { home } = homeStore('mv-gone')
  const away = join(scratch('mv-gone-drive'), 'vault')
  const m = storeMount(home)
  await m.move(away) // the store is now somewhere a drive can be pulled out of
  const to = join(scratch('mv-gone-to'), 'v')
  const before = process.env.ENGRAMORY_MOVE_WAIT_MS
  process.env.ENGRAMORY_MOVE_WAIT_MS = '300' // the moment before the copy
  try {
    const moving = m.call('POST', { to })
    await until(async () => (await m.call('GET')).body.moving === true, 'the move under way')
    fs.renameSync(away, `${away}-unplugged`)
    assert.deepEqual(await moving, { status: 500, body: { ok: false, error: 'unavailable' } })
  } finally {
    process.env.ENGRAMORY_MOVE_WAIT_MS = before
  }
  assert.equal(pointerIn(home).store, away, 'still where it was')
  assert.equal(fs.existsSync(to), false)
})

test('store: a switch that fails once the copy is at the new place leaves the copy there, and says so', async () => {
  // a sync client may have added to it by then: nothing at the new place is deleted
  const { home, dir } = homeStore('mv-left')
  const before = treeOf(dir)
  const to = join(scratch('mv-left-to'), 'vault')
  const m = storeMount(home)
  const answer = await duringMove(m, to, () => writeFileSync(join(home, POINTER), '{ not json', 'utf8'))
  assert.deepEqual(answer, { status: 500, body: { ok: false, error: 'pointer', left: to } })
  assert.deepEqual(treeOf(to), before, 'the copy is left where it is')
  assert.deepEqual(treeOf(dir), before, 'and the store too')
  assert.deepEqual(fs.readdirSync(dirname(to)), ['vault'], 'no other copy beside it')
})

test('store: with no store yet, a new place something filled in meanwhile is not taken for the store', async () => {
  const home = scratch('mv-none-filled')
  const to = join(scratch('mv-none-filled-to'), 'vault')
  const m = storeMount(home)
  const answer = await duringMove(m, to, () => {
    mkdirSync(to, { recursive: true })
    writeFileSync(join(to, INDEX), '- [x](x.md) - someone else\'s\n', 'utf8')
  })
  assert.deepEqual(answer, { status: 500, body: { ok: false, error: 'notEmpty' } })
  assert.equal(fs.existsSync(join(home, POINTER)), false, 'not switched')
  assert.deepEqual(fs.readdirSync(to), [INDEX], 'and what was there is left')
})

test('store: an old place something holds open is kept where it is, as the backup, and the page is told', async () => {
  const { home, dir } = homeStore('mv-kept')
  const before = treeOf(dir)
  const to = join(scratch('mv-kept-to'), 'vault')
  const m = storeMount(home, { language: 'en' })
  const rename = fs.promises.rename
  fs.promises.rename = async (from, target) => {
    if (from === dir) throw Object.assign(new Error('held open'), { code: 'EBUSY' })
    return rename(from, target)
  }
  syncBuiltinESMExports()
  let moved
  try {
    moved = await m.move(to)
  } finally {
    fs.promises.rename = rename
    syncBuiltinESMExports()
  }
  assert.deepEqual(moved, { status: 200, body: { ok: true, to, backup: dir, kept: true } })
  assert.deepEqual(treeOf(dir), before)
  assert.deepEqual(treeOf(to), before)
  assert.deepEqual(pointerIn(home), { version: 1, store: to, retired: [dir] })
  assert.match(m.guardAt(write(join(dir, 'a.md'), 'x')) ?? '', /has moved to/, 'turned from it as from any old place')
})

test('store: a move into a folder inside a place it moved from leaves the new place open to writes', async () => {
  const { home } = homeStore('mv-nest')
  const a = join(scratch('mv-nest-a'), 'A')
  const b = join(scratch('mv-nest-b'), 'B')
  const m = storeMount(home, { language: 'en' })
  assert.equal((await m.move(a)).body.ok, true)
  assert.equal((await m.move(b)).body.ok, true)
  const sub = join(a, 'sub')
  assert.equal((await m.move(sub)).body.ok, true)
  assert.equal(m.guardAt(write(join(sub, 'a.md'), 'x')), undefined, 'the store itself is not turned away from')
  assert.ok(!pointerIn(home).retired.includes(a), 'A holds the store now: not a place it moved from')
  assert.match(m.guardAt(write(join(b, 'a.md'), 'x')) ?? '', /has moved to/)
  // a home file written so by hand (or by a version that kept it) is read the same way
  writeJson(join(home, POINTER), { version: 1, store: sub, retired: [a, b] })
  assert.equal(m.guardAt(write(join(sub, 'b.md'), 'x')), undefined)
})

test('store: a dsh home spelled another way still reads a home file that names its default place', () => {
  const real = scratch('mv-spelling')
  const alias = join(scratch('mv-spelling-link'), 'home')
  symlinkSync(real, alias, linkKind)
  const to = join(scratch('mv-spelling-to'), 'vault')
  // written by a dsh that spells the home `real`; read by one that spells it `alias`
  writeJson(join(real, POINTER), { version: 1, store: to, retired: [join(real, '.engramory-memory')] })
  withDshHome(alias, () => {
    const prompt = promptRegistry()
    const m = mount({ language: 'en' }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
    assert.ok(m.skills[0].content.includes(to), 'the home file is taken as written')
  })
})

test('store: a place the store moved from, spelled through a link, does not hold off the store inside it', async (t) => {
  const real = scratch('mv-spell-real')
  const alias = join(scratch('mv-spell-link'), 'alias')
  symlinkSync(real, alias, linkKind)
  const home = scratch('mv-spell-home')
  const store = join(real, 'A', 'sub')
  mkdirSync(store, { recursive: true })
  // moved from A, as one dsh spelled it, to a folder inside it, as another does
  writeJson(join(home, POINTER), { version: 1, store, retired: [join(alias, 'A')] })
  const m = storeMount(home)
  assert.equal(m.guardAt(write(join(store, 'a.md'), 'x')), undefined)
})

/** dsh's directory chooser as the memory page uses it: `native`, answering with what `choose` gives. */
const chooserStub = (choose, kind = 'native') => ({
  capability: () => (kind === 'native' ? { kind, pick: (signal) => choose(signal) } : { kind, list: async () => ({}) }),
})

/** POST on the chooser route of a storeMount. */
async function pickOn(m) {
  const route = m.routes.find((r) => r.path === '/api/engramory/store/pick')
  const response = await route.fetch(new Request('http://127.0.0.1/api/engramory/store/pick', { method: 'POST', body: '{}' }))
  return { status: response.status, body: await response.json() }
}

test('store chooser: dsh\'s own folder chooser, where it opens on this desktop, fills in where the store would go', async () => {
  const { home, dir } = homeStore('mv-chooser')
  const empty = scratch('mv-chooser-empty')
  const full = scratch('mv-chooser-full')
  writeFileSync(join(full, 'x.txt'), 'x', 'utf8')
  let signal
  for (const [chosen, expected] of [
    [empty, { ok: true, path: empty, to: empty }],
    [full, { ok: true, path: full, to: join(full, 'Engramory'), inside: 'Engramory' }],
    [dir, { ok: true, path: dir, to: dir }], // the store itself: the move says it is there already
    [null, { ok: true, cancelled: true }],
  ]) {
    const m = storeMount(home, {}, { services: { directoryPicker: chooserStub(async (s) => { signal = s; return chosen }) } })
    assert.equal((await m.call('GET')).body.chooser, true)
    assert.deepEqual(await withHomeAsync(home, () => pickOn(m)), { status: 200, body: expected }, String(chosen))
    assert.ok(signal instanceof AbortSignal)
  }
  assert.equal(fs.existsSync(join(full, 'Engramory')), false, 'nothing is made or moved by choosing')
  assert.deepEqual(fs.readdirSync(home), ['.engramory-memory'])
})

test('store chooser: none where dsh has no chooser opening here, one at a time, and a failure said', async () => {
  const { home } = homeStore('mv-chooser-no')
  for (const services of [{}, { directoryPicker: chooserStub(async () => null, 'browse') }]) {
    const m = storeMount(home, {}, { services })
    assert.equal((await m.call('GET')).body.chooser, undefined)
    assert.deepEqual(await pickOn(m), { status: 409, body: { ok: false, error: 'unavailable' } })
  }
  const failing = storeMount(home, {}, { services: { directoryPicker: chooserStub(async () => { throw new Error('no zenity') }) } })
  assert.deepEqual(await pickOn(failing), { status: 502, body: { ok: false, error: 'failed', message: 'no zenity' } })
  let release
  const held = storeMount(home, {}, { services: { directoryPicker: chooserStub(() => new Promise((done) => { release = done })) } })
  const route = held.routes.find((r) => r.path === '/api/engramory/store/pick')
  const first = route.fetch(new Request('http://127.0.0.1/x', { method: 'POST', body: '{}' }))
  const second = await route.fetch(new Request('http://127.0.0.1/x', { method: 'POST', body: '{}' }))
  assert.deepEqual([second.status, await second.json()], [409, { ok: false, error: 'busy' }])
  release(null)
  assert.equal((await first).status, 200)
})

test('memory GET: a global store not made yet is said to be absent, beside the projects\' stores listed', async () => {
  const home = scratch('mem-noglobal')
  // as dsh records a workspace: its real path (CI's temp folders are reached through 8.3 names, /var)
  const repo = realpathSync.native(scratch('mem-noglobal-repo'))
  mkdirSync(join(repo, '.git'))
  store(repo, '- [p](p.md) - project\n')
  const listed = await withHomeAsync(home, () => memoryMount({}, { workspaces: [{ id: 'w', path: repo, title: 'repo' }] }).call())
  assert.deepEqual(listed.body.stores.map((s) => s.kind), ['project'])
  assert.equal(listed.body.global, 'absent')
  mkdirSync(join(home, '.engramory-memory'))
  const again = await withHomeAsync(home, () => memoryMount({}, { workspaces: [{ id: 'w', path: repo, title: 'repo' }] }).call())
  assert.equal(again.body.global, undefined, 'made: listed, not absent')
})

test('store chooser: a request already gone opens no window; a chosen share is not looked into', async (t) => {
  const { home } = homeStore('mv-chooser-gone')
  let opened = 0
  const m = storeMount(home, {}, { services: { directoryPicker: chooserStub(async () => { opened++; return null }) } })
  const route = m.routes.find((r) => r.path === '/api/engramory/store/pick')
  const gone = new AbortController()
  gone.abort()
  const response = await route.fetch(new Request('http://127.0.0.1/x', { method: 'POST', body: '{}', signal: gone.signal }))
  assert.deepEqual([response.status, await response.json()], [409, { ok: false, error: 'gone' }])
  assert.equal(opened, 0)
  if (process.platform !== 'win32') return t.skip('UNC paths are a Windows notion')
  const share = '\\\\no-such-host.invalid\\share\\vault'
  const unc = storeMount(home, {}, { services: { directoryPicker: chooserStub(async () => share) } })
  const seen = await sharesTouched(() => withHomeAsync(home, () => pickOn(unc)))
  assert.deepEqual(seen.result.body, { ok: true, path: share, to: share })
  assert.deepEqual(seen.touched, [], 'no lookup on the share')
})

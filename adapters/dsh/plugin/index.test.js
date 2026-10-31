/**
 * node --test adapters/dsh/plugin
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
import fs, {
  chmodSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, statSync, symlinkSync,
  utimesSync, writeFileSync,
} from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { homedir, hostname, tmpdir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'
import { test } from 'node:test'

import { apply, inject, name } from './index.js'

// Where neither the config nor dsh names a language, the memory follows the system's:
// pinned here, so the tests read the same on every machine.
let systemLocale = 'en-US'
const resolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions
Intl.DateTimeFormat.prototype.resolvedOptions = function (...args) {
  return { ...resolvedOptions.apply(this, args), locale: systemLocale }
}

function mount(config = {}, { withSkills = true, workingDirectory, systemPrompt, rowId, projections = projectionRegistry(), services: extra = {} } = {}) {
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
  const makeCtx = (declared) => new Proxy({}, {
    get(_, prop) {
      if (prop === 'fiber') return fiber
      if (prop === 'get') return (name) => services[name]
      if (prop === 'effect') return (fn) => fn()
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
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i]()) pending.splice(i, 1)
    }
  }
  const mountSkillsLate = () => mountLate('skills', skillRegistry)
  return { guard, skills, mountSkillsLate, mountLate, fiber, projections }
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

/** dsh's prompt registry, keeping every runtime context registered on it. */
const promptRegistry = () => {
  const contexts = []
  // What reaches the model: every non-empty context in order; with `optionalOff`, as under
  // a persona preset that turns optional runtime context off, only the required ones.
  const render = (context, { optionalOff = false } = {}) => contexts
    .filter((spec) => !optionalOff || spec.required === true)
    .map((spec) => spec.text(context)).filter(Boolean).join('\n\n')
  return { contexts, render, context: (spec) => { contexts.push(spec); return () => {} } }
}

/** Run `fn` with `$DSH_HOME` set to `home` (or unset), then put it back. */
function withDshHome(home, fn) {
  const before = process.env.DSH_HOME
  if (home === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = home
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = before
  }
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
  try {
    return { result: fn(), touched }
  } finally {
    Object.assign(fs, saved)
    syncBuiltinESMExports()
  }
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

test('a relative pinned index is the one in the session\'s directory, as recall reads it', () => {
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
  assert.match(prompt.contexts[0].text(at(a)), /pinned here/)
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

test('where the OS will not resolve a path, Node\'s walk does, and a link out of a project stays out', (t) => {
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
    assert.match(withDshHome(home, () => prompt.contexts[0].text(at(project))), /in the project/)
    assert.doesNotMatch(withDshHome(home, () => prompt.contexts[0].text(at(linked))), /secret line/)
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
    apply({ tools: { guard: (g) => { guard = g } }, inject: () => {} })
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

test('the index is injected as literal runtime context, from the session\'s project store', () => {
  const project = scratch('inject')
  store(project, '- [a](a.md) - first {{not-a-variable\n- [b](b.md) - second\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  assert.equal(prompt.contexts.length, 1)
  const [spec] = prompt.contexts
  assert.equal(spec.name, 'engramory:memory-index')
  assert.equal(spec.interpolate, false, 'a {{ in a note title must never reach dsh interpolation')
  const text = withDshHome(scratch('home'), () => spec.text(at(project)))
  assert.match(text, /^Project memory index \(`.*MEMORY\.md`\), loaded for you by dsh-engramory/)
  assert.match(text, /first \{\{not-a-variable\n- \[b\]\(b\.md\) - second$/)
  assert.doesNotMatch(text, /User memory index/)
})

test('the global store under $DSH_HOME is injected too, and one file only once', () => {
  const project = scratch('inject')
  const home = scratch('home')
  store(project, '- [p](p.md) - project\n')
  store(home, '- [u](u.md) - user\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const both = withDshHome(home, () => prompt.contexts[0].text(at(project)))
  assert.match(both, /Project memory index[\s\S]*- project[\s\S]*User memory index[\s\S]*- user/)
  const once = withDshHome(home, () => prompt.contexts[0].text(at(home)))
  assert.equal(once.match(/memory index \(/g).length, 1, 'a session in $DSH_HOME itself sees it once')
})

test('no store means no injection, and a pinned indexPath is the only index injected', () => {
  const empty = scratch('inject')
  const home = scratch('home')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  assert.equal(withDshHome(home, () => prompt.contexts[0].text(at(empty))), '')

  store(empty, '- [p](p.md) - project\n')
  const pinned = join(scratch('pinned'), INDEX)
  writeFileSync(pinned, '- [x](x.md) - pinned\n', 'utf8')
  const pinnedPrompt = promptRegistry()
  mount({ indexPath: pinned }, { workingDirectory: sessionDirs(), systemPrompt: pinnedPrompt })
  const text = withDshHome(home, () => pinnedPrompt.contexts[0].text(at(empty)))
  assert.match(text, /^Memory index/)
  assert.match(text, /- pinned$/)
  assert.doesNotMatch(text, /- project/)
})

test('recall does not look into a session directory on another machine', (t) => {
  if (process.platform !== 'win32') return t.skip('UNC paths are a Windows notion')
  const home = scratch('home')
  store(home, '- [u](u.md) - user\n')
  const unc = '\\\\no-such-host.invalid\\share\\repo'
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const seen = sharesTouched(() => withDshHome(home, () => prompt.contexts[0].text(at(unc))))
  assert.deepEqual(seen.touched, [], 'no lookup on the share')
  assert.match(seen.result, /^User memory index[\s\S]*- user$/, 'the store the user placed by name still is')
  // nor a pin relative to it
  const pinPrompt = promptRegistry()
  mount({ indexPath: 'notes/MEMORY.md' }, { workingDirectory: sessionDirs(), systemPrompt: pinPrompt })
  const pinned = sharesTouched(() => withDshHome(home, () => pinPrompt.contexts[0].text(at(unc))))
  assert.deepEqual(pinned, { result: '', touched: [] })
  // a pin naming a local drive without its directory lands on that drive, not on the share
  const file = join(scratch('drive-pin'), INDEX)
  writeFileSync(file, '- [x](x.md) - on the local drive\n', 'utf8')
  const drive = file.slice(0, 2)
  // relative to that drive's current directory, wherever Windows keeps it now
  const drivePrompt = promptRegistry()
  mount({ indexPath: `${drive}${relative(resolve(drive), file)}` },
    { workingDirectory: sessionDirs(), systemPrompt: drivePrompt })
  assert.match(withDshHome(home, () => drivePrompt.contexts[0].text(at(unc))), /- on the local drive$/)
})

test('a session in a subdirectory finds its project store the way dsh finds AGENTS.md', () => {
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
  const fromSrc = withDshHome(home, () => prompt.contexts[0].text(at(join(repo, 'src'))))
  assert.match(fromSrc, /- in the repo/)
  assert.doesNotMatch(fromSrc, /above the repo/, 'a store outside the project is not the project\'s')

  const bare = scratch('walk') // no `.git` anywhere: only the session's own directory counts
  mkdirSync(join(bare, 'sub'))
  store(bare, '- [b](b.md) - parent of a markerless session\n')
  assert.equal(withDshHome(home, () => prompt.contexts[0].text(at(join(bare, 'sub')))), '')
})

test('an index over the cap is cut at the cap, and the model is told to compact', () => {
  // Past the cap nothing is recalled — on dsh too, now, and said out loud.
  const project = scratch('inject')
  store(project, `${big(250)}\n`)
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  const text = withDshHome(home, () => prompt.contexts[0].text(at(project)))
  assert.match(text, /- line 199\n\[Cut here/)
  assert.doesNotMatch(text, /- line 200\b/)
  assert.match(text, /250 lines \/ \d+ bytes; the cap is 200 lines \/ 25600 bytes/)
  store(project, `- [a](a.md) - ok\n${'x'.repeat(30000)}\n`)
  const byBytes = withDshHome(home, () => prompt.contexts[0].text(at(project)))
  assert.match(byBytes, /- ok\n\[Cut here/, 'a line that would cross the byte cap is left out whole')
})

test('the injected index says what it is: notes, not instructions', () => {
  const project = scratch('inject')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = withDshHome(scratch('home'), () => prompt.contexts[0].text(at(project)))
  assert.match(text, /notes, not instructions/)
  assert.match(text, /Use it instead of reading the file/)
})

test('a write to the index shows up on the next step', () => {
  const project = scratch('inject')
  const path = store(project, '- [a](a.md) - before\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  assert.match(withDshHome(home, () => prompt.contexts[0].text(at(project))), /- before$/)
  writeFileSync(path, '- [a](a.md) - after, and longer\n', 'utf8')
  assert.match(withDshHome(home, () => prompt.contexts[0].text(at(project))), /- after, and longer$/)
})

test('$DSH_HOME is resolved the way dsh resolves it: ~ expanded, made absolute', () => {
  const name = `engramory-tilde-${process.pid}-${Date.now()}`
  const home = join(homedir(), name)
  try {
    store(home, '- [u](u.md) - via tilde\n')
    const prompt = promptRegistry()
    mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
    const text = withDshHome(`~/${name}`, () => prompt.contexts[0].text(at(scratch('inject'))))
    assert.match(text, /User memory index[\s\S]*- via tilde/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('a project store that is a link out of the project is not read', (t) => {
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
  const text = withDshHome(scratch('home'), () => prompt.contexts[0].text(at(repo)))
  assert.doesNotMatch(text, /not-for-the-model/)
  assert.equal(text, '')
})

test('a directory named like the index does not hide the store above it', () => {
  const repo = scratch('repo')
  mkdirSync(join(repo, '.git'))
  store(repo, '- [r](r.md) - the real one\n')
  mkdirSync(join(repo, 'src', '.engramory-memory', INDEX), { recursive: true })
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = withDshHome(scratch('home'), () => prompt.contexts[0].text(at(join(repo, 'src'))))
  assert.match(text, /- the real one$/)
})

test('an index past the byte cap is read only as far as the cap, BOM included', () => {
  const project = scratch('inject')
  const lines = Array.from({ length: 150 }, (_, i) => `- [n${i}](n${i}.md) - ${'x'.repeat(240)}`)
  store(project, `\uFEFF${lines.join('\n')}\n`)
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = withDshHome(scratch('home'), () => prompt.contexts[0].text(at(project)))
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

test('a project index that is itself a symlink is not read, even into the project', (t) => {
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
  assert.equal(withDshHome(scratch('home'), () => prompt.contexts[0].text(at(repo))), '')
})

test('a project store refused as a link does not hide the user store it points at', (t) => {
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
  const text = withDshHome(home, () => prompt.contexts[0].text(at(repo)))
  assert.match(text, /^User memory index[\s\S]*- the user store$/)
})

test('an index replaced by a same-sized file with the same mtime is still re-read', () => {
  const project = scratch('inject')
  const path = store(project, '- [a](a.md) - before\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const home = scratch('home')
  assert.match(withDshHome(home, () => prompt.contexts[0].text(at(project))), /- before$/)
  const { mtime } = statSync(path)
  const next = `${path}.next`
  writeFileSync(next, '- [a](a.md) - after!\n', 'utf8') // same length as "before"
  utimesSync(next, mtime, mtime)
  renameSync(next, path)
  assert.match(withDshHome(home, () => prompt.contexts[0].text(at(project))), /- after!$/)
})

test('a read that failed once is tried again on the next step', (t) => {
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
    assert.equal(withDshHome(home, () => prompt.contexts[0].text(at(project))), '')
  } finally {
    chmodSync(path, 0o644)
  }
  assert.match(withDshHome(home, () => prompt.contexts[0].text(at(project))), /- readable again$/)
})

test('recall reads no further than the read ceiling, whatever the configured cap', () => {
  const project = scratch('inject')
  const row = `- [n](n.md) - ${'x'.repeat(1000)}\n`
  store(project, row.repeat(17 * 1024)) // ~17 MiB, past the 16 MiB ceiling
  const prompt = promptRegistry()
  mount({ maxBytes: 64 * 1024 * 1024, maxLines: 1e6 }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = withDshHome(scratch('home'), () => prompt.contexts[0].text(at(project)))
  assert.match(text, /\[Cut here: only the first part of this \d+-byte index is shown\.\]$/)
  assert.ok(Buffer.byteLength(text) < 17 * 1024 * 1024)
})

test('past the read ceiling, a line-cap breach is still reported as one', () => {
  const project = scratch('inject')
  const row = `- [n](n.md) - ${'x'.repeat(1000)}\n`
  store(project, row.repeat(17 * 1024)) // ~17 MiB and 17408 lines
  const prompt = promptRegistry()
  mount({ maxBytes: 64 * 1024 * 1024 }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = withDshHome(scratch('home'), () => prompt.contexts[0].text(at(project)))
  assert.match(text, /over the Engramory cap \(more than 200 lines, \d+ bytes; the cap is 200 lines/)
  assert.match(text, /compact the index\.\]$/)
})

test('$DSH_HOME padded with spaces is taken as dsh takes it, not trimmed', () => {
  const home = scratch('home')
  store(home, '- [u](u.md) - user\n')
  const prompt = promptRegistry()
  mount({}, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = withDshHome(` ${home} `, () => prompt.contexts[0].text(at(scratch('inject'))))
  assert.doesNotMatch(text, /User memory index/)
})

test('injection can be turned off, and a host without runtime context keeps the cap', () => {
  const prompt = promptRegistry()
  mount({ injectIndex: false }, { systemPrompt: prompt })
  assert.equal(prompt.contexts.length, 0)
  const { guard } = mount({}, { systemPrompt: {} }) // a registry with no context()
  assert.match(guard(write(`/s/${INDEX}`, big(300))), /300 lines/)
})

test('a prompt registry that mounts after the plugin still gets the index', () => {
  const late = mount({}, { workingDirectory: sessionDirs() })
  const prompt = promptRegistry()
  late.mountLate('systemPrompt', prompt)
  assert.equal(prompt.contexts.length, 1)
})

test('recall never fails a request', () => {
  const prompt = promptRegistry()
  mount({}, { workingDirectory: { get: () => { throw new Error('boom') } }, systemPrompt: prompt })
  const real = process.cwd
  process.cwd = () => { throw new Error('ENOENT: uv_cwd') }
  try {
    assert.equal(prompt.contexts[0].text(at('/nowhere')), '')
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
    assert.ok(!blind.includes(flat(language === 'en' ? 'runtime context shows its index' : '运行时上下文里会出现它的「项目记忆索引」')), language)
    // another index name is the one named, everywhere
    const named = withDshHome(home, () => mount({ language, indexName: 'INDEX.md' })).skills[0].content
    assert.ok(named.includes('`INDEX.md`') && !named.includes('MEMORY.md'), language)
  }
})

test('in social mode the skill, which every conversation reads, names no store; the user\'s own learn it', () => {
  const home = scratch('socialhome')
  const global = join(home, '.engramory-memory')
  const prompt = promptRegistry()
  const { skills } = withDshHome(home, () => mount(COMPANION, { workingDirectory: sessionDirs(), systemPrompt: prompt }))
  const skill = skills[0].content.replace(/\s+/g, ' ')
  assert.ok(!skill.includes(global), 'no path a stranger could be told')
  assert.match(skill, /in the user's own conversations your runtime context gives its full path/)
  assert.match(skill, /If your runtime context says a conversation is not the user's own, the store is closed to it: do not read, create, write or name a store there/)
  const project = scratch('socialws')
  // no store yet: the user's own conversation is told where it will be
  const mine = withDshHome(home, () => prompt.render(as(own('own-store', project))))
  assert.ok(mine.includes(`Engramory: your memory store is \`${global}\`, its index \`MEMORY.md\``), mine)
  // anyone else's: the note that the store is closed, and no path
  const theirsText = withDshHome(home, () => prompt.render(as(theirs('qq-store', project))))
  assert.ok(!theirsText.includes(global), theirsText)
  assert.match(theirsText, /not the user's own/)
  // only a project's index shown: the global store, where the rest goes, is still named
  // (another project: recall remembers for a few seconds that the first one has no store)
  const withStore = scratch('socialws2')
  store(withStore, '- [p](p.md) - project\n')
  const partly = withDshHome(home, () => prompt.render(as(own('own-store-3', withStore))))
  assert.match(partly, /^Project memory index/)
  assert.ok(partly.includes(`your memory store is \`${global}\``), partly)
  // with the global store, its index shows the path as before, and the line is not repeated
  store(home, '- [u](u.md) - user\n')
  const shown = withDshHome(home, () => prompt.render(as(own('own-store-2', project))))
  assert.match(shown, /User memory index/)
  assert.doesNotMatch(shown, /your memory store is/)
  // a pin relative to the working directory is named as this session resolves it
  const pinPrompt = promptRegistry()
  mount({ ...COMPANION, indexPath: 'notes/INDEX.md' }, { workingDirectory: sessionDirs(), systemPrompt: pinPrompt })
  const pinned = withDshHome(home, () => pinPrompt.render(as(own('own-pin', project))))
  assert.ok(pinned.includes(`your memory store is \`${join(project, 'notes')}\`, its index \`INDEX.md\``), pinned)
})

test('a store path with backticks in it stays one code span', () => {
  const home = join(scratch('tick'), 'odd`name')
  const content = withDshHome(home, () => mount({ language: 'en' })).skills[0].content
  assert.ok(content.includes(`\`\`${join(home, '.engramory-memory')}\`\``), content.slice(0, 600))
})

test('the skill names exactly the headings this language injects the index under', () => {
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
    const text = withDshHome(home, () => prompt.contexts[0].text(at(project)))
    assert.ok(text.startsWith(labels[0].slice(1, -1)), `${language} project heading`)
    assert.ok(text.includes(labels[1].slice(1, -1)), `${language} user heading`)
  }
})

test('language: zh says what the injected index is, and cuts it in Chinese', () => {
  const project = scratch('inject')
  store(project, Array.from({ length: 205 }, (_, i) => `- [n${i}](n${i}.md) - 第 ${i} 条`).join('\n') + '\n')
  const prompt = promptRegistry()
  mount({ language: 'zh' }, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = withDshHome(scratch('home'), () => prompt.contexts[0].text(at(project)))
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
const COMPANION = { companion: true, audience: 'social' }

test('companion mode: the user\'s own conversation gets the index and the rules', () => {
  const project = scratch('companion')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount(COMPANION, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const text = withDshHome(scratch('home'), () => prompt.render(as(own('own-1', project))))
  assert.match(text, /^Project memory index[\s\S]*- \[a\]\(a\.md\) - first/)
  assert.match(text, /Companion mode \(大肥鱼模式\) is on[\s\S]*`moment`[\s\S]*`upcoming`[\s\S]*`self`/)
  // dsh's own producers decide nothing: context, skills and the like come and go
  const busy = own('own-2', project, said({ kind: 'time-context', form: 'notice' }),
    said({ kind: 'skill-catalog', form: 'catalog' }), TYPED)
  assert.match(withDshHome(scratch('home'), () => prompt.render(as(busy))), /- first/)
})

test('companion mode: anyone else\'s conversation gets no memory, only a note', () => {
  const project = scratch('companion')
  const home = scratch('home')
  store(project, '- [a](a.md) - first\n')
  store(home, '- [u](u.md) - user\n')
  const prompt = promptRegistry()
  mount(COMPANION, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const see = (context) => withDshHome(home, () => prompt.render(context))
  for (const context of [
    as(theirs('onebot-private-42', project)),
    as(sessionOf('quiet', project)), // nobody has written yet
    as(sessionOf('scheduled', project, {}, [said({ kind: 'schedule' })])), // an automation
    // once anyone else has written, the conversation is theirs for good, either order
    as(own('mixed', project, QQ)),
    as(sessionOf('mixed-2', project, {}, [QQ, TYPED])),
    {}, // no session to tell by: fails closed
    as({ cwd: project, header: {}, events: [TYPED] }),
  ]) {
    const text = see(context)
    assert.doesNotMatch(text, /- first|- user|memory index/)
    assert.match(text, /not the user's own/)
  }
})

test('companion mode: who wrote a message is read from the source dsh stamped on it', () => {
  const project = scratch('companion')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount(COMPANION, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const owner = (...events) => /- first/.test(withDshHome(scratch('home'),
    () => prompt.render(as(sessionOf('s', project, {}, events)))))
  assert.equal(owner(TYPED), true)
  for (const [source, why] of [
    [{ kind: 'user' }, 'dsh headless, or a bridge writing dsh\'s user kind'],
    [{ kind: 'user', rpcId: 'r-2' }, 'a program calling dsh web\'s API'],
    [{ kind: 'user', rpcId: 'r-3', clientTimeZone: 'UTC', principal: { kind: 'liveshare' } }, 'a caller dsh names'],
    [{ kind: 'plugin:dsh-onebot' }, 'a bridge under its own kind'],
    [{ kind: 'user', rpcId: 'r-4', clientTimeZone: 'UTC', speaker: { role: 'guest' } }, 'declared a guest'],
    [{ kind: '' }, 'no kind'],
    [null, 'no source'],
    [{ kind: 'qq-bridge' }, 'a bridge under a kind of its own without the plugin: prefix'],
    [{ kind: 'webhook' }, 'input from outside dsh'],
  ]) {
    assert.equal(owner(said(source)), false, why)
    assert.equal(owner(TYPED, said(source)), false, `${why}, after the user`)
  }
  // the bridge standard: a bridge declares the owner's own messages, and its own notices
  assert.equal(owner(said({ kind: 'plugin:dsh-onebot', speaker: { role: 'owner' } })), true)
  assert.equal(owner(said({ kind: 'user', speaker: { role: 'owner' } })), true)
  assert.equal(owner(said({ kind: 'plugin:aurabot', speaker: { role: 'owner', chat: 'private' } })), true)
  // the owner in a group: the whole group reads the reply, before anyone else has spoken too
  assert.equal(owner(said({ kind: 'plugin:aurabot', speaker: { role: 'owner', chat: 'group' } })), false,
    'the owner speaking first in a group')
  assert.equal(owner(TYPED, said({ kind: 'plugin:aurabot', speaker: { role: 'owner', chat: 'group' } })), false,
    'a group message in the owner\'s own conversation')
  assert.equal(owner(TYPED, said({ kind: 'plugin:aurabot', speaker: { role: 'none', chat: 'group' } })), true,
    'a notice decides nothing, wherever it is posted')
  // a chat that is set but not 'private' is a group's, whatever else the source says
  for (const chat of ['GROUP', null, 0, '', 'channel']) {
    assert.equal(owner(said({ kind: 'plugin:aurabot', speaker: { role: 'owner', chat } })), false,
      `chat: ${JSON.stringify(chat)}`)
  }
  assert.equal(owner(said({ ...TYPED.data.source, speaker: { chat: 'group' } })), false,
    'dsh\'s own owner marks, in a group')
  assert.equal(owner(TYPED, said({ kind: 'plugin:life', speaker: { role: 'none' } })), true)
  assert.equal(owner(said({ kind: 'plugin:life', speaker: { role: 'none' } })), false, 'nobody yet')
  assert.equal(owner(TYPED, said({ kind: 'qq-bridge', speaker: { role: 'none' } })), true)
  // dsh's own producers decide nothing, the two that carry text without an author included
  for (const kind of ['runtime-context', 'skill-invocation', 'compact-checkpoint', 'goal', 'agent-message',
    'session-reference', 'model-selection', 'user-question-reply', 'schedule']) {
    assert.equal(owner(TYPED, said({ kind })), true, kind)
    assert.equal(owner(said({ kind })), false, `${kind} alone`)
  }
  // only the user's messages count: replies and other events are not judged
  assert.equal(owner(TYPED, { type: 'assistant/message', data: { role: 'assistant', source: { kind: 'model' } } },
    { type: 'session/title-llm-request', data: { messages: [{ role: 'user', source: { kind: 'user' } }] } }), true)
})

test('companion mode: a message counts from the moment it is queued, before dsh commits it', () => {
  // dsh computes a step's runtime context before it commits the messages that step
  // delivers; judged on commits alone, a turn went without its own message (dsh 0.2.1-rc.5)
  const project = scratch('companion')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount(COMPANION, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const queued = (...messages) => ({ type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, removedCount: 0, inserted: messages.map((m) => m.data) } })
  const claimed = { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [] } }
  const owner = (...events) => /- first/.test(withDshHome(scratch('home'),
    () => prompt.render(as(sessionOf('s', project, {}, events)))))
  assert.equal(owner(queued(TYPED), claimed), true, 'the user\'s first message, before it is committed')
  assert.equal(owner(TYPED, queued(QQ), claimed), false, 'an outsider\'s first message, before it is committed')
  assert.equal(owner(TYPED, queued(said({ kind: 'time-context' }), TYPED)), true)
  assert.equal(owner(TYPED, { type: 'agent/inbox/spliced', data: { inserted: 'not a list' } }), true)
})

test('companion mode: a message a slash command adds is dsh\'s own, and only while it runs', () => {
  // `/plan <text>` and `/goal` attachments write a bare `user` message between the
  // command's `command/run` and `command/done`; dsh records no one as having run it
  const project = scratch('companion')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount(COMPANION, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const owner = (...events) => /- first/.test(withDshHome(scratch('home'),
    () => prompt.render(as(sessionOf('s', project, {}, events)))))
  const run =(commandId) => ({ type: 'command/run', data: { commandId, name: 'plan', source: { kind: 'user' } } })
  const done = (commandId) => ({ type: 'command/done', data: { commandId, kind: 'success' } })
  const planText = said({ kind: 'user' })
  const queued = { type: 'agent/inbox/spliced', data: { target: 'next-step', start: 0, inserted: [planText.data] } }
  assert.equal(owner(TYPED, run('c-1'), queued, done('c-1'), planText), true, 'queued in the command, committed after it')
  assert.equal(owner(TYPED, run('c-2'), done('c-2'), said({ kind: 'user' })), false, 'after the command: someone else\'s')
  assert.equal(owner(TYPED, run('c-3'), done('c-other'), said({ kind: 'user' })), true, 'still running')
  assert.equal(owner(run('c-4'), queued, done('c-4')), false, 'a command alone makes nobody the owner')
  assert.equal(owner(TYPED, run('c-5'), QQ, done('c-5')), false, 'only bare messages are let through')
  assert.equal(owner(TYPED, run('c-6'), said({ kind: 'user', clientTimeZone: 'UTC' }), done('c-6')), false,
    'only a source that is nothing but the user kind')
  // overlapping commands: one ending does not close the other's window
  assert.equal(owner(TYPED, run('a'), run('b'), done('b'), said({ kind: 'user' }), done('a')), true)
  // a command whose `command/done` was never logged closes its window by itself
  const filler = Array.from({ length: 32 }, () => ({ type: 'step/start', data: {} }))
  assert.equal(owner(TYPED, run('lost'), ...filler, said({ kind: 'user' })), false)
  assert.equal(owner(TYPED, run('slow'), ...filler.slice(0, 30), said({ kind: 'user' }), done('slow')), true)
})

test('companion mode: the speakers unit is one dsh can fold, checkpoint and restore', () => {
  const { projections } = mount(COMPANION)
  const unit = projections.units.get('engramory:speakers')
  assert.ok(unit, 'registered with dsh\'s session projections')
  assert.equal(unit.wire, undefined, 'host-only: nothing of it reaches a client')
  assert.ok(Number.isInteger(unit.stateVersion) && unit.stateVersion >= 0)
  const start = unit.init({}, 0)
  assert.deepEqual(start, { owner: false, other: false })
  // an event that changes nothing returns the same state, as dsh requires
  assert.equal(unit.apply(start, { type: 'assistant/message', data: { role: 'assistant' } }), start)
  const heard = unit.apply(start, TYPED)
  assert.deepEqual(heard, { owner: true, other: false })
  assert.equal(unit.apply(heard, TYPED), heard)
  assert.deepEqual(unit.stateSchema.parse({ owner: true, other: true }), { owner: true, other: true })
  for (const bad of [null, {}, { owner: 'yes', other: false }]) {
    assert.throws(() => unit.stateSchema.parse(bad))
  }
  assert.deepEqual(unit.init({ origin: 'subagent', parentSession: 'p' }, 0), { owner: false, other: false, child: true, from: 0 })
  assert.deepEqual(unit.init({ origin: 'subagent', parentSession: 'p' }, 7), { owner: false, other: false, child: true, from: 7 })
  // every state the fold makes survives a checkpoint, and nothing incoherent is taken back
  const full = { owner: true, other: false, child: true, from: 3, tasked: true, commands: ['c-1'], since: 2, byDsh: ['m-1'] }
  assert.deepEqual(unit.stateSchema.parse(full), full)
  for (const bad of [
    { owner: false, other: false, child: 'yes', from: 0 },
    { owner: false, other: false, child: true }, // no `from`
    { owner: false, other: false, tasked: true }, // a task outside a subagent
    { owner: false, other: false, commands: ['c-1'] }, // no `since`
    { owner: false, other: false, commands: ['c-1'], since: 32 }, // a window already closed
    { owner: false, other: false, byDsh: [] },
    { owner: false, other: false, byDsh: [''] },
    { owner: false, other: false, extra: 1 },
  ]) assert.throws(() => unit.stateSchema.parse(bad), JSON.stringify(bad))
  assert.equal(mount({}).projections.units.size, 0, 'nothing registered with companion mode off')
})

test('companion mode: a stranger\'s conversation cannot read, search or write a store', () => {
  const home = scratch('home')
  const userIndex = store(home, '- [u](u.md) - user\n')
  const project = scratch('companion')
  store(project, '- [p](p.md) - project\n')
  const notes = join(project, 'notes.txt')
  writeFileSync(notes, 'x', 'utf8')
  const { guard } = mount(COMPANION, { workingDirectory: sessionDirs() })
  const call = (session, name, args) =>
    withDshHome(home, () => guard({ name, arguments: args, ...(session ? as(session) : {}) }))
  const stranger = theirs('douyin-1', project)
  const closed = /closed to it/
  assert.match(call(stranger, 'read', { file_path: userIndex }), closed)
  assert.match(call(stranger, 'read', { file_path: join('.engramory-memory', INDEX) }), closed)
  assert.match(call(stranger, 'read_image', { file_path: join(home, '.engramory-memory', 'a.png') }), closed)
  assert.match(call(stranger, 'grep', { pattern: 'x' }), closed, 'the session directory holds a store')
  assert.match(call(stranger, 'glob', { pattern: '**/*.md', path: home }), closed)
  assert.match(call(stranger, 'write', { file_path: join(home, '.engramory-memory', 'x.md'), content: 'x' }), closed)
  assert.match(call(undefined, 'read', { file_path: userIndex }), closed, 'no session: fails closed')
  // a directory may hold a store this filter cannot see: another project's, say
  const other = scratch('other-project')
  store(other, '- [o](o.md) - theirs\n')
  assert.match(call(stranger, 'glob', { pattern: '**/*.md', path: other }), closed)
  assert.match(call(stranger, 'grep', { pattern: 'x', path: scratch('elsewhere') }), closed)
  assert.match(call(stranger, 'str_replace_editor', { command: 'view', path: other }), closed)
  // a stray argument the tool ignores does not stand in for the root it walks
  assert.match(call(stranger, 'grep', { pattern: 'x', file_path: notes }), closed)
  assert.match(call(stranger, 'glob', { pattern: '*', target: notes }), closed)
  // files outside every store stay open to it
  assert.equal(call(stranger, 'read', { file_path: notes }), undefined)
  assert.equal(call(stranger, 'grep', { pattern: 'x', path: notes }), undefined)
  assert.equal(call(stranger, 'todo_write', { todos: [] }), undefined)
  // and the user's own conversations are untouched
  assert.equal(call(own('own-1', project), 'read', { file_path: userIndex }), undefined)
  assert.equal(call(own('code-1', project), 'grep', { pattern: 'x' }), undefined)
})

test('companion mode: a subagent is the user\'s own while its live parent is, read afresh every time', () => {
  const home = scratch('home')
  const userIndex = store(home, '- [u](u.md) - user\n')
  const project = scratch('companion')
  const { guard, mountLate } = mount(COMPANION, { workingDirectory: sessionDirs() })
  const call = (session) =>
    withDshHome(home, () => guard({ name: 'read', arguments: { file_path: userIndex }, ...as(session) }))
  const parents = { 'own-1': { session: own('own-1', project) }, 'douyin-2': { session: theirs('douyin-2', project) } }
  // the task a parent agent hands its child is a bare `user` message, then agent messages
  const task = said({ kind: 'user' })
  const kid = (id, parentSession, ...more) => sessionOf(id, project, { origin: 'subagent', parentSession },
    [task, said({ kind: 'agent-message' }), ...more])
  assert.match(call(kid('kid-0', 'own-1')), /closed to it/, 'no agent registry: fails closed')
  mountLate('agents', { get: (id) => parents[id] })
  assert.equal(call(kid('kid-1', 'own-1')), undefined)
  assert.match(call(kid('kid-2', 'douyin-2')), /closed to it/)
  assert.match(call(kid('kid-3', 'gone')), /closed to it/, 'a parent that is not live: fails closed')
  // the parent's state is read on every call, never remembered: an outsider queued into
  // the parent closes the child at once, before the parent takes another step
  const child = kid('kid-4', 'own-1')
  assert.equal(call(child), undefined)
  parents['own-1'].session.events.push(QQ)
  assert.match(call(child), /closed to it/)
  // someone else writing to a child directly closes it, whatever its parent; the user
  // continuing it in dsh's window does not
  parents['own-9'] = { session: own('own-9', project) }
  assert.match(call(kid('kid-5', 'own-9', said({ kind: 'user', rpcId: 'r-9' }))), /closed to it/)
  assert.match(call(kid('kid-6', 'own-9', QQ)), /closed to it/)
  assert.equal(call(kid('kid-7', 'own-9', TYPED)), undefined)
  // only the first bare `user` message is the parent's task, seen queued and then committed
  // under one id; a second one is someone else's (a plugin writing to the child)
  const queuedTask = { type: 'agent/inbox/spliced', data: { target: 'next-turn', start: 0, inserted: [task.data] } }
  assert.equal(call(sessionOf('kid-8', project, { origin: 'subagent', parentSession: 'own-9' }, [queuedTask, task])), undefined)
  assert.match(call(kid('kid-9', 'own-9', said({ kind: 'user' }))), /closed to it/)
  // a fork-backed child inherits its parent's history, the parent's own task included: those
  // events are the parent's, so the child's own task is still its first
  const inherited = [task, said({ kind: 'agent-message' }), TYPED].map((e, seq) => ({ ...e, seq }))
  const forked = sessionOf('kid-11', project, { origin: 'subagent', parentSession: 'own-9' },
    [...inherited, { ...said({ kind: 'user' }), seq: 3 }])
  forked.inherited = 3
  assert.equal(call(forked), undefined)
  // a subagent with no parent named is not anyone's child: fails closed
  assert.match(call(sessionOf('kid-10', project, { origin: 'subagent' }, [TYPED])), /closed to it/)
  // outside a subagent's log, a bare `user` message is someone else's (dsh headless)
  assert.match(call(sessionOf('headless-1', project, {}, [task, TYPED])), /closed to it/)
  // a fork names a parent too, but is a conversation of its own, judged by its own log
  assert.match(call(sessionOf('fork-1', project, { parentSession: 'own-9' }, [TYPED, QQ])), /closed to it/)
  assert.equal(call(sessionOf('fork-2', project, { parentSession: 'douyin-2' }, [TYPED])), undefined)
})

test('companion mode: a stranger cannot reach a store by another spelling, or plant one', () => {
  const home = scratch('home')
  store(home, '- [u](u.md) - user\n')
  const project = scratch('companion') // no store here yet
  const elsewhere = scratch('elsewhere')
  const { guard } = mount(COMPANION, { workingDirectory: sessionDirs() })
  const stranger = theirs('douyin-9', project)
  const call = (name, args) => withDshHome(home, () => guard({ name, arguments: args, ...as(stranger) }))
  const closed = /closed to it/
  assert.match(call('write', { file_path: join('.engramory-memory', INDEX), content: '- planted\n' }), closed)
  assert.match(call('write', { file_path: join(elsewhere, '.engramory-memory', 'x.md'), content: 'x' }), closed)
  assert.match(call('read', { file_path: join(home, '.ENGRAMORY-MEMORY', INDEX) }), closed)
  assert.match(call('glob', { pattern: '*', path: join(home, '.Engramory-Memory') }), closed)
  assert.equal(call('write', { file_path: join(project, 'notes.md'), content: 'x' }), undefined)
})

test('companion mode: a global index that is a link closes the folder it points to', (t) => {
  // recall reads the global index through the link, so its target is the user's index too
  const home = scratch('home')
  const vault = scratch('vault')
  const target = join(vault, 'index.md')
  writeFileSync(target, '- [u](u.md) - user\n', 'utf8')
  mkdirSync(join(home, '.engramory-memory'), { recursive: true })
  if (fileLink(target, join(home, '.engramory-memory', INDEX)) === null) {
    return t.skip('no symlink privilege here')
  }
  const { guard } = mount(COMPANION, { workingDirectory: sessionDirs() })
  const stranger = theirs('douyin-10', scratch('companion'))
  const call = (name, args) => withDshHome(home, () => guard({ name, arguments: args, ...as(stranger) }))
  assert.match(call('read', { file_path: target }), /closed to it/)
  assert.match(call('write', { file_path: join(vault, 'other.md'), content: 'x' }), /closed to it/)
})

test('companion mode fails closed without a projection registry, or when it refuses or fails', () => {
  const home = scratch('home')
  const userIndex = store(home, '- [u](u.md) - user\n')
  const project = scratch('companion')
  const read = { name: 'read', arguments: { file_path: userIndex } }
  const closed = (guard) => withDshHome(home, () => guard({ ...read, ...as(own('own-1', project)) }))
  assert.match(closed(mount(COMPANION, { workingDirectory: sessionDirs(), projections: false }).guard),
    /closed to it/, 'no registry')
  // dsh keeps an earlier registrant of the key when it refuses this one, and still answers for it
  const refusing = { register: () => { throw new Error('incompatible stateVersion') }, stateOf: () => ({ owner: true, other: false }) }
  assert.match(closed(mount(COMPANION, { workingDirectory: sessionDirs(), projections: refusing }).guard),
    /closed to it/, 'a registry that refuses the unit')
  const failing = { register: () => () => {}, stateOf: () => { throw new Error('fold failed') } }
  assert.match(closed(mount(COMPANION, { workingDirectory: sessionDirs(), projections: failing }).guard),
    /closed to it/, 'a fold that throws')
  const odd = { register: () => () => {}, stateOf: () => ({ owner: true, other: 'no' }) }
  assert.match(closed(mount(COMPANION, { workingDirectory: sessionDirs(), projections: odd }).guard),
    /closed to it/, 'a state that is not one of this unit')
  // a registry that mounts late is picked up
  const late = mount(COMPANION, { workingDirectory: sessionDirs(), projections: false })
  late.mountLate('sessionProjections', projectionRegistry())
  assert.equal(closed(late.guard), undefined)
  const throwing = { ...read }
  Object.defineProperty(throwing, 'agent', { get() { throw new Error('gone') } })
  assert.match(withDshHome(home, () => late.guard(throwing)), /closed to it/)
})

test('companion mode: a stranger\'s path is bounded before it is resolved', () => {
  const home = scratch('home')
  store(home, '- [u](u.md) - user\n')
  const project = scratch('companion')
  const { guard } = mount(COMPANION, { workingDirectory: sessionDirs() })
  const deep = join(project, ...Array.from({ length: 100 }, (_, i) => `d${i}`), 'x.md')
  const call = (session) => withDshHome(home, () =>
    guard({ name: 'read', arguments: { file_path: deep }, ...as(session) }))
  assert.match(call(theirs('douyin-5', project)), /closed to it/)
  assert.equal(call(own('own-1', project)), undefined)
  // a network path could stall the stat on the host's main thread: refused untouched
  for (const unc of ['\\\\no-such-host.invalid\\share\\x.md', '//no-such-host.invalid/share/x.md']) {
    const started = Date.now()
    assert.match(withDshHome(home, () => guard({ name: 'read', arguments: { file_path: unc },
      ...as(theirs('douyin-5', project)) })), /closed to it/)
    assert.ok(Date.now() - started < 500, `${unc} was refused before any I/O`)
  }
})

test('companion mode: a store relocated through a junction is closed at its target too', () => {
  const home = scratch('home')
  const vault = scratch('vault')
  writeFileSync(join(vault, INDEX), '- [u](u.md) - user\n', 'utf8')
  symlinkSync(vault, join(home, '.engramory-memory'), 'junction') // a directory link anywhere
  const project = scratch('companion')
  const { guard } = mount(COMPANION, { workingDirectory: sessionDirs() })
  const call = (session) => withDshHome(home, () =>
    guard({ name: 'read', arguments: { file_path: join(vault, INDEX) }, ...as(session) }))
  assert.match(call(theirs('douyin-10', project)), /closed to it/)
  assert.equal(call(own('own-1', project)), undefined)
})

test('companion mode: a store linked to a place that is not there yet cannot be planted there', () => {
  const home = scratch('home')
  const vault = join(scratch('drive'), 'vault') // e.g. a drive not mounted right now
  symlinkSync(vault, join(home, '.engramory-memory'), 'junction')
  const { guard } = mount(COMPANION, { workingDirectory: sessionDirs() })
  const reason = withDshHome(home, () => guard({ name: 'write',
    arguments: { file_path: join(vault, INDEX), content: '- planted\n' },
    ...as(theirs('douyin-12', scratch('companion'))) }))
  assert.match(reason, /closed to it/)
})

test('companion mode: a network $DSH_HOME is not walked for a stranger, only refused', (t) => {
  // `\\host\share` names a network share only on Windows; elsewhere it is a relative path
  if (process.platform !== 'win32') return t.skip('UNC paths are a Windows notion')
  const { guard } = mount(COMPANION, { workingDirectory: sessionDirs() })
  const started = Date.now()
  const reason = withDshHome('\\\\no-such-host.invalid\\share\\.dsh', () => guard({ name: 'read',
    arguments: { file_path: join(scratch('x'), 'a.md') },
    ...as(theirs('douyin-13', scratch('companion'))) }))
  assert.match(reason, /closed to it/)
  assert.ok(Date.now() - started < 500)
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

test('companion mode: a link inside the pinned directory is closed by the name it is called by', (t) => {
  const pins = scratch('pins')
  writeFileSync(join(pins, 'pinned.md'), '- x\n', 'utf8')
  const outside = scratch('outside')
  writeFileSync(join(outside, 'private.md'), 'secret\n', 'utf8')
  if (fileLink(join(outside, 'private.md'), join(pins, 'link.md')) === null) {
    return t.skip('no symlink privilege here')
  }
  const { guard } = mount({ ...COMPANION, indexPath: join(pins, 'pinned.md') }, { workingDirectory: sessionDirs() })
  const reason = withDshHome(scratch('home'), () => guard({ name: 'read', arguments: { file_path: join(pins, 'link.md') },
    ...as(theirs('douyin-11', scratch('companion'))) }))
  assert.match(reason, /closed to it/)
})

test('companion mode: a store reached by its 8.3 short name is still the store', (t) => {
  if (process.platform !== 'win32') return t.skip('8.3 names are a Windows thing')
  const home = scratch('home')
  const userIndex = store(home, '- [u](u.md) - user\n')
  const r = spawnSync('cmd', ['/d', '/c', `for %I in ("${join(home, '.engramory-memory')}") do @echo %~sI`],
    { encoding: 'utf8' })
  const short = (r.stdout || '').trim()
  if (!short || /\.engramory-memory$/i.test(short)) return t.skip('no 8.3 names on this volume')
  const { guard } = mount(COMPANION, { workingDirectory: sessionDirs() })
  const reason = withDshHome(home, () => guard({ name: 'read', arguments: { file_path: join(short, INDEX) },
    ...as(theirs('douyin-6', scratch('companion'))) }))
  assert.match(reason, /closed to it/, `short name ${short} for ${userIndex}`)
})

test('companion mode: a pinned index that is a link guards the directory it points into', (t) => {
  const real = scratch('real')
  const target = join(real, 'notes.md')
  writeFileSync(target, '- x\n', 'utf8')
  const pins = scratch('pins')
  if (fileLink(target, join(pins, 'pinned.md')) === null) return t.skip('no symlink privilege here')
  const { guard } = mount({ ...COMPANION, indexPath: join(pins, 'pinned.md') }, { workingDirectory: sessionDirs() })
  const reason = withDshHome(scratch('home'), () => guard({ name: 'read', arguments: { file_path: join(real, 'other.md') },
    ...as(theirs('douyin-7', scratch('companion'))) }))
  assert.match(reason, /closed to it/)
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

test('companion mode keeps its notes with injectIndex: false, which only drops the index', () => {
  const project = scratch('companion')
  store(project, '- [a](a.md) - first\n')
  const prompt = promptRegistry()
  mount({ ...COMPANION, injectIndex: false, language: 'zh' },
    { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const see = (session) => withDshHome(scratch('home'), () => prompt.render(as(session)))
  const mine = see(own('own-1', project))
  // where the store is (the skill names none in social mode), then the rules, no index
  assert.match(mine, /^Engramory：你的记忆库在 `[^`]+\.engramory-memory`[^\n]*\n\n大肥鱼模式已打开。你在这里为用户扮演角色时/)
  assert.doesNotMatch(mine, /first/)
  assert.match(see(theirs('douyin-3', project)), /不是用户本人的/)
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

test('a profile editor that comes up after the plugin still sets the language, skill and index alike', () => {
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
    assert.match(withDshHome(home, () => prompt.render(at(project))), /^项目记忆索引/)
    m.mountLate('configEditor', { entries: () => [
      { options: { id: 'locale', name: '@deepseek-ai/dsh-client-locale', config: { preference: 'en' } } },
    ] })
    assert.equal(m.skills.length, 1, 'registered again, not twice')
    assert.ok(m.skills[0].content.startsWith('# Engramory — curated file-based memory'))
    const text = withDshHome(home, () => prompt.render(at(project)))
    assert.match(text, /^Project memory index/)
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


test('companion context is required, so a persona preset with optional context off keeps it', () => {
  // dsh-persona `includeRuntimeContext: false` (the shipped `minimal` preset) drops
  // optional contexts; seen on a real dsh, the owner then got no memory at all
  const project = scratch('companion')
  store(project, '- [birthday](birthday.md) - May 3\n')
  const prompt = promptRegistry()
  mount(COMPANION, { workingDirectory: sessionDirs(), systemPrompt: prompt })
  const off = (session) => withDshHome(scratch('home'),
    () => prompt.render(as(session), { optionalOff: true }))
  const owner = off(own('own-1', project))
  assert.match(owner, /- \[birthday\]\(birthday\.md\) - May 3/)
  assert.match(owner, /Companion mode \(大肥鱼模式\)/)
  assert.match(off(theirs('douyin-1', project)), /not the user's own/)
  assert.deepEqual(prompt.contexts.map((c) => [c.name, c.required === true]), [['engramory:memory', true]])

  // companion mode, private, makes it required too; without companion mode the index stays
  // optional, as every preset expects — `audience: social` alone changes nothing
  const one = promptRegistry()
  mount({ companion: true }, { workingDirectory: sessionDirs(), systemPrompt: one })
  assert.deepEqual(one.contexts.map((c) => [c.name, c.required === true]), [['engramory:memory', true]])
  for (const config of [{}, { audience: 'social' }]) {
    const plain = promptRegistry()
    mount(config, { workingDirectory: sessionDirs(), systemPrompt: plain })
    assert.deepEqual(plain.contexts.map((c) => [c.name, 'required' in c]), [['engramory:memory-index', false]])
  }
})

test('memory access is a choice inside companion mode: private by default, social only with companion mode on', () => {
  const project = scratch('companion')
  store(project, '- [a](a.md) - first\n')
  const home = scratch('home')
  const userIndex = store(home, '- [u](u.md) - user\n')
  const view = (config) => {
    const prompt = promptRegistry()
    const { guard, projections } = mount(config, { workingDirectory: sessionDirs(), systemPrompt: prompt })
    return {
      text: (session) => withDshHome(home, () => prompt.render(as(session))),
      read: (session) => withDshHome(home, () => guard({ name: 'read', arguments: { file_path: userIndex }, ...as(session) })),
      units: projections.units.size,
    }
  }
  // companion mode, private: every conversation is the user's — a bridge's too
  const solo = view({ companion: true })
  for (const session of [own('own-1', project), theirs('qq-1', project), sessionOf('sched', project, {}, [said({ kind: 'schedule' })])]) {
    assert.match(solo.text(session), /- first[\s\S]*Companion mode \(大肥鱼模式\) is on/)
    assert.equal(solo.read(session), undefined)
  }
  assert.equal(solo.units, 0, 'private: nothing folds who wrote what')
  // social without companion mode changes nothing: the plain index, for everyone
  const alone = view({ audience: 'social' })
  assert.match(alone.text(theirs('qq-1', project)), /- first/)
  assert.doesNotMatch(alone.text(own('own-1', project)), /Companion mode|not the user's own/)
  assert.equal(alone.read(theirs('qq-1', project)), undefined)
  assert.equal(alone.units, 0)
  // social inside companion mode: the user's own get the memory and the rules, others the note
  const social = view({ companion: true, audience: 'social' })
  assert.match(social.text(own('own-1', project)), /- first[\s\S]*Companion mode/)
  assert.match(social.text(theirs('qq-1', project)), /not the user's own/)
  assert.match(social.read(theirs('qq-1', project)), /closed to it/)
  assert.equal(social.units, 1)
  // only 'social' is social; anything else is the private default
  for (const audience of ['Social', 'public', true, 1]) {
    assert.equal(view({ companion: true, audience }).read(theirs('qq-1', project)), undefined, String(audience))
  }
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
  revision, companion: true, audience: 'social', maxLines: 200, maxBytes: 25600, ...patch,
})

test('settings routes: none without a web server, one exact route for both methods with it', () => {
  const headless = mount({})
  assert.ok(headless.guard) // a headless dsh mounts the cap as before
  const { routes } = webMount({})
  // the memory page's route comes with it, from the same row
  assert.deepEqual(routes.map((r) => [r.path, r.methods.join(), r.requestBody]),
    [['/api/engramory/settings', 'GET,POST', 'buffered'], ['/api/engramory/memory', 'GET,POST', 'buffered']])
})

test('settings GET: the row settings as the plugin reads them, and whether a save can land', async () => {
  const { call } = webMount({}, {
    rowConfig: { indexName: 'MEMORY.md', language: 'zh-CN', companion: true, audience: 'social', maxLines: 0 },
    // the language follows dsh: the page neither shows nor writes it
  })
  const { status, body } = await call('GET')
  assert.equal(status, 200)
  const shown = { companion: true, audience: 'social', maxLines: 200, maxBytes: 25600 }
  assert.deepEqual(body, { ...shown, revision: JSON.stringify(shown), editable: true })
  // only `true` is companion mode on, and only 'social' is social, as apply() reads them
  const other = (await webMount({}, { rowConfig: { companion: 'yes', audience: 'public' } }).call('GET')).body
  assert.equal(other.companion, false)
  assert.equal(other.audience, 'private')
})

test('settings route: served by the bundle\'s own row, never by a second row of the package', () => {
  assert.equal(webMount({}, { rowId: 'engramory' }).routes.length, 2) // settings and memory
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
  for (const key of ['companion', 'audience', 'maxLines']) {
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
  await inheritedExpr.call('POST', saveBody(shown.revision, { companion: false, audience: 'private' }))
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
        edits.push(change({ ...BUNDLE_ROW, audience: { __jsExpr: "'social'" } }, structuredClone(BUNDLE_ROW)))
      },
    }),
  })
  const { body: shown } = await w.call('GET')
  assert.deepEqual(await w.call('POST', saveBody(shown.revision, { companion: false, audience: 'private' })),
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
    companion: true, audience: 'social',
  })
  // back to the defaults: a field the page does not edit (indexPath) keeps the override
  const { body: again } = await w.call('GET')
  await w.call('POST', saveBody(again.revision, { companion: false, audience: 'private' }))
  assert.deepEqual(w.edits.at(-1), { indexName: 'MEMORY.md', indexPath: '/pinned/MEMORY.md', injectIndex: false })
})

test('settings POST back to the defaults on a bundle-only row hands back the inherited config, dropping the override', async () => {
  const w = webMount({}, { rowConfig: { ...BUNDLE_ROW } })
  const { body: shown } = await w.call('GET')
  await w.call('POST', saveBody(shown.revision))
  assert.deepEqual(w.edits.at(-1), { indexName: 'MEMORY.md', companion: true, audience: 'social' })
  const { body: again } = await w.call('GET')
  await w.call('POST', saveBody(again.revision, { companion: false, audience: 'private' }))
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
    [{ audience: 'public' }, 'audience'],
    [{ audience: undefined }, 'audience'],
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
  assert.deepEqual(s.notes, [{ name: 'a.md', type: 'project' }])
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
      assert.deepEqual([status, reply], [200, { ok: true }], JSON.stringify(body))
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

test('memory POST: a pinned index of any name opens by that name, and only from the store itself', async () => {
  const dir = realpathSync.native(scratch('mem-pinname'))
  writeFileSync(join(dir, 'INDEX'), '- one\n', 'utf8')
  mkdirSync(join(dir, 'archive'))
  writeFileSync(join(dir, 'archive', 'INDEX'), '- old\n', 'utf8')
  const m = memoryMount({ indexPath: join(dir, 'INDEX') }, { opener: true })
  assert.deepEqual((await m.call('POST', { store: 'pinned', file: 'INDEX' })).body, { ok: true })
  assert.deepEqual(m.opened, [{ path: join(dir, 'INDEX') }])
  assert.equal((await m.call('POST', { store: 'pinned', file: 'INDEX', archive: true })).status, 404)
  if (process.platform === 'win32') {
    // a case-insensitive disk finds it under any case, and the opener gets its real name
    assert.equal((await m.call('POST', { store: 'pinned', file: 'index' })).status, 200)
    assert.deepEqual(m.opened.at(-1), { path: join(dir, 'INDEX') })
  }
})

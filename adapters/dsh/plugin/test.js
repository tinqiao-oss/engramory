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
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'

import { apply, inject, name } from './index.js'

function mount(config = {}, { withSkills = true, workingDirectory } = {}) {
  let guard
  const skills = []
  const skillRegistry = { register: (skill) => { skills.push(skill); return () => {} } }
  const services = {
    tools: { guard: (fn) => { guard = fn; return () => {} } },
    ...(withSkills ? { skills: skillRegistry } : {}),
    ...(workingDirectory ? { workingDirectory } : {}),
  }
  // Mirrors Cordis' reflective context (issue #8): only services named in the
  // caller's inject are readable as properties — anything else throws and must go
  // through ctx.get() (undefined when absent) or a reactive ctx.inject() child whose
  // callback waits for the service. A regression to a bare top-level `ctx.skills`
  // read fails every test in this file, not just a real dsh boot.
  const pending = []
  const makeCtx = (declared) => new Proxy({}, {
    get(_, prop) {
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
  return { guard, skills, mountSkillsLate, mountLate }
}

/** dsh 0.2's per-session directory owner: `get(session)` is its synchronous read. */
const sessionDirs = () => ({ get: (session) => session.cwd })

const INDEX = 'MEMORY.md'
const big = (lines) => Array.from({ length: lines }, (_, i) => `- line ${i}`).join('\n')

function write(file_path, content) {
  return { name: 'write', arguments: { file_path, content } }
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
    arguments: { file_path: path, old_str: `HEAD\n${big(220)}`, new_str: big(150) },
  }
  assert.equal(guard(shrink), undefined, 'a compacting edit must pass while over')
  const grow = {
    name: 'edit',
    arguments: { file_path: path, old_str: 'HEAD', new_str: big(30) },
  }
  assert.match(guard(grow), /lines > 200/, 'an edit growing an over-cap index must be refused')
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
  const insert = {
    name: 'str_replace_editor',
    arguments: { command: 'insert', path, insert_line: 1, new_str: 'x' },
  }
  assert.equal(guard(insert), undefined, 'a healthy index must stay editable')
  writeFileSync(path, big(300), 'utf8')
  const reason = guard(insert)
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

test('an empty or non-string indexName falls back instead of disabling the guard', () => {
  assert.match(mount({ indexName: '' }).guard(write(`/s/${INDEX}`, big(300))), /300 lines/)
  assert.match(mount({ indexName: 42 }).guard(write(`/s/${INDEX}`, big(300))), /300 lines/)
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

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
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'

import { apply, inject, name } from './index.js'

function mount(config = {}, { withSkills = true } = {}) {
  let guard
  const skills = []
  const skillRegistry = { register: (skill) => { skills.push(skill); return () => {} } }
  const services = {
    tools: { guard: (fn) => { guard = fn; return () => {} } },
    ...(withSkills ? { skills: skillRegistry } : {}),
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
  // Simulates a skill registry whose fiber only activates after this plugin's did —
  // fiber order between unrelated providers is not guaranteed on a real boot.
  const mountSkillsLate = () => {
    services.skills = skillRegistry
    for (let i = pending.length - 1; i >= 0; i--) {
      if (pending[i]()) pending.splice(i, 1)
    }
  }
  return { guard, skills, mountSkillsLate }
}

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

test('a pinned index under a symlinked ancestor keeps its identity once created', () => {
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
    return // no symlink privilege here; the assertions below need a real link
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
  assert.match(skill.content, /type: user \| feedback \| project \| reference/)
  assert.match(skill.content, /How to apply/)
  assert.match(skill.content, /settled facts/)
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

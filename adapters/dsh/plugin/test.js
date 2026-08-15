/**
 * node --test adapters/dsh/plugin
 *
 * Covers the guard's decision table directly. The guard is the whole point of this
 * plugin — a wrong `undefined` silently drops the cap, and a wrong refusal blocks
 * unrelated work — so every branch is pinned here rather than left to an end-to-end
 * run that dsh's preview packaging cannot currently support (see README).
 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { apply, inject, name } from './index.js'

function mount(config = {}, { withSkills = true } = {}) {
  let guard
  const skills = []
  const ctx = {
    tools: { guard: (fn) => { guard = fn; return () => {} } },
    ...(withSkills
      ? { skills: { register: (skill) => { skills.push(skill); return () => {} } } }
      : {}),
  }
  apply(ctx, config)
  return { guard, skills }
}

const INDEX = 'MEMORY.md'
const big = (lines) => Array.from({ length: lines }, (_, i) => `- line ${i}`).join('\n')

function write(file_path, content) {
  return { name: 'write', arguments: { file_path, content } }
}

test('plugin metadata is what the loader expects', () => {
  assert.equal(name, 'engramory')
  assert.deepEqual(inject.required, ['tools'])
  assert.ok(inject.optional.includes('skills'))
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

test('a partial write is refused only when the index is ALREADY over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'engramory-dsh-'))
  const path = join(dir, INDEX)
  const edit = { name: 'edit', arguments: { file_path: path, old_str: 'a', new_str: 'b' } }
  const { guard } = mount()

  writeFileSync(path, big(10), 'utf8')
  assert.equal(guard(edit), undefined, 'a healthy index must stay editable')

  writeFileSync(path, big(300), 'utf8')
  assert.match(guard(edit), /already over/, 'growing an over-cap index must be refused')
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

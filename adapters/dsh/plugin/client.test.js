/**
 * node --test adapters/dsh/plugin — the browser half (client.js).
 *
 * A component that throws blanks its slot entry in dsh with nothing but a console line,
 * so the settings page is rendered here against a small stand-in for React (state,
 * refs, callbacks and effects, enough for this page) and driven the way a user would:
 * load, tick, switch, save. The registration it makes is checked against what the
 * Plugins page looks for. What it looks like is checked in a real dsh, not here.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = readFileSync(join(HERE, 'client.js'), 'utf8')

/** A synchronous React stand-in: hooks keyed by component path, re-render on demand. */
function miniReact() {
  const stores = new Map()
  let current
  let effects = []
  let dirty = false
  const hook = (init) => {
    const slot = current.index++
    if (!(slot in current.hooks)) current.hooks[slot] = init()
    return [current.hooks, slot]
  }
  const same = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const React = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() } }),
    useState(initial) {
      const [hooks, slot] = hook(() => ({ value: typeof initial === 'function' ? initial() : initial }))
      const cell = hooks[slot]
      cell.set ??= (v) => { cell.value = typeof v === 'function' ? v(cell.value) : v; dirty = true }
      return [cell.value, cell.set]
    },
    useRef(initial) {
      const [hooks, slot] = hook(() => ({ current: initial }))
      return hooks[slot]
    },
    useCallback(fn, deps) {
      const [hooks, slot] = hook(() => ({}))
      const cell = hooks[slot]
      if (!same(cell.deps, deps)) { cell.fn = fn; cell.deps = deps }
      return cell.fn
    },
    useEffect(fn, deps) {
      const [hooks, slot] = hook(() => ({}))
      const cell = hooks[slot]
      if (!same(cell.deps, deps)) { cell.deps = deps; effects.push(fn) }
    },
  }
  const render = (node, path) => {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map((child, i) => render(child, `${path}/${child?.props?.key ?? i}`))
    if (typeof node.type === 'function') {
      const id = `${path}:${node.type.name}`
      const store = stores.get(id) ?? { hooks: [] }
      stores.set(id, store)
      const outer = current
      current = { hooks: store.hooks, index: 0 }
      const out = node.type(node.props)
      current = outer
      return render(out, id)
    }
    const children = node.props.children.map((child, i) => render(child, `${path}/${node.type}${child?.props?.key ?? i}`))
    return { type: node.type, props: node.props, children }
  }
  return {
    React,
    mount(element) {
      let tree
      const draw = () => {
        dirty = false
        tree = render(element, 'root')
        const run = effects
        effects = []
        for (const fn of run) fn()
      }
      draw()
      return {
        get tree() { return tree },
        /** Let pending fetches resolve and re-render until the page is still. */
        async settle() {
          for (let i = 0; i < 50; i++) {
            await new Promise((resolve) => setImmediate(resolve))
            if (dirty || effects.length) draw()
          }
        },
      }
    },
  }
}

const textOf = (node) => (node === null ? '' : typeof node === 'string' ? node
  : Array.isArray(node) ? node.map(textOf).join('') : textOf(node.children))
const findAll = (node, pred, out = []) => {
  if (Array.isArray(node)) for (const child of node) findAll(child, pred, out)
  else if (node && typeof node === 'object') {
    if (pred(node)) out.push(node)
    findAll(node.children, pred, out)
  }
  return out
}
const button = (tree, label) => findAll(tree, (n) => n.type === 'button' && textOf(n) === label)[0]
const switchFor = (tree, title) => findAll(tree, (n) => n.props.role === 'switch' && n.props['aria-label'].endsWith(title))[0]

/** Load client.js as dsh would, and return what its factory registers. */
async function loadClient() {
  let registered
  globalThis.window = { __ModuleLoader__: { load: (spec) => { registered = spec } } }
  await import(`${pathToFileURL(join(HERE, 'client.js')).href}?${Math.random()}`)
  const react = miniReact()
  const mod = registered.factory((name) => {
    if (name === 'react') return react.React
    throw new Error(`unexpected require ${name}`)
  })
  return { registered, mod, react }
}

/** Apply the client with the page services, capturing the slot registration. */
async function applied({ sessions } = {}) {
  const { registered, mod, react } = await loadClient()
  const dictionaries = {}
  const slots = []
  const styles = []
  globalThis.document = {
    createElement: () => { const tag = { dataset: {}, remove: () => styles.splice(styles.indexOf(tag), 1) }; return tag },
    head: { appendChild: (tag) => styles.push(tag) },
  }
  const ctx = {
    effect: (fn) => fn(),
    get: (name) => (name === 'sessions' ? sessions : undefined),
    locale: { register: (ns, dicts) => { dictionaries[ns] = dicts; return () => {} } },
    slots: {
      inject: (owner, fn) => { assert.equal(owner, 'plugins.row.config'); fn() },
      register: (options, component) => { slots.push({ options, component }); return () => {} },
    },
  }
  mod.apply(ctx)
  return { registered, mod, react, dictionaries, slots, styles }
}

const settingsData = (patch = {}) => ({
  language: 'en', companionPresets: ['whale'], ownerSessions: ['wx-*', 'gone-1'],
  maxLines: 200, maxBytes: 25600, editable: true,
  presets: [{ id: 'default' }, { id: 'whale', name: '大肥鱼' }],
  sessions: [
    { id: 'own-1', preset: 'whale', createdAt: 2 },
    { id: 'wx-9', preset: 'whale', createdAt: 1 },
    { id: 'code-1', preset: 'default', createdAt: 3 },
  ],
  ...patch,
  revision: 'r1',
})

/** A fetch that answers the settings routes from `responses`, recording what was sent. */
function fakeFetch(responses) {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url, method: init.method ?? 'GET', body: init.body && JSON.parse(init.body) })
    const next = responses[init.method ?? 'GET']
    const value = typeof next === 'function' ? next(sent) : next
    return { ok: value.status === undefined || value.status < 400, status: value.status ?? 200, json: async () => value.body ?? value }
  }
  return sent
}

test('client: registers as the package, on the Plugins page row, with matching dictionaries', async () => {
  const { registered, mod, dictionaries, slots, styles } = await applied()
  assert.equal(registered.id, 'dsh-engramory')
  assert.deepEqual(mod.inject, ['slots', 'locale'])
  assert.equal(slots.length, 1)
  assert.equal(slots[0].options.name, 'plugins.row.config')
  // the Plugins page keys a row's page by `<package>#<row id>`; the row id is the patch's
  const patch = readFileSync(join(HERE, 'cordis.patch.yml'), 'utf8')
  const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
  assert.match(patch, /- id: engramory\b/)
  assert.equal(slots[0].options.key, `${pkg.name}#engramory`)
  assert.equal(slots[0].options.locale, 'engramory')
  assert.equal(styles.length, 1)
  const { zh, en } = dictionaries.engramory
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  // every key the page asks for exists in both languages
  const used = new Set([...SOURCE.matchAll(/\bt\('([A-Za-z]+)'\)/g)].map((m) => m[1]))
  for (const key of used) assert.ok(key in zh && key in en, key)
})

test('client: the summary view is one line, and the page reads the settings route relative to itself', async () => {
  const { slots } = await applied()
  const { component } = slots[0]
  assert.equal(component({ view: 'summary', t: (k) => `<${k}>` }), '<summary>')
  const sent = fakeFetch({ GET: settingsData() })
  const { react, slots: again } = await applied()
  const page = react.mount(react.React.createElement(again[0].component, { view: 'page', t: (k) => k, titles: () => new Map() }))
  assert.match(textOf(page.tree), /loading/)
  await page.settle()
  assert.equal(sent[0].url, 'api/engramory/settings')
})

test('client: lists the companion conversations, marks prefix matches, and saves what the user switched', async () => {
  const sessions = { list: { getSnapshot: () => ({ byId: { 'own-1': { title: '我和大肥鱼', updatedAt: 50 } } }) } }
  const { slots, react } = await applied({ sessions })
  const sent = fakeFetch({
    GET: (log) => (log.some((s) => s.method === 'POST')
      ? settingsData({ ownerSessions: ['wx-*', 'gone-1', 'own-1'], language: 'zh' })
      : settingsData()),
    POST: { ok: true },
  })
  const realTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn) => realTimeout(fn, 0)
  try {
    const titles = () => new Map([['own-1', { title: '我和大肥鱼', updatedAt: 50 }]])
    const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k, titles }))
    await page.settle()
    const text = textOf(page.tree)
    assert.match(text, /我和大肥鱼/) // the session's own title, not its id
    assert.doesNotMatch(text, /code-1/) // not a companion preset
    assert.match(text, /gone-1/) // a listed id with no conversation stays visible and removable
    const prefixed = switchFor(page.tree, 'wx-9')
    assert.equal(prefixed.props['aria-checked'], true)
    assert.equal(prefixed.props.disabled, true) // owned by the prefix, not by this switch
    assert.equal(button(page.tree, 'save').props.disabled, true) // nothing changed yet
    switchFor(page.tree, '我和大肥鱼').props.onClick()
    await page.settle()
    button(page.tree, 'languageZh').props.onClick()
    await page.settle()
    button(page.tree, 'save').props.onClick()
    // the page polls until the reloaded plugin answers with the saved settings
    for (let i = 0; i < 20 && !/\bsaved\b/.test(textOf(page.tree)); i++) await page.settle()
    const post = sent.find((s) => s.method === 'POST')
    assert.deepEqual(post.body, {
      revision: 'r1', language: 'zh', companionPresets: ['whale'],
      ownerSessions: ['wx-*', 'gone-1', 'own-1'], maxLines: 200, maxBytes: 25600,
    })
    assert.match(textOf(page.tree), /saved/)
  } finally {
    globalThis.setTimeout = realTimeout
  }
})

test('client: a stale save reloads the settings and says so; a read-only dsh offers no save', async () => {
  const { slots, react } = await applied()
  fakeFetch({ GET: settingsData(), POST: { status: 409, body: { ok: false, error: 'stale' } } })
  const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k, titles: () => new Map() }))
  await page.settle()
  button(page.tree, 'languageZh').props.onClick()
  await page.settle()
  button(page.tree, 'save').props.onClick()
  await page.settle()
  assert.match(textOf(page.tree), /stale/)

  const second = await applied()
  fakeFetch({ GET: settingsData({ editable: false }) })
  const readOnly = second.react.mount(second.react.React.createElement(second.slots[0].component,
    { view: 'page', t: (k) => k, titles: () => new Map() }))
  await readOnly.settle()
  assert.match(textOf(readOnly.tree), /unavailable/)
  assert.equal(button(readOnly.tree, 'save'), undefined)
})

test('client: a save whose settings never read back says so, and the form is usable again', async () => {
  const { slots, react } = await applied()
  // the host keeps answering with the old settings (normalised differently, or not reloaded)
  fakeFetch({ GET: settingsData(), POST: { ok: true } })
  const realTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn) => realTimeout(fn, 0)
  try {
    const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k, titles: () => new Map() }))
    await page.settle()
    button(page.tree, 'languageZh').props.onClick()
    await page.settle()
    button(page.tree, 'save').props.onClick()
    for (let i = 0; i < 300 && !/savedUnconfirmed/.test(textOf(page.tree)); i++) {
      await new Promise((resolve) => realTimeout(resolve, 2)) // let the 20 polls' timers fire
      await page.settle()
    }
    assert.match(textOf(page.tree), /savedUnconfirmed/)
    assert.doesNotMatch(textOf(page.tree), /saving/) // not stuck busy
  } finally {
    globalThis.setTimeout = realTimeout
  }
})

test('client: a save that fails on the network leaves the form usable', async () => {
  const { slots, react } = await applied()
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') throw new Error('socket hang up')
    return { ok: true, status: 200, json: async () => settingsData() }
  }
  const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k, titles: () => new Map() }))
  await page.settle()
  button(page.tree, 'languageZh').props.onClick()
  await page.settle()
  button(page.tree, 'save').props.onClick()
  await page.settle()
  assert.match(textOf(page.tree), /failedsocket hang up/)
  assert.equal(button(page.tree, 'save').props.disabled, false)
})

test('client: a response whose body stalls is cut off by the deadline, not waited on forever', async () => {
  const { slots, react } = await applied()
  // headers arrive, the body never does — until the request's signal aborts it
  globalThis.fetch = async (url, init = {}) => ({
    ok: true, status: 200,
    json: () => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }),
  })
  const realTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn) => realTimeout(fn, 0)
  try {
    const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k, titles: () => new Map() }))
    for (let i = 0; i < 20 && !/loadFailed/.test(textOf(page.tree)); i++) {
      await new Promise((resolve) => realTimeout(resolve, 2))
      await page.settle()
    }
    assert.match(textOf(page.tree), /loadFailed/)
  } finally {
    globalThis.setTimeout = realTimeout
  }
})

test('client: a read-only page names why', async () => {
  const { slots, react } = await applied()
  fakeFetch({ GET: settingsData({ editable: false, readOnly: 'expression' }) })
  const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k, titles: () => new Map() }))
  await page.settle()
  assert.match(textOf(page.tree), /expression/)
  assert.equal(button(page.tree, 'save'), undefined)
})

test('client: an index cap that is not a positive whole number blocks the save', async () => {
  const { slots, react } = await applied()
  fakeFetch({ GET: settingsData() })
  const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k, titles: () => new Map() }))
  await page.settle()
  const lines = findAll(page.tree, (n) => n.type === 'input' && n.props.inputMode === 'numeric')[0]
  lines.props.onChange({ target: { value: '12.5' } })
  await page.settle()
  assert.equal(button(page.tree, 'save').props.disabled, true)
  lines.props.onChange({ target: { value: '150' } })
  await page.settle()
  assert.equal(button(page.tree, 'save').props.disabled, false)
})

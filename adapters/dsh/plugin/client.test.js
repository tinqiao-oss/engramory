/**
 * node --test adapters/dsh/plugin — the browser half (client.js).
 *
 * A component that throws blanks its slot entry in dsh with nothing but a console line,
 * so the settings page is rendered here against a small stand-in for React (state,
 * refs, callbacks and effects, enough for this page) and driven the way a user would:
 * load, switch, save. The registration it makes is checked against what the
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
const switchFor = (tree, label) => findAll(tree, (n) => n.props.role === 'switch' && n.props['aria-label'] === label)[0]

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

/** Apply the client with the page services, capturing the slot registrations. */
async function applied() {
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
    get: () => undefined,
    locale: {
      register: (ns, dicts) => { dictionaries[ns] = dicts; return () => {} },
      bind: (ns) => (key) => dictionaries[ns].zh[key],
    },
    slots: {
      // each registration is made inside the inject of the slot it fills
      inject: (owner, fn) => { const before = slots.length; fn(); assert.equal(slots[before].options.name, owner) },
      register: (options, component) => { slots.push({ options, component }); return () => {} },
    },
  }
  mod.apply(ctx)
  const page = slots.find((s) => s.options.name === 'main')
  return { registered, mod, react, dictionaries, slots, styles, page }
}

const settingsData = (patch = {}) => ({
  companion: false, audience: 'private', maxLines: 200, maxBytes: 25600, editable: true,
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

test('client: registers the package\'s page, the sidebar entry and its page, with matching dictionaries', async () => {
  const { registered, mod, dictionaries, slots, styles } = await applied()
  assert.equal(registered.id, 'dsh-engramory')
  assert.deepEqual(mod.inject, ['slots', 'locale'])
  assert.deepEqual(slots.map((s) => s.options.name), ['plugins.bundle.config', 'main', 'sidebar.panellist'])
  const [settings, page, entry] = slots
  // the Plugins page shows a package's own settings above its rows, keyed by package name
  const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'))
  assert.equal(settings.options.key, pkg.name)
  // the sidebar entry opens the main-column page of the same id, after dsh's own entries
  assert.equal(page.options.key, 'engramory')
  assert.equal(entry.options.id, 'engramory')
  assert.equal(entry.options.order, 20)
  for (const { options } of slots) assert.equal(options.locale, 'engramory')
  assert.equal(entry.options.label(), '记忆') // read when shown, so it follows the language
  // the icon draws at the size the row asks for, in the row's own colour
  const icon = entry.component({ size: 18, active: false })
  assert.deepEqual([icon.type, icon.props.width, icon.props.height, icon.props.stroke], ['svg', 18, 18, 'currentColor'])
  assert.equal(styles.length, 1)
  const { zh, en } = dictionaries.engramory
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort())
  // every key the pages ask for exists in both languages, with the same placeholders
  const used = new Set([...SOURCE.matchAll(/\bt\('([A-Za-z]+)'[,)]/g)].map((m) => m[1]))
  for (const type of ['User', 'Feedback', 'Project', 'Reference', 'Moment', 'Upcoming', 'Self', 'Other']) used.add(`type${type}`)
  // the listing's failures and the opener's, looked up by name
  for (const key of ['listFailed', 'listTimeout', 'openUnavailable', 'openMissing', 'openBusy']) used.add(key)
  for (const key of used) assert.ok(key in zh && key in en, key)
  const holes = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join()
  for (const key of Object.keys(zh)) assert.equal(holes(zh[key]), holes(en[key]), key)
})

test('client: the summary view is one line, and the page reads the settings route relative to itself', async () => {
  const { slots } = await applied()
  const { component } = slots[0]
  assert.equal(component({ view: 'summary', t: (k) => `<${k}>` }), '<summary>')
  const sent = fakeFetch({ GET: settingsData() })
  const { react, slots: again } = await applied()
  const page = react.mount(react.React.createElement(again[0].component, { view: 'page', t: (k) => k }))
  assert.match(textOf(page.tree), /loading/)
  await page.settle()
  assert.equal(sent[0].url, 'api/engramory/settings')
})

test('client: switches companion mode on, chooses social, and saves exactly the settings the host edits', async () => {
  const { slots, react } = await applied()
  const sent = fakeFetch({
    GET: (log) => (log.some((s) => s.method === 'POST')
      ? settingsData({ companion: true, audience: 'social' })
      : settingsData()),
    POST: { ok: true },
  })
  const realTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn) => realTimeout(fn, 0)
  try {
    const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k }))
    await page.settle()
    // memory access is a choice inside companion mode, shown only while it is on
    assert.match(textOf(page.tree), /companionHint/)
    assert.equal(button(page.tree, 'audiencePrivate'), undefined)
    const companion = switchFor(page.tree, 'companion')
    assert.equal(companion.props['aria-checked'], false)
    assert.equal(button(page.tree, 'save').props.disabled, true) // nothing changed yet
    companion.props.onClick()
    await page.settle()
    assert.equal(switchFor(page.tree, 'companion').props['aria-checked'], true)
    assert.match(textOf(page.tree), /audiencePrivateHint/)
    // private or social: one choice of two, its line says what it means
    assert.equal(button(page.tree, 'audiencePrivate').props['aria-pressed'], true)
    button(page.tree, 'audienceSocial').props.onClick()
    await page.settle()
    assert.equal(button(page.tree, 'audienceSocial').props['aria-pressed'], true)
    assert.equal(button(page.tree, 'audiencePrivate').props['aria-pressed'], false)
    assert.match(textOf(page.tree), /audienceSocialHint/)
    assert.doesNotMatch(textOf(page.tree), /audiencePrivateHint/)
    button(page.tree, 'save').props.onClick()
    // the page polls until the reloaded plugin answers with the saved settings
    for (let i = 0; i < 20 && !/\bsaved\b/.test(textOf(page.tree)); i++) await page.settle()
    const post = sent.find((s) => s.method === 'POST')
    assert.deepEqual(post.body,
      { revision: 'r1', companion: true, audience: 'social', maxLines: 200, maxBytes: 25600 })
    assert.match(textOf(page.tree), /saved/)
  } finally {
    globalThis.setTimeout = realTimeout
  }
})

test('client: a stale save reloads the settings and says so; a read-only dsh offers no save', async () => {
  const { slots, react } = await applied()
  fakeFetch({ GET: settingsData(), POST: { status: 409, body: { ok: false, error: 'stale' } } })
  const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k }))
  await page.settle()
  switchFor(page.tree, 'companion').props.onClick()
  await page.settle()
  button(page.tree, 'save').props.onClick()
  await page.settle()
  assert.match(textOf(page.tree), /stale/)

  const second = await applied()
  fakeFetch({ GET: settingsData({ editable: false }) })
  const readOnly = second.react.mount(second.react.React.createElement(second.slots[0].component,
    { view: 'page', t: (k) => k }))
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
    const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k }))
    await page.settle()
    switchFor(page.tree, 'companion').props.onClick()
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
  const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k }))
  await page.settle()
  switchFor(page.tree, 'companion').props.onClick()
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
    const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k }))
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
  const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k }))
  await page.settle()
  assert.match(textOf(page.tree), /expression/)
  assert.equal(button(page.tree, 'save'), undefined)

  // an expression written while the page was open: the save is refused, the page reads
  // the profile again and becomes read-only
  const second = await applied()
  fakeFetch({
    GET: (log) => (log.some((s) => s.method === 'POST')
      ? settingsData({ editable: false, readOnly: 'expression' })
      : settingsData()),
    POST: { status: 409, body: { ok: false, error: 'expression' } },
  })
  const open = second.react.mount(second.react.React.createElement(second.slots[0].component, { view: 'page', t: (k) => k }))
  await open.settle()
  switchFor(open.tree, 'companion').props.onClick()
  await open.settle()
  button(open.tree, 'save').props.onClick()
  await open.settle()
  assert.match(textOf(open.tree), /expression/)
  assert.equal(button(open.tree, 'save'), undefined)
})

test('client: an index cap that is not a positive whole number blocks the save', async () => {
  const { slots, react } = await applied()
  fakeFetch({ GET: settingsData() })
  const page = react.mount(react.React.createElement(slots[0].component, { view: 'page', t: (k) => k }))
  await page.settle()
  const lines = findAll(page.tree, (n) => n.type === 'input' && n.props.inputMode === 'numeric')[0]
  lines.props.onChange({ target: { value: '12.5' } })
  await page.settle()
  assert.equal(button(page.tree, 'save').props.disabled, true)
  lines.props.onChange({ target: { value: '150' } })
  await page.settle()
  assert.equal(button(page.tree, 'save').props.disabled, false)
})

// --- the sidebar's memory page ---

const SETTINGS = 'api/engramory/settings'
const MEMORY = 'api/engramory/memory'

/** A fetch that answers `"METHOD url"` from `routes`, recording what was sent. */
function routeFetch(routes) {
  const sent = []
  globalThis.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    sent.push({ url, method, body: init.body && JSON.parse(init.body) })
    const next = routes[`${method} ${url}`]
    if (next === undefined) throw new Error(`no route ${method} ${url}`)
    const value = typeof next === 'function' ? next(sent) : next
    return { ok: value.status === undefined || value.status < 400, status: value.status ?? 200, json: async () => value.body ?? value }
  }
  return sent
}

const memoryData = (patch = {}) => ({
  stores: [{
    id: 'user', kind: 'user', dir: 'C:\\Users\\u\\.dsh\\.engramory-memory', titles: [],
    index: { name: 'MEMORY.md', bytes: 2048, lines: 12, over: false },
    notes: [{ name: 'b-note.md', type: 'feedback' }, { name: 'a-note.md', type: 'feedback' },
      { name: 'who.md', type: 'user' }, { name: 'odd.md', type: 'other' }],
    archive: ['moments-2026-09.md'], more: false,
  }, {
    id: 'ws:w1', kind: 'project', dir: 'E:\\repo\\.engramory-memory', titles: ['repo', 'src'],
    index: { name: 'MEMORY.md', bytes: 30000, over: true }, notes: [], archive: [], more: true,
  }],
  cap: { maxLines: 200, maxBytes: 25600 }, more: false, canOpen: true,
  ...patch,
})

/** `t` that shows a key with its parameters, so the page's arithmetic can be read back. */
const tp = (key, params) => (params === undefined ? key : `${key}${JSON.stringify(params)}`)
const nameButton = (tree, label) => findAll(tree, (n) => n.type === 'button' && n.props.className === 'eng-name' && textOf(n) === label)[0]
/** The texts of the elements of `className` — a note, the strip's line — one string each. */
const textsOf = (tree, className) => findAll(tree, (n) => n.props.className === className).map(textOf)

/** `t` over the page's own Chinese dictionary, placeholders filled, as dsh's locale does. */
const zhOf = (dictionaries) => (key, params) =>
  dictionaries.engramory.zh[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name]))

async function memoryPage(routes, { zh = false } = {}) {
  const { page, react, dictionaries } = await applied()
  const sent = routeFetch({ [`GET ${SETTINGS}`]: settingsData(), [`GET ${MEMORY}`]: memoryData(), ...routes })
  const view = react.mount(react.React.createElement(page.component, { t: zh ? zhOf(dictionaries) : tp }))
  return { view, sent, zh: dictionaries.engramory.zh }
}

test('client: the memory page lists each store by name, by type, with its index against the cap', async () => {
  const { view, zh } = await memoryPage({}, { zh: true })
  assert.match(textOf(view.tree), new RegExp(zh.listing))
  await view.settle()
  const text = textOf(view.tree)
  for (const shown of [zh.memoryIntro, zh.storeUser, 'repo · src', '12 / 200 行 · 2.0 KB / 25.0 KB',
    '29.3 KB / 25.0 KB，超出上限', '归档（1）', zh.stripNote]) {
    assert.ok(text.includes(shown), shown)
  }
  assert.deepEqual(textsOf(view.tree, 'eng-note'), [zh.overHint, zh.more]) // the project store's two
  // names only, without .md, sorted, under their types in the protocol's order
  const groups = findAll(view.tree, (n) => n.type === 'h3' && n.props.className === 'eng-group-title').map(textOf)
  assert.deepEqual(groups, ['用户 · 1', '反馈 · 2', '其他 · 1'])
  const names = findAll(view.tree, (n) => n.type === 'button' && n.props.className === 'eng-name').map(textOf)
  assert.deepEqual(names, ['who', 'a-note', 'b-note', 'odd', 'moments-2026-09'])
  // the two settings that matter most are at its top; their explanations are not
  assert.ok(switchFor(view.tree, zh.companion))
  for (const hidden of [zh.companionHint, zh.capHint]) assert.ok(!text.includes(hidden), hidden)
})

test('client: an index read only in part is over the cap only when its bytes are', async () => {
  const big = { name: 'MEMORY.md', bytes: 20000000, over: false } // past recall's read, under a huge cap
  const store = { ...memoryData().stores[0], index: big }
  const { view } = await memoryPage({
    [`GET ${MEMORY}`]: memoryData({ stores: [store], cap: { maxLines: 200, maxBytes: 100000000 } }),
  }, { zh: true })
  await view.settle()
  const text = textOf(view.tree)
  assert.ok(text.includes('19531.3 KB / 97656.3 KB'), text)
  assert.ok(!text.includes('超出上限'))
})

test('client: a name opens its note through the memory route — and the index, the folder, an archived note', async () => {
  const { view, sent } = await memoryPage({ [`POST ${MEMORY}`]: { ok: true } })
  await view.settle()
  const posted = async (click) => {
    click()
    await view.settle()
    return sent.filter((s) => s.method === 'POST').at(-1)
  }
  assert.deepEqual(await posted(() => nameButton(view.tree, 'who').props.onClick()),
    { url: MEMORY, method: 'POST', body: { store: 'user', file: 'who.md' } })
  assert.match(textOf(view.tree), /opened\{"name":"who"\}/)
  assert.deepEqual((await posted(() => nameButton(view.tree, 'moments-2026-09').props.onClick())).body,
    { store: 'user', file: 'moments-2026-09.md', archive: true })
  assert.deepEqual((await posted(() => button(view.tree, 'openIndex').props.onClick())).body,
    { store: 'user', file: 'MEMORY.md' })
  assert.deepEqual((await posted(() => button(view.tree, 'openFolder').props.onClick())).body, { store: 'user' })
})

test('client: the check-up lists the index\'s pointers to nothing as text and the notes out of it to open', async () => {
  const store = {
    ...memoryData().stores[0],
    health: { checked: true, broken: ['gone.md', 'archive/lost.md'], brokenMore: false, unindexed: ['b-note.md'] },
  }
  const { view, sent, zh } = await memoryPage({
    [`GET ${MEMORY}`]: memoryData({ stores: [store] }), [`POST ${MEMORY}`]: { ok: true },
  }, { zh: true })
  await view.settle()
  const [health] = findAll(view.tree, (n) => n.props.className === 'eng-health')
  const text = textOf(health)
  for (const shown of ['体检', '索引里指向不存在的文件（2）', 'gone.md', 'archive/lost.md', '不在索引里（1）',
    '没写类型或类型不认识（1）', zh.healthFix]) {
    assert.ok(text.includes(shown), shown)
  }
  // a pointer to nothing is not a button; a note out of the index opens as any note does
  assert.equal(findAll(health, (n) => n.type === 'button' && textOf(n) === 'gone.md').length, 0)
  findAll(health, (n) => n.type === 'button' && textOf(n) === 'b-note')[0].props.onClick()
  await view.settle()
  assert.deepEqual(sent.filter((s) => s.method === 'POST').at(-1).body, { store: 'user', file: 'b-note.md' })
})

test('client: a clean check-up is one line; one not run says why, except past the cap, said already', async () => {
  const clean = { ...memoryData().stores[0], notes: [{ name: 'who.md', type: 'user' }],
    health: { checked: true, broken: [], brokenMore: false, unindexed: [] } }
  const over = { ...memoryData().stores[1], health: { checked: false, reason: 'over' } }
  const partial = { ...memoryData().stores[0], id: 'pinned', kind: 'pinned', health: { checked: false, reason: 'partial' } }
  const unreadable = { ...memoryData().stores[0], id: 'ws:w2', kind: 'project', titles: ['b'],
    health: { checked: false, reason: 'unreadable' } }
  const large = { ...unreadable, id: 'ws:w3', health: { checked: false, reason: 'large' } }
  const { view, zh } = await memoryPage({
    [`GET ${MEMORY}`]: memoryData({ stores: [clean, over, partial, unreadable, large] }),
  }, { zh: true })
  await view.settle()
  assert.deepEqual(textsOf(view.tree, 'eng-note'),
    [zh.healthOk, zh.overHint, zh.more, zh.healthPartial, zh.healthUnreadable, zh.healthLarge])
  assert.equal(findAll(view.tree, (n) => n.props.className === 'eng-health').length, 0)
  const many = { ...clean, health: { checked: true, broken: ['x.md'], brokenMore: true, unindexed: [] } }
  const more = await memoryPage({ [`GET ${MEMORY}`]: memoryData({ stores: [many] }) }, { zh: true })
  await more.view.settle()
  assert.ok(textOf(more.view.tree).includes('索引里指向不存在的文件（1 个以上）'))
  // the listing's share of them spent elsewhere: none listed here, and still no clean bill
  const unlisted = { ...clean, health: { checked: true, broken: [], brokenMore: true, unindexed: [] } }
  const none = await memoryPage({ [`GET ${MEMORY}`]: memoryData({ stores: [unlisted] }) }, { zh: true })
  await none.view.settle()
  const text = textOf(none.view.tree)
  assert.ok(text.includes(none.zh.healthBrokenUnlisted) && !text.includes(none.zh.healthOk), text)
})

test('client: a store with no index offers its notes but no index or folder to open', async () => {
  const store = { ...memoryData().stores[0], index: null }
  const { view } = await memoryPage({ [`GET ${MEMORY}`]: memoryData({ stores: [store] }) })
  await view.settle()
  assert.match(textOf(view.tree), /noIndex/)
  assert.equal(button(view.tree, 'openIndex'), undefined)
  assert.equal(button(view.tree, 'openFolder'), undefined)
  assert.ok(nameButton(view.tree, 'who'))
})

test('client: a note that will not open says why', async () => {
  for (const [reply, said] of [
    [{ status: 404, body: { ok: false, error: 'missing' } }, /openMissing/],
    [{ status: 409, body: { ok: false, error: 'unavailable' } }, /openUnavailable/],
    [{ status: 502, body: { ok: false, error: 'failed', message: 'no handler' } }, /openFailed\{"reason":"no handler"\}/],
    [{ status: 503, body: { ok: false, error: 'timeout' } }, /listTimeout/],
    [{ status: 409, body: { ok: false, error: 'busy' } }, /openBusy/],
    [{ status: 400, body: { ok: false, error: 'constructor' } }, /openFailed\{"reason":"constructor"\}/],
    [{ status: 500, body: 'not json' }, /openFailed/],
  ]) {
    const { view } = await memoryPage({ [`POST ${MEMORY}`]: reply })
    await view.settle()
    nameButton(view.tree, 'who').props.onClick()
    await view.settle()
    assert.match(textOf(view.tree), said)
  }
})

test('client: where dsh cannot open files, the names are text and the page says where they are', async () => {
  const { view } = await memoryPage({ [`GET ${MEMORY}`]: memoryData({ canOpen: false }) })
  await view.settle()
  assert.equal(findAll(view.tree, (n) => n.type === 'button' && n.props.className === 'eng-name').length, 0)
  assert.equal(findAll(view.tree, (n) => n.type === 'span' && n.props.className === 'eng-name').length, 5)
  assert.equal(button(view.tree, 'openIndex'), undefined)
  assert.equal(button(view.tree, 'openFolder'), undefined)
  const text = textOf(view.tree)
  assert.match(text, /memoryIntroNoOpen/)
  assert.match(text, /openUnavailable/)
  assert.match(text, /E:\\repo\\\.engramory-memory/)
})

test('client: the memory page says what it could not list, and lists again on refresh', async () => {
  for (const [reply, said] of [
    [{ status: 503, body: { error: 'timeout' } }, ['listTimeout']],
    [{ status: 500, body: {} }, ['listFailed']],
    [memoryData({ stores: [] }), ['empty']],
    [memoryData({ stores: [], pinned: 'relative' }), ['pinnedRelative']],
  ]) {
    const { view } = await memoryPage({ [`GET ${MEMORY}`]: reply })
    await view.settle()
    assert.deepEqual([...textsOf(view.tree, 'eng-banner'), ...textsOf(view.tree, 'eng-note')], said)
  }
  let calls = 0
  const { view, sent } = await memoryPage({
    [`GET ${MEMORY}`]: () => (++calls === 1 ? { status: 500, body: {} } : memoryData()),
  })
  await view.settle()
  assert.match(textOf(view.tree), /listFailed/)
  button(view.tree, 'refresh').props.onClick()
  await view.settle()
  assert.match(textOf(view.tree), /storeUser/)
  assert.equal(sent.filter((s) => s.url === MEMORY).length, 2)
})

test('client: a listing a refresh overtook is dropped', async () => {
  const { page, react } = await applied()
  const replies = []
  globalThis.fetch = async (url) => {
    if (url === SETTINGS) return { ok: true, status: 200, json: async () => settingsData() }
    return new Promise((resolve) => replies.push(resolve))
  }
  const view = react.mount(react.React.createElement(page.component, { t: tp }))
  await view.settle()
  button(view.tree, 'refresh').props.onClick()
  await view.settle()
  assert.equal(replies.length, 2)
  const answer = (data) => ({ ok: true, status: 200, json: async () => data })
  replies[1](answer(memoryData({ stores: [] })))
  await view.settle()
  replies[0](answer(memoryData())) // the first request, answering last
  await view.settle()
  assert.deepEqual(textsOf(view.tree, 'eng-note'), ['empty'])
  assert.doesNotMatch(textOf(view.tree), /storeUser/)
})

test('client: the switches atop the memory page save as they are switched, with what they do not show', async () => {
  const realTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn) => realTimeout(fn, 0)
  try {
    let current = settingsData({ maxLines: 150 })
    const { view, sent } = await memoryPage({
      [`GET ${SETTINGS}`]: () => current,
      [`POST ${SETTINGS}`]: (log) => { current = settingsData({ ...log.at(-1).body }); return { ok: true } },
    })
    await view.settle()
    assert.equal(button(view.tree, 'audienceSocial'), undefined) // a choice inside companion mode
    const saved = async () => {
      for (let i = 0; i < 40 && textsOf(view.tree, 'eng-strip-note')[0] !== 'saved'; i++) await view.settle()
      assert.deepEqual(textsOf(view.tree, 'eng-strip-note'), ['saved'])
    }
    const posts = () => sent.filter((s) => s.method === 'POST').map((s) => s.body)
    switchFor(view.tree, 'companion').props.onClick()
    switchFor(view.tree, 'companion').props.onClick() // a second click before the page re-renders
    await saved()
    assert.deepEqual(posts(), [{ revision: 'r1', companion: true, audience: 'private', maxLines: 150, maxBytes: 25600 }])
    assert.equal(switchFor(view.tree, 'companion').props['aria-checked'], true)
    button(view.tree, 'audienceSocial').props.onClick()
    await view.settle() // the line shows the save under way, then that it is done
    await saved()
    assert.deepEqual(posts()[1], { revision: 'r1', companion: true, audience: 'social', maxLines: 150, maxBytes: 25600 })
    assert.equal(button(view.tree, 'audienceSocial').props['aria-pressed'], true)
    // choosing what is already chosen saves nothing
    button(view.tree, 'audienceSocial').props.onClick()
    await view.settle()
    assert.equal(posts().length, 2)
  } finally {
    globalThis.setTimeout = realTimeout
  }

  // where the page cannot save, the switches are there but cannot be switched
  const { view } = await memoryPage({ [`GET ${SETTINGS}`]: settingsData({ editable: false }) })
  await view.settle()
  assert.equal(switchFor(view.tree, 'companion').props.disabled, true)
  assert.match(textOf(view.tree), /stripReadOnly/)
})

test('client: settings that could not be read are offered again, not hidden', async () => {
  let reads = 0
  const { view } = await memoryPage({
    [`GET ${SETTINGS}`]: () => (++reads === 1 ? { status: 500, body: {} } : settingsData()),
  })
  await view.settle()
  assert.deepEqual(textsOf(view.tree, 'eng-strip-note'), ['loadFailed'])
  assert.equal(switchFor(view.tree, 'companion'), undefined)
  button(view.tree, 'retry').props.onClick()
  await view.settle()
  assert.ok(switchFor(view.tree, 'companion'))
  assert.match(textOf(view.tree), /storeUser/) // the listing was there all along
})

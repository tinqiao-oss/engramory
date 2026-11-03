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
/** A note's row by the name it shows: the button that opens it. */
const nameButton = (tree, label) => findAll(tree, (n) => n.type === 'button' && n.props.className === 'eng-row' &&
  textOf(findAll(n, (m) => m.props.className === 'eng-name')[0]) === label)[0]
/** Every row as [type, name, meta, badges], in the page's order. */
const rowsOf = (tree) => findAll(tree, (n) => n.props.className === 'eng-row').map((row) => [row.props['data-type'],
  textOf(findAll(row, (n) => n.props.className === 'eng-name')[0]),
  textOf(findAll(row, (n) => n.props.className === 'eng-row-meta')[0]),
  findAll(row, (n) => n.props.className === 'eng-badge').map(textOf)])
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

test('client: the memory page lists each store and its notes, a row each by type, with its index against the cap', async () => {
  const { view, zh } = await memoryPage({}, { zh: true })
  assert.match(textOf(view.tree), new RegExp(zh.listing))
  await view.settle()
  const text = textOf(view.tree)
  for (const shown of [zh.panelTitle, zh.storeUser, 'repo · src', '索引 12 / 200 行 · 2.0 KB / 25.0 KB',
    '索引 29.3 KB / 25.0 KB，超出上限', '归档 1 份', zh.stripNote]) {
    assert.ok(text.includes(shown), shown)
  }
  // the project store: over its cap, said among what to tidy up; its listing cut short
  assert.ok(textsOf(view.tree, 'eng-attn-item').includes(zh.overHint))
  assert.deepEqual(textsOf(view.tree, 'eng-note'), [zh.more])
  // a row each: names without .md, in the protocol's order of types, then by name; the archive last
  assert.deepEqual(rowsOf(view.tree).map(([type, name, meta]) => [type, name, meta]), [
    ['user', 'who', '用户'], ['feedback', 'a-note', '反馈'], ['feedback', 'b-note', '反馈'], ['other', 'odd', '其他'],
    ['archive', 'moments-2026-09', zh.archived]])
  // the banner's numbers, and a tab for each type there is, counting what is listed
  assert.deepEqual(textsOf(view.tree, 'eng-stat'), ['4条记忆', '2个记忆库', '1份归档'])
  assert.deepEqual(textsOf(view.tree, 'eng-tab'), ['全部4', '用户1', '反馈2', '其他1'])
  // the two settings that matter most are in the banner; their explanations are not
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

test('client: what the check-up found is there to tidy up: pointers to nothing as text, a note out of the index marked on its row', async () => {
  const store = {
    ...memoryData().stores[0],
    health: { checked: true, broken: ['gone.md', 'archive/lost.md'], brokenMore: false, unindexed: ['b-note.md'] },
  }
  const { view, sent, zh } = await memoryPage({
    [`GET ${MEMORY}`]: memoryData({ stores: [store] }), [`POST ${MEMORY}`]: { ok: true },
  }, { zh: true })
  await view.settle()
  const [found] = findAll(view.tree, (n) => n.props.className === 'eng-attn')
  const text = textOf(found)
  for (const shown of [zh.attnTitle, '索引里指向不存在的文件（2）', 'gone.md', 'archive/lost.md', '不在索引里（1）',
    '没写类型或类型不认识（1）', zh.healthFix, zh.tidyCopy]) {
    assert.ok(text.includes(shown), shown)
  }
  // a heading, and the pointers to nothing a list of text, not of buttons
  assert.deepEqual(findAll(found, (n) => n.type === 'h3').map(textOf), [zh.attnTitle])
  assert.deepEqual(findAll(found, (n) => n.type === 'li').map(textOf), ['gone.md', 'archive/lost.md'])
  assert.equal(findAll(view.tree, (n) => n.type === 'button' && textOf(n).includes('gone')).length, 0)
  // the store's one tidy-up button is with the findings, not also among its actions
  assert.equal(findAll(view.tree, (n) => n.type === 'button' && textOf(n) === zh.tidyCopy).length, 1)
  // the note out of the index is marked on its row, which opens as any note does
  assert.deepEqual(rowsOf(view.tree).filter(([, , , badges]) => badges.length > 0).map(([, name, , badges]) => [name, badges]),
    [['b-note', [zh.badgeUnindexed]]])
  nameButton(view.tree, 'b-note').props.onClick()
  await view.settle()
  assert.deepEqual(sent.filter((s) => s.method === 'POST').at(-1).body, { store: 'user', file: 'b-note.md' })
  assert.equal(textsOf(view.tree, 'eng-store-ok').length, 0)
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
  assert.deepEqual(textsOf(view.tree, 'eng-store-ok'), [zh.healthOk])
  assert.deepEqual(textsOf(view.tree, 'eng-note'), [zh.more, zh.healthPartial, zh.healthUnreadable, zh.healthLarge])
  // past the cap: one finding, that it is over
  const found = findAll(view.tree, (n) => n.props.className === 'eng-attn')
  assert.equal(found.length, 1)
  assert.ok(textOf(found[0]).includes(zh.overHint))
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

/** Run `fn` with `navigator` standing in for the page's (Node has one of its own, read-only). */
async function withNavigator(value, fn) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
  try {
    return await fn()
  } finally {
    if (saved) Object.defineProperty(globalThis, 'navigator', saved)
    else delete globalThis.navigator
  }
}

test('client: the memory page\'s how-to is open only while there is no memory', async () => {
  const { view, zh } = await memoryPage({}, { zh: true })
  const howTo = () => findAll(view.tree, (n) => n.type === 'details' && n.props.className === 'eng-howto')[0]
  assert.equal(howTo().props.open, false) // still listing: nothing to say yet
  await view.settle()
  assert.equal(howTo().props.open, false)
  assert.equal(textOf(findAll(howTo(), (n) => n.type === 'summary')[0]), zh.howTo)
  assert.deepEqual(findAll(howTo(), (n) => n.type === 'li').map(textOf),
    [zh.howToSay, zh.howToRecall, zh.howToEdit, zh.howToMove, zh.howToSocial])
  const openFor = async (stores) => {
    const page = await memoryPage({ [`GET ${MEMORY}`]: memoryData({ stores }) }, { zh: true })
    await page.view.settle()
    return findAll(page.view.tree, (n) => n.type === 'details' && n.props.className === 'eng-howto')[0].props.open
  }
  const bare = { id: 'user', kind: 'user', dir: 'C:\\m', titles: [], index: null, notes: [], archive: [], more: false }
  assert.equal(await openFor([]), true) // no store yet
  // a pinned index on a relative path is not listed, nor are stores past the listing's cap:
  // there may well be memory, so no unfolding
  for (const patch of [{ stores: [], pinned: 'relative' }, { stores: [], more: true }]) {
    const page = await memoryPage({ [`GET ${MEMORY}`]: memoryData(patch) }, { zh: true })
    await page.view.settle()
    assert.equal(findAll(page.view.tree, (n) => n.type === 'details' && n.props.className === 'eng-howto')[0].props.open,
      false, JSON.stringify(patch))
  }
  assert.equal(await openFor([bare]), true) // a folder alone: nothing in it yet
  assert.equal(await openFor([{ ...bare, index: { name: 'MEMORY.md', bytes: 0, lines: 0, over: false } }]), true) // an empty index
  assert.equal(await openFor([{ ...bare, index: { name: 'MEMORY.md', bytes: 40, lines: 1, over: false } }]), false)
  assert.equal(await openFor([{ ...bare, notes: [{ name: 'a.md', type: 'user' }] }]), false)
  assert.equal(await openFor([{ ...bare, archive: ['old.md'] }]), false)
  // a store found but not read to its end may hold memory: no telling, so no unfolding
  assert.equal(await openFor([{ ...bare, health: { checked: false, reason: 'unreadable' } }]), false)
  assert.equal(await openFor([{ ...bare, more: true }]), false)
})

test('client: the memory page ends with where to send feedback: an issue that names the version, or the mailbox', async () => {
  const version = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version
  const copied = []
  await withNavigator({ platform: 'Win32', clipboard: { writeText: async (text) => { copied.push(text) } } }, async () => {
    const { view, zh } = await memoryPage({}, { zh: true })
    await view.settle()
    const [link] = findAll(view.tree, (n) => n.type === 'a')
    assert.equal(textOf(link), zh.feedbackIssue)
    // a web link the browser opens — the desktop app hands it to the system's — in a new tab
    assert.equal(link.props.target, '_blank')
    assert.equal(link.props.rel, 'noopener noreferrer')
    const url = new URL(link.props.href)
    assert.equal(`${url.origin}${url.pathname}`, 'https://github.com/tinqiao-oss/engramory/issues/new')
    assert.deepEqual([...url.searchParams.keys()], ['body'])
    // an issue is public: its body is the template, the version and the OS family, exactly —
    // none of the page's folders or notes
    assert.equal(url.searchParams.get('body'),
      zh.issueBody.replace('{version}', version).replace('{os}', 'Windows'))
    const text = textOf(view.tree)
    assert.ok(text.includes('engramory@agent.qq.com'))
    assert.ok(text.includes(zh.feedbackNote))
    assert.ok(text.includes(zh.versionLine.replace('{version}', version)))
    button(view.tree, zh.copy).props.onClick()
    await view.settle()
    assert.deepEqual(copied, ['engramory@agent.qq.com'])
    assert.ok(button(view.tree, zh.copied))
    assert.ok(!textOf(view.tree).includes(zh.copyFailed))
  })
  // no clipboard (a page over plain http), or the copy refused: say to select it by hand
  for (const navigator of [{ platform: 'MacIntel' }, { platform: 'MacIntel', clipboard: { writeText: async () => { throw new Error('denied') } } }]) {
    await withNavigator(navigator, async () => {
      const { view, zh } = await memoryPage({}, { zh: true })
      await view.settle()
      button(view.tree, zh.copy).props.onClick()
      await view.settle()
      assert.ok(textOf(view.tree).includes(zh.copyFailed))
      assert.ok(button(view.tree, zh.copy), 'the button still offers to copy')
    })
  }
})

test('client: the feedback issue names only the version and the OS family, whatever the browser reports', async () => {
  const version = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version
  for (const [navigator, os] of [
    [{ userAgentData: { platform: 'Windows' }, platform: 'Linux x86_64' }, 'Windows'], // the newer field first
    [{ platform: 'MacIntel' }, 'macOS'],
    [{ platform: 'Linux x86_64' }, 'Linux'],
    [{ platform: String.raw`C:\Users\alice\notes.md` }, 'unknown'],
    [{ userAgentData: { platform: '/home/alice/private-note.md' } }, 'unknown'],
    [{}, 'unknown'],
  ]) {
    await withNavigator(navigator, async () => {
      // the parameters the template gets, read back exactly: nothing else goes in
      const { view } = await memoryPage({})
      await view.settle()
      const body = new URL(findAll(view.tree, (n) => n.type === 'a')[0].props.href).searchParams.get('body')
      assert.equal(body, `issueBody${JSON.stringify({ version, os })}`, JSON.stringify(navigator))
    })
  }
  // and both templates are this fixed text around those two, word for word: anything added
  // to what a public issue starts with has to be added here too
  const { dictionaries } = await applied()
  assert.equal(dictionaries.engramory.zh.issueBody,
    '（写下遇到的问题或建议）\n\n---\ndsh-engramory {version}\n打开这个页面的电脑：{os}\ndsh 版本：')
  assert.equal(dictionaries.engramory.en.issueBody,
    '(What happened, or your idea)\n\n---\ndsh-engramory {version}\nComputer this page was opened on: {os}\ndsh version: ')
})

// --- the version, and the check for a newer one ---

const NPM = 'https://registry.npmjs.org/dsh-engramory/latest'
const MIRROR = 'https://registry.npmmirror.com/dsh-engramory/latest'
const INSTALLED = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version

/**
 * The memory page in Chinese, with the registries answering from `registries` — a body, a
 * `{ status }`, an Error to throw, or a function of the request's init that returns a
 * promise of a response — and every request to them recorded with its init.
 */
async function updatePage(registries) {
  const { view, sent, zh } = await memoryPage({}, { zh: true })
  const local = globalThis.fetch
  const asked = []
  globalThis.fetch = async (url, init = {}) => {
    if (!/^https?:/.test(url)) return local(url, init)
    asked.push({ url, init })
    const answer = registries[url]
    if (answer === undefined || answer instanceof Error) throw answer ?? new Error(`no registry ${url}`)
    if (typeof answer === 'function') return answer(init)
    return { ok: (answer.status ?? 200) < 400, status: answer.status ?? 200, json: async () => answer }
  }
  await view.settle()
  return { view, sent, zh, asked }
}
const check = async (view, zh) => {
  button(view.tree, zh.checkUpdate).props.onClick()
  await view.settle()
}

test('client: the version is checked against npm only on a click, and a newer one comes with the steps that install it, the version named', async () => {
  const copied = []
  await withNavigator({ platform: 'Win32', clipboard: { writeText: async (text) => { copied.push(text) } } }, async () => {
    const { view, sent, zh, asked } = await updatePage({ [NPM]: { name: 'dsh-engramory', version: '99.0.0' } })
    // listed, and nothing asked beyond dsh until the button is pressed
    assert.deepEqual(asked, [])
    assert.ok(sent.every(({ url }) => !/^https?:/.test(url)))
    let text = textOf(view.tree)
    assert.ok(text.includes(zh.versionLine.replace('{version}', INSTALLED)))
    assert.ok(text.includes(zh.updateNote))
    await check(view, zh)
    // one request, a GET of this package's latest, with no cookie, no referrer, no body: these
    // options and no other, and one header, asking for JSON
    assert.deepEqual(asked.map(({ url }) => url), [NPM])
    const [{ init }] = asked
    assert.deepEqual(Object.keys(init).sort(), ['cache', 'credentials', 'headers', 'referrerPolicy', 'signal'])
    assert.deepEqual([init.credentials, init.referrerPolicy, init.cache], ['omit', 'no-referrer', 'no-store'])
    assert.deepEqual(init.headers, { accept: 'application/json' })
    text = textOf(view.tree)
    assert.ok(text.includes(zh.updateNewer.replace('{latest}', '99.0.0').replace('{current}', INSTALLED)))
    assert.ok(text.includes(zh.updateHow) && text.includes(zh.updateAfter))
    // the version named, to search for on the Plugins page and on the command line
    assert.deepEqual(findAll(view.tree, (n) => n.type === 'code').map(textOf),
      ['dsh-engramory@99.0.0', 'dsh plugin --profile <名字> add dsh-engramory@99.0.0'])
    const notes = findAll(view.tree, (n) => n.type === 'a' && textOf(n) === zh.updateNotes)[0]
    assert.equal(notes.props.href, 'https://github.com/tinqiao-oss/engramory/releases/tag/v99.0.0')
    assert.deepEqual([notes.props.target, notes.props.rel], ['_blank', 'noopener noreferrer'])
    // the first Copy is the version's, above the mailbox's
    findAll(view.tree, (n) => n.type === 'button' && textOf(n) === zh.copy)[0].props.onClick()
    await view.settle()
    assert.deepEqual(copied, ['dsh-engramory@99.0.0'])
    assert.ok(button(view.tree, zh.copied))
  })
  // no clipboard: say to select it by hand
  await withNavigator({ platform: 'Win32' }, async () => {
    const { view, zh } = await updatePage({ [NPM]: { version: '99.0.0' } })
    await check(view, zh)
    findAll(view.tree, (n) => n.type === 'button' && textOf(n) === zh.copy)[0].props.onClick()
    await view.settle()
    assert.ok(textOf(view.tree).includes(zh.copySpecFailed))
  })
})

test('client: a version check says this is the latest, or newer than npm\'s, by the numbers and not the text', async () => {
  const [major, minor, patch] = INSTALLED.split('.').map(Number)
  for (const [latest, key] of [
    [INSTALLED, 'updateCurrent'],
    [`${INSTALLED}+build.7`, 'updateCurrent'], // build metadata makes no version newer
    [`${major}.${minor}.${patch + 1}`, 'updateNewer'],
    [`${major}.${minor + 10}.0`, 'updateNewer'], // 1.14 after 1.4, where text would put it before
    [`${major + 1}.0.0`, 'updateNewer'],
    [`${major}.${minor}.${patch + 1}-rc.1`, 'updateNewer'],
    [`${INSTALLED}-rc.1`, 'updateAhead'], // a prerelease comes before its release
    [`${major - 1}.${minor + 1}.${patch + 1}`, 'updateAhead'],
  ]) {
    const { view, zh } = await updatePage({ [NPM]: { version: latest } })
    await check(view, zh)
    const text = textOf(view.tree)
    const said = zh[key].replace('{latest}', latest).replace('{current}', INSTALLED).replace('{source}', 'npm')
    assert.ok(text.includes(said), `${latest}: ${key}`)
    assert.equal(findAll(view.tree, (n) => n.type === 'code').length, key === 'updateNewer' ? 2 : 0, latest)
  }
})

test('client: when npm cannot be reached the mirror is asked, and when neither answers the page says where to look', async () => {
  // npm unreachable, failing, or answering with something that is not a version: the mirror's word
  for (const npm of [new Error('offline'), { status: 503 }, { version: '<b>99</b>' }, { version: 99 }, {},
    { status: 200, version: 'latest' }, { version: '99.0.0-.' }, { version: '99.0.0-rc..1' }, { version: '99.0.0-01' },
    { version: '099.0.0' }, { version: '1234567890.0.0' }, { version: `99.0.0-${'a'.repeat(60)}` }]) {
    const { view, zh, asked } = await updatePage({ [NPM]: npm, [MIRROR]: { version: '99.0.0' } })
    await check(view, zh)
    assert.deepEqual(asked.map(({ url }) => url), [NPM, MIRROR], JSON.stringify(npm))
    assert.equal(asked[1].init.credentials, 'omit')
    // the first request is let go — an error's body is not left streaming
    assert.equal(asked[0].init.signal.aborted, true, JSON.stringify(npm))
    assert.ok(findAll(view.tree, (n) => n.type === 'code').some((n) => textOf(n) === 'dsh-engramory@99.0.0'))
    // said to be the mirror's word, which may trail npm's
    assert.ok(textOf(view.tree).includes(zh.updateMirror), JSON.stringify(npm))
  }
  // the mirror's latest is the mirror's, not npm's, when it is no newer than this one
  const behind = await updatePage({ [NPM]: { status: 503 }, [MIRROR]: { version: INSTALLED } })
  await check(behind.view, behind.zh)
  assert.ok(textOf(behind.view.tree).includes(
    behind.zh.updateCurrent.replace('{source}', 'npmmirror').replace('{latest}', INSTALLED)))
  assert.ok(textOf(behind.view.tree).includes(behind.zh.updateMirror))
  // npm answering is enough: the mirror is not asked, nor mentioned
  const first = await updatePage({ [NPM]: { version: '99.0.0' }, [MIRROR]: { version: '98.0.0' } })
  await check(first.view, first.zh)
  assert.deepEqual(first.asked.map(({ url }) => url), [NPM])
  assert.ok(!textOf(first.view.tree).includes(first.zh.updateMirror))
  // neither: where to look, and the button offers to try again
  const { view, zh, asked } = await updatePage({ [NPM]: new Error('offline'), [MIRROR]: { status: 500 } })
  await check(view, zh)
  assert.ok(textOf(view.tree).includes(zh.updateFailed))
  const npmPage = findAll(view.tree, (n) => n.type === 'a' && textOf(n) === zh.updateNpm)[0]
  assert.equal(npmPage.props.href, 'https://www.npmjs.com/package/dsh-engramory?activeTab=versions')
  assert.equal(button(view.tree, zh.checkUpdate).props.disabled, false)
  await check(view, zh)
  assert.deepEqual(asked.map(({ url }) => url), [NPM, MIRROR, NPM, MIRROR])
})

test('client: a check in flight disables its button, and a registry that never finishes answering is given up on', async () => {
  let answer
  const { view, zh } = await updatePage({ [NPM]: () => new Promise((resolve) => { answer = resolve }) })
  await check(view, zh)
  const busy = button(view.tree, zh.checking)
  assert.equal(busy.props.disabled, true)
  answer({ ok: true, status: 200, json: async () => ({ version: INSTALLED }) })
  await view.settle()
  assert.ok(textOf(view.tree).includes(zh.updateCurrent.replace('{source}', 'npm').replace('{latest}', INSTALLED)))
  // headers from npm, then a body that never comes — until the deadline aborts it; the mirror answers
  const stalled = (init) => Promise.resolve({ ok: true, status: 200,
    json: () => new Promise((resolve, reject) => { init.signal.addEventListener('abort', () => reject(new Error('aborted'))) }) })
  const page = await updatePage({ [NPM]: stalled, [MIRROR]: { version: '99.0.0' } })
  const realTimeout = globalThis.setTimeout
  // the page listed already: only the check's deadlines run out at once, and what they were
  const delays = []
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); return realTimeout(fn, 0) }
  try {
    const { view, zh, asked } = page
    button(view.tree, zh.checkUpdate).props.onClick()
    for (let i = 0; i < 20 && asked.length < 2; i++) {
      await new Promise((resolve) => realTimeout(resolve, 2))
      await view.settle()
    }
    await view.settle()
    assert.deepEqual(asked.map(({ url }) => url), [NPM, MIRROR])
    assert.ok(findAll(view.tree, (n) => n.type === 'code').some((n) => textOf(n) === 'dsh-engramory@99.0.0'))
    assert.deepEqual(delays.slice(0, 2), [8000, 8000]) // eight seconds for each registry, its body included
  } finally {
    globalThis.setTimeout = realTimeout
  }
})

// --- the banner, the plans, the bar, the filters, the tidy-up instructions ---

/** Run `fn` with the clock at `at` (a local time), as the page reads it when a listing lands. */
async function atTime(at, fn) {
  const real = Date.now
  Date.now = () => at
  try {
    return await fn()
  } finally {
    Date.now = real
  }
}

test('client: the banner counts what was listed, and the page says when that is not all there is', async () => {
  const { view } = await memoryPage({})
  await view.settle()
  assert.deepEqual(textsOf(view.tree, 'eng-stat'), ['4statNotes', '2statStores', '1statArchive'])
  assert.match(textsOf(view.tree, 'eng-hero-read')[0], /^statsReadAt\{"time":"[^"]+"\}$/)
  // the title names the plugin's version, as package.json does, while it lists and after
  assert.deepEqual(textsOf(view.tree, 'eng-hero-title'), [`panelTitlev${INSTALLED}`])
  assert.deepEqual(textsOf(view.tree, 'eng-hero-version'), [`v${INSTALLED}`])
  assert.deepEqual(textsOf(view.tree, 'eng-caveat'), ['statsPartial']) // the project store's listing was cut short
  // stores it could not read: said, and nothing counted for them
  const missing = await memoryPage({ [`GET ${MEMORY}`]: memoryData({ stores: [], unreadable: 2 }) })
  await missing.view.settle()
  assert.deepEqual(textsOf(missing.view.tree, 'eng-stat'), ['0statNotes', '0statStores', '0statArchive'])
  assert.deepEqual(textsOf(missing.view.tree, 'eng-caveat'), ['statsUnreadable{"count":2}'])
  // nothing listed and nothing unreadable: no numbers, only the page's own empty note
  const empty = await memoryPage({ [`GET ${MEMORY}`]: memoryData({ stores: [] }) })
  await empty.view.settle()
  assert.deepEqual(textsOf(empty.view.tree, 'eng-stat'), [])
  assert.deepEqual(textsOf(empty.view.tree, 'eng-caveat'), [])
  assert.deepEqual(textsOf(empty.view.tree, 'eng-note'), ['empty'])
})

test('client: a plan\'s row says where it stands against today, and a passed date is only to be asked about', async () => {
  const plan = (name) => ({ name, type: 'upcoming' })
  const stores = [{
    id: 'user', kind: 'user', dir: 'C:\\m', titles: [], index: { name: 'MEMORY.md', bytes: 100, lines: 3, over: false },
    notes: [plan('2026-11-05-dinner.md'), plan('等录取结果.md'), plan('2026-10-30面试.md'), plan('2026-11-01-call.md'),
      plan('2026-10-31-today.md'), plan('2026-02-30-no-such-day.md'), plan('2026-11-07.md'), plan('2025-10-30面试.md'),
      { name: 'who.md', type: 'user' }],
    archive: [], more: false,
  }]
  await atTime(new Date(2026, 9, 31, 23, 30).getTime(), async () => {
    const { view } = await memoryPage({ [`GET ${MEMORY}`]: memoryData({ stores }) }, { zh: true })
    await view.settle()
    const plans = findAll(view.tree, (n) => n.props.className === 'eng-row' && n.props['data-type'] === 'upcoming')
    // the date is in the badge, not said again before the name; the file's whole name is its title
    assert.deepEqual(plans.map((row) => [row.props.title, textOf(findAll(row, (n) => n.props.className === 'eng-name')[0]),
      findAll(row, (n) => n.props.className === 'eng-badge').map((b) => [textOf(b), b.props['data-tone']])]), [
      // last year's: its year said, so it is not taken for this year's of the same name
      ['2025-10-30面试.md', '面试', [['2025年10月30日 · 日期已过，待确认', 'warn']]],
      ['2026-02-30-no-such-day.md', '2026-02-30-no-such-day', [['未定日期', 'quiet']]], // not a real day
      ['2026-10-30面试.md', '面试', [['10月30日 · 日期已过，待确认', 'warn']]],
      ['2026-10-31-today.md', 'today', [['就是今天', undefined]]],
      ['2026-11-01-call.md', 'call', [['11月1日 · 明天', undefined]]],
      ['2026-11-05-dinner.md', 'dinner', [['11月5日 · 还有 5 天', undefined]]],
      ['2026-11-07.md', '2026-11-07', [['11月7日 · 还有 7 天', undefined]]], // nothing but the date: kept as the name
      ['等录取结果.md', '等录取结果', [['未定日期', 'quiet']]],
    ])
    // they open as everywhere else on the page, and there is no board of them apart
    assert.equal(findAll(view.tree, (n) => n.type === 'button' && n.props.className === 'eng-row' &&
      n.props['data-type'] === 'upcoming').length, 8)
    assert.equal(findAll(view.tree, (n) => n.props.className === 'eng-upcoming').length, 0)
  })
})

test('client: an index\'s bar fills to the nearer of its two caps, and past one it is full and marked', async () => {
  const meters = async (indexes) => {
    const stores = indexes.map((index, i) => ({ id: `s${i}`, kind: 'project', dir: `C:\\s${i}`, titles: [`s${i}`],
      index, notes: [], archive: [], more: false }))
    const { view } = await memoryPage({ [`GET ${MEMORY}`]: memoryData({ stores }) })
    await view.settle()
    return findAll(view.tree, (n) => n.props.className === 'eng-meter')
      .map((m) => [m.children[0].props.style.width, m.props['data-over']])
  }
  assert.deepEqual(await meters([
    { name: 'MEMORY.md', bytes: 2560, lines: 150, over: false }, // lines nearer: 75%
    { name: 'MEMORY.md', bytes: 19200, lines: 20, over: false }, // bytes nearer: 75%
    { name: 'MEMORY.md', bytes: 12800, over: false }, // lines not counted: by bytes alone, not 0%
    { name: 'MEMORY.md', bytes: 30000, over: true }, // past the cap
    { name: 'MEMORY.md', bytes: 1000, lines: 260, over: true }, // past the line cap, bytes well within
    { name: 'MEMORY.md', bytes: 1000, lines: 199, over: false }, // one line short: not full
  ]), [['75%', false], ['75%', false], ['50%', false], ['100%', true], ['100%', true], ['99%', false]])
  // no index: no bar
  assert.deepEqual(await meters([null]), [])
})

test('client: the filter keeps the names that match, says how many among those listed, and where none do', async () => {
  const { view } = await memoryPage({}, { zh: true })
  await view.settle()
  const input = () => findAll(view.tree, (n) => n.type === 'input' && n.props.type === 'search')[0]
  assert.equal(findAll(view.tree, (n) => n.props.className === 'eng-filter-count').length, 0)
  input().props.onChange({ target: { value: ' ＮＯＴＥ ' } }) // trimmed, any case, full-width as plain
  await view.settle()
  assert.deepEqual(rowsOf(view.tree).map(([, name]) => name), ['a-note', 'b-note'])
  const zh = (await applied()).dictionaries.engramory.zh
  assert.deepEqual(findAll(view.tree, (n) => n.props.className === 'eng-filter-count').map(textOf),
    [zh.filterCount.replace('{count}', '2')])
  // the project store holds nothing that matches: it says so
  assert.deepEqual(findAll(view.tree, (n) => n.props.className === 'eng-filter-none').map(textOf), [zh.filterNone])
  // the archive opens on a match
  input().props.onChange({ target: { value: 'moments' } })
  await view.settle()
  const [archive] = findAll(view.tree, (n) => n.type === 'details' && n.props.className === 'eng-archive')
  assert.equal(archive.props.open, true)
  assert.deepEqual(rowsOf(archive).map(([, name]) => name), ['moments-2026-09'])
  input().props.onChange({ target: { value: '' } })
  await view.settle()
  assert.equal(findAll(view.tree, (n) => n.type === 'button' && n.props.className === 'eng-row').length, 5)
})

test('client: a type tab keeps that type\'s notes, with the name filter, and lets go once a refresh leaves none', async () => {
  let calls = 0
  const { view } = await memoryPage({
    [`GET ${MEMORY}`]: () => (++calls === 2
      ? memoryData({ stores: [{ ...memoryData().stores[0], notes: [{ name: 'who.md', type: 'user' }] }] })
      : memoryData()),
  }, { zh: true })
  await view.settle()
  const tab = (type) => findAll(view.tree, (n) => n.props.className === 'eng-tab' && n.props['data-type'] === type)[0]
  assert.equal(tab('all').props['aria-pressed'], true)
  tab('feedback').props.onClick()
  await view.settle()
  assert.equal(tab('feedback').props['aria-pressed'], true)
  // that type alone, no archive, and the store without one says so
  assert.deepEqual(rowsOf(view.tree).map(([type, name]) => [type, name]), [['feedback', 'a-note'], ['feedback', 'b-note']])
  assert.equal(findAll(view.tree, (n) => n.props.className === 'eng-filter-none').length, 1)
  // what to tidy up waits until the filter is off, as with a name
  assert.equal(findAll(view.tree, (n) => n.props.className === 'eng-attn').length, 0)
  findAll(view.tree, (n) => n.type === 'input' && n.props.type === 'search')[0].props.onChange({ target: { value: 'b-' } })
  await view.settle()
  assert.deepEqual(rowsOf(view.tree).map(([, name]) => name), ['b-note'])
  assert.match(textsOf(view.tree, 'eng-filter-count')[0], /匹配 1 条/)
  findAll(view.tree, (n) => n.type === 'input' && n.props.type === 'search')[0].props.onChange({ target: { value: '' } })
  button(view.tree, '刷新').props.onClick() // the listing comes back with no feedback notes
  await view.settle()
  assert.equal(tab('feedback'), undefined)
  assert.equal(tab('all').props['aria-pressed'], true)
  assert.deepEqual(rowsOf(view.tree).map(([, name]) => name), ['who', 'moments-2026-09'])
  button(view.tree, '刷新').props.onClick() // the feedback notes come back, and the filter does not
  await view.settle()
  assert.equal(tab('feedback').props['aria-pressed'], false)
  assert.equal(tab('all').props['aria-pressed'], true)
  assert.equal(rowsOf(view.tree).length, 5)
})

test('client: each store copies tidy-up instructions naming its folder, or shows them to select by hand', async () => {
  const copied = []
  await withNavigator({ clipboard: { writeText: async (text) => { copied.push(text) } } }, async () => {
    const { view, zh } = await memoryPage({}, { zh: true })
    await view.settle()
    const buttons = findAll(view.tree, (n) => n.type === 'button' && textOf(n) === zh.tidyCopy)
    assert.equal(buttons.length, 2) // one per store, whether or not dsh can open its files
    buttons[1].props.onClick()
    await view.settle()
    assert.deepEqual(copied, [zh.tidyPrompt.replace('{dir}', 'E:\\repo\\.engramory-memory')])
    assert.equal(findAll(view.tree, (n) => n.type === 'button' && textOf(n) === zh.tidyCopied).length, 1)
    assert.equal(findAll(view.tree, (n) => n.type === 'textarea').length, 0)
  })
  await withNavigator({}, async () => {
    const { view, zh } = await memoryPage({}, { zh: true })
    await view.settle()
    findAll(view.tree, (n) => n.type === 'button' && textOf(n) === zh.tidyCopy)[0].props.onClick()
    await view.settle()
    const [shown] = findAll(view.tree, (n) => n.type === 'textarea')
    assert.equal(shown.props.value, zh.tidyPrompt.replace('{dir}', 'C:\\Users\\u\\.dsh\\.engramory-memory'))
    assert.equal(shown.props.readOnly, true)
    assert.ok(textOf(view.tree).includes(zh.tidyFailed))
  })
  // the instructions keep a passed plan, and say what to do with each finding, not to add everything
  const { dictionaries } = await applied()
  for (const lang of ['zh', 'en']) {
    assert.deepEqual(dictionaries.engramory[lang].tidyPrompt.match(/\{\w+\}/g), ['{dir}'], lang)
  }
})

test('client: in English, one note and one store are said in the singular', async () => {
  const { page, react, dictionaries } = await applied()
  const en = (key, params) => dictionaries.engramory.en[key].replace(/\{(\w+)\}/g, (_, name) => String(params?.[name]))
  const store = { ...memoryData().stores[0], notes: [{ name: 'who.md', type: 'user' }], archive: [] }
  routeFetch({ [`GET ${SETTINGS}`]: settingsData(), [`GET ${MEMORY}`]: memoryData({ stores: [store] }) })
  const view = react.mount(react.React.createElement(page.component, { t: en }))
  await view.settle()
  assert.deepEqual(textsOf(view.tree, 'eng-stat'), ['1note', '1store', '0archived'])
  assert.deepEqual(textsOf(view.tree, 'eng-store-count'), ['1 note'])
})

test('client: a note past 12 KB is marked on its row and counted among what to tidy up', async () => {
  const stores = [{
    id: 'user', kind: 'user', dir: 'C:\\m', titles: [], index: { name: 'MEMORY.md', bytes: 100, lines: 3, over: false },
    notes: [{ name: 'timeline.md', type: 'project', bytes: 12 * 1024 + 1 }, { name: 'edge.md', type: 'project', bytes: 12 * 1024 },
      { name: 'small.md', type: 'user', bytes: 300 }, { name: 'unread.md', type: 'other' }],
    archive: [], more: false,
  }]
  const { view, zh } = await memoryPage({ [`GET ${MEMORY}`]: memoryData({ stores }) }, { zh: true })
  await view.settle()
  assert.deepEqual(rowsOf(view.tree), [
    ['user', 'small', '用户 · 300 B', []],
    ['project', 'edge', '项目 · 12.0 KB', []],
    ['project', 'timeline', '项目 · 12.0 KB', [zh.badgeLarge]],
    ['other', 'unread', '其他', []],
  ])
  assert.ok(textsOf(view.tree, 'eng-attn-item').includes(zh.attnLarge.replace('{count}', '1')))
})

test('client: what was not read is not counted as nothing — no empty note, a word on stores read in part', async () => {
  // every store unreadable: no "no memory yet", and the how-to does not unfold as if there were none
  const gone = await memoryPage({ [`GET ${MEMORY}`]: memoryData({ stores: [], unreadable: 1 }) })
  await gone.view.settle()
  assert.ok(!textsOf(gone.view.tree, 'eng-note').includes('empty'))
  assert.equal(findAll(gone.view.tree, (n) => n.type === 'details' && n.props.className === 'eng-howto')[0].props.open, false)
  // a store with a note or a folder it could not read: the page says the counts may fall short
  const stores = [{
    id: 'user', kind: 'user', dir: 'C:\\m', titles: [], index: { name: 'MEMORY.md', bytes: 100, lines: 3, over: false },
    notes: [{ name: 'a.md', type: 'user', bytes: 300 }, { name: 'locked.md', type: 'other', unread: true }],
    archive: [], more: false, health: { checked: false, reason: 'unreadable' },
  }]
  const part = await memoryPage({ [`GET ${MEMORY}`]: memoryData({ stores }) })
  await part.view.settle()
  assert.deepEqual(textsOf(part.view.tree, 'eng-caveat'), ['statsIncomplete'])
  assert.deepEqual(textsOf(part.view.tree, 'eng-note'), ['healthUnreadable'])
  // the note it could not read is listed, and says so where a type and size would be
  assert.deepEqual(textsOf(part.view.tree, 'eng-stat'), ['2statNotes', '1statStore', '0statArchive'])
  assert.deepEqual(rowsOf(part.view.tree), [['user', 'a', 'noteMeta{"type":"typeUser","size":"sizeBytes{\\"n\\":300}"}', []],
    ['other', 'locked', 'noteUnread', []]])
})

test('client: while filtering, a store shows the rows that match and not what there is to tidy up', async () => {
  const stores = [{
    id: 'user', kind: 'user', dir: 'C:\\m', titles: [], index: { name: 'MEMORY.md', bytes: 100, lines: 3, over: false },
    notes: [{ name: 'timeline.md', type: 'project', bytes: 20000 }, { name: 'who.md', type: 'user', bytes: 200 }],
    archive: [], more: false,
    health: { checked: true, broken: [], brokenMore: false, unindexed: ['timeline.md'] },
  }]
  const { view } = await memoryPage({ [`GET ${MEMORY}`]: memoryData({ stores }) })
  await view.settle()
  const found = () => findAll(view.tree, (n) => n.props.className === 'eng-attn').length
  assert.equal(found(), 1)
  findAll(view.tree, (n) => n.type === 'input' && n.props.type === 'search')[0].props.onChange({ target: { value: 'zzz' } })
  await view.settle()
  assert.equal(found(), 0)
  assert.equal(rowsOf(view.tree).length, 0)
  assert.deepEqual(textsOf(view.tree, 'eng-filter-none'), ['filterNone'])
  // the tidy-up instructions stay one click away, among the store's actions
  assert.equal(findAll(view.tree, (n) => n.type === 'button' && textOf(n) === 'tidyCopy').length, 1)
})

test('client: the tidy-up instructions drop a dead link, not the line its live neighbours share', async () => {
  const { dictionaries } = await applied()
  assert.ok(dictionaries.engramory.zh.tidyPrompt.includes('只删这个链接；一行里没有别的有效链接了，才删掉整行'))
  assert.ok(dictionaries.engramory.en.tidyPrompt.includes('remove that link alone, and the line only when it has no other live link left'))
  for (const lang of ['zh', 'en']) {
    // a passed plan is kept, and recall's notes are indexed, not every note
    assert.match(dictionaries.engramory[lang].tidyPrompt, lang === 'zh' ? /日期已过的约定别删/ : /do not delete them/)
    assert.match(dictionaries.engramory[lang].tidyPrompt, lang === 'zh' ? /不要为了补齐全部加进去/ : /do not add them all/)
  }
})

test('client: a name from disk that could read as another shows what it hides, and opens as it is', async () => {
  // a project's store is whatever its checkout put there: a right-to-left override turns
  // `safe<RLO>gnp.exe` into what reads as `safeexe.png`, and a control character hides
  const [rlo, isolate, nel, separator, zwsp, zwj] = [0x202e, 0x2066, 0x85, 0x2028, 0x200b, 0x200d]
    .map((code) => String.fromCharCode(code))
  const tricky = `safe${rlo}gnp.exe.md`
  // an emoji written with a joiner keeps it: the joiner is part of how it is written
  const family = `${String.fromCodePoint(0x1f468)}${zwj}${String.fromCodePoint(0x1f469)}.md`
  const store = {
    ...memoryData().stores[0],
    dir: `/home/u${isolate}/.dsh/.engramory-memory`, titles: [`repo${nel}`],
    notes: [{ name: tricky, type: 'user' }, { name: `report${zwsp}.md`, type: 'user' }, { name: family, type: 'user' }],
    archive: [`old${separator}.md`],
    health: { checked: true, broken: [`gone${rlo}.md`], brokenMore: false, unindexed: [] },
  }
  const { view, sent } = await memoryPage({
    [`GET ${MEMORY}`]: memoryData({ stores: [store] }), [`POST ${MEMORY}`]: { ok: true },
  })
  await view.settle()
  const text = textOf(view.tree)
  for (const hidden of [rlo, isolate, nel, separator, zwsp]) assert.ok(!text.includes(hidden), hidden.codePointAt(0).toString(16))
  assert.deepEqual(rowsOf(view.tree).map(([, name]) => name).sort(),
    ['old[U+2028]', 'report[U+200B]', 'safe[U+202E]gnp.exe', family.replace(/\.md$/, '')].sort())
  for (const shown of ['gone[U+202E].md', '/home/u[U+2066]/.dsh', 'repo[U+0085]']) assert.ok(text.includes(shown), shown)
  assert.ok(findAll(view.tree, (n) => n.props.className === 'eng-row').map((row) => row.props.title)
    .includes('safe[U+202E]gnp.exe.md'))
  // the filter finds it by what the page shows, as by what it is
  const filter = (value) => findAll(view.tree, (n) => n.type === 'input' && n.props.type === 'search')[0]
    .props.onChange({ target: { value } })
  for (const typed of ['safe[U+202E]gnp', 'gnp.exe']) {
    filter(typed)
    await view.settle()
    assert.deepEqual(rowsOf(view.tree).map(([, name]) => name), ['safe[U+202E]gnp.exe'], typed)
  }
  filter('')
  await view.settle()
  // what the page sends back is the name itself
  nameButton(view.tree, 'safe[U+202E]gnp.exe').props.onClick()
  await view.settle()
  assert.deepEqual(sent.filter((s) => s.method === 'POST').at(-1).body, { store: 'user', file: tricky })
  assert.match(textOf(view.tree), /opened\{"name":"safe\[U\+202E\]gnp\.exe"\}/)
})

test('client: an index the desktop shows in its folder rather than opens is said to be shown there', async () => {
  const store = { ...memoryData().stores[0], index: { name: 'MEMORY.cmd', bytes: 10, lines: 1, over: false } }
  const { view, sent } = await memoryPage({
    [`GET ${MEMORY}`]: memoryData({ stores: [store] }), [`POST ${MEMORY}`]: { ok: true, revealed: true },
  })
  await view.settle()
  button(view.tree, 'openIndex').props.onClick()
  await view.settle()
  assert.deepEqual(sent.filter((s) => s.method === 'POST').at(-1).body, { store: 'user', file: 'MEMORY.cmd' })
  assert.ok(textOf(view.tree).includes('revealed{"name":"MEMORY.cmd"}'))
  // the folder button opens the folder, as before
  button(view.tree, 'openFolder').props.onClick()
  await view.settle()
  assert.ok(textOf(view.tree).includes('opened{"name":'))
  assert.ok(!textOf(view.tree).includes('revealed{'))
})

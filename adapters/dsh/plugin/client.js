/**
 * dsh-engramory, browser half: the settings page behind the Configure control on the
 * Plugins page. It edits the language and companion settings — which presets are a
 * companion (大肥鱼模式), which conversations are the user's own — through the routes
 * index.js registers, so nobody pastes session ids into YAML.
 *
 * Plain script, no build step, like index.js: React comes from the page's module table,
 * no Harness client package is loaded as a module (dsh's guidance — they change without
 * notice), and every colour is a host theme token, so light, dark and third-party themes
 * follow. Visible text goes through the locale service.
 */
window.__ModuleLoader__.load({
  id: 'dsh-engramory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const NS = 'engramory'
    /** The Plugins page keys a row's page by `<package>#<row id>`; the row id is the patch's. */
    const ROW = 'dsh-engramory#engramory'
    /** Relative to the page, as dsh's own pages fetch, so a mounted deployment keeps its prefix. */
    const API = 'api/engramory/settings'
    const DEFAULT_LINES = 200
    const DEFAULT_BYTES = 25600

    const zh = {
      summary: '记忆用哪种语言写、大肥鱼模式，以及哪些会话是你自己的。',
      loading: '正在读取设置…',
      loadFailed: '读不到设置。',
      retry: '重试',
      unavailable: '这个 dsh 不能在页面里保存这些设置（没有配置编辑服务）。请改配置文件 cordis.patch.yml，写法见插件说明。',
      expression: '配置文件里有设置是用 !!js 表达式写的，这里显示不了它的实际值，所以只读。请直接改 cordis.patch.yml。',
      language: '记忆的语言',
      languageHint: '笔记名、目录标题和给 AI 的说明都用这种语言写。已有的笔记不会被改写。',
      languageEn: 'English',
      languageZh: '中文',
      companion: '大肥鱼模式',
      companionHint: '勾选哪些人设是陪伴角色。用了这些人设的会话会多记三类：经历、约定、我自己；不是你自己的会话拿不到你的记忆。',
      presetsNone: '还没有可选的人设。',
      presetsUnavailable: '这个 dsh 列不出人设，可以手动填人设的 id。',
      presetMissing: '未找到',
      owners: '你自己的会话',
      ownersHint: '打开「这是我」的会话拿得到你的全部记忆；别的大肥鱼会话拿不到。把群聊加进来，群里每个人都碰得到你的记忆。',
      ownersNeedPreset: '先在上面勾选大肥鱼的人设，这里才会列出它们的会话。',
      ownersEmpty: '还没有用这些人设的会话。',
      sessionsUnavailable: '这个 dsh 列不出会话，只能手动填会话 ID。',
      mine: '这是我',
      byPrefix: '按前缀',
      created: '创建于',
      active: '最近活动',
      otherIds: '名单里的其他会话 ID 和前缀',
      addId: '会话 ID，或以 * 结尾的前缀',
      addPreset: '人设 id',
      add: '添加',
      remove: '移除',
      cap: '索引上限',
      capHint: '记忆目录超过这个大小时，AI 的写入会被拒绝，要先压缩。默认 200 行 / 25600 字节。',
      capLines: '行',
      capBytes: '字节',
      save: '保存',
      saving: '保存中…',
      discard: '放弃修改',
      reloading: '已保存，插件正在用新设置重新加载…',
      saved: '已保存。',
      savedUnconfirmed: '已保存，但重新读到的设置和刚才填的不一样（或者插件还没加载好）。请刷新页面看看。',
      stale: '设置在别处被改过，已重新读取。请再改一次。',
      overridden: '更高一层的配置覆盖了这些值，这里保存不了。',
      invalid: '有一项填得不对：',
      failed: '保存失败：',
    }
    const en = {
      summary: 'Which language the memory is written in, companion mode (大肥鱼模式), and which conversations are your own.',
      loading: 'Reading the settings…',
      loadFailed: 'Could not read the settings.',
      retry: 'Retry',
      unavailable: 'This dsh cannot save these settings from a page (it has no config editor). Edit cordis.patch.yml instead; the plugin README shows how.',
      expression: 'A setting in the config is written as a !!js expression, whose value this page cannot show, so it is read-only. Edit cordis.patch.yml directly.',
      language: 'Memory language',
      languageHint: 'Note names, index headings and the instructions to the AI are written in it. Existing notes are not rewritten.',
      languageEn: 'English',
      languageZh: '中文',
      companion: 'Companion mode (大肥鱼模式)',
      companionHint: 'Tick the presets that are a companion character. Their conversations keep three more kinds of note — moments, plans, the character itself — and one that is not yours gets none of your memory.',
      presetsNone: 'There are no presets to choose from yet.',
      presetsUnavailable: 'This dsh cannot list its presets; type a preset id instead.',
      presetMissing: 'not found',
      owners: 'Your own conversations',
      ownersHint: 'A conversation marked “This is me” gets all of your memory; any other companion conversation gets none. Listing a group chat lets everyone in it reach your memory.',
      ownersNeedPreset: 'Tick a companion preset above to list its conversations here.',
      ownersEmpty: 'No conversation runs these presets yet.',
      sessionsUnavailable: 'This dsh cannot list its conversations; type a session id instead.',
      mine: 'This is me',
      byPrefix: 'by prefix',
      created: 'created',
      active: 'active',
      otherIds: 'Other listed session ids and prefixes',
      addId: 'A session id, or a prefix ending in *',
      addPreset: 'Preset id',
      add: 'Add',
      remove: 'Remove',
      cap: 'Index cap',
      capHint: 'Past this size the AI’s writes to the memory index are refused until it compacts. The default is 200 lines / 25600 bytes.',
      capLines: 'lines',
      capBytes: 'bytes',
      save: 'Save',
      saving: 'Saving…',
      discard: 'Discard changes',
      reloading: 'Saved; the plugin is reloading with the new settings…',
      saved: 'Saved.',
      savedUnconfirmed: 'Saved, but the settings read back differ from what you entered (or the plugin has not finished loading). Reload the page to check.',
      stale: 'The settings changed elsewhere and were read again. Make your change once more.',
      overridden: 'A higher configuration layer overrides these values, so they cannot be saved here.',
      invalid: 'One field is not acceptable: ',
      failed: 'Saving failed: ',
    }

    const CSS = `
.eng-page{display:flex;flex-direction:column;gap:18px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);max-width:760px;}
.eng-section{display:flex;flex-direction:column;gap:8px;}
.eng-title{font-size:14px;font-weight:600;margin:0;}
.eng-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);}
.eng-note{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);}
.eng-banner{padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:12px;}
.eng-banner[data-tone="error"]{color:var(--dsw-alias-state-error-primary);}
.eng-banner[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);}
.eng-segment{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);align-self:flex-start;}
.eng-segment button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:4px 12px;font:inherit;font-size:12px;cursor:pointer;}
.eng-segment button[aria-pressed="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12);}
.eng-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;}
.eng-row{display:flex;align-items:center;gap:12px;padding:8px 12px;min-width:0;}
.eng-row + .eng-row{border-top:1px solid var(--dsw-alias-border-l1);}
.eng-row:hover{background:var(--dsw-alias-interactive-bg-hover);}
.eng-row-main{display:flex;flex-direction:column;min-width:0;flex:1;}
.eng-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.eng-row-sub{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.eng-row-side{display:flex;align-items:center;gap:8px;flex:none;font-size:12px;color:var(--dsw-alias-label-secondary);}
.eng-check{display:flex;align-items:center;gap:8px;cursor:pointer;}
.eng-check input{margin:0;accent-color:var(--dsw-alias-brand-primary);}
.eng-switch{position:relative;width:32px;height:18px;border-radius:999px;border:0;padding:0;cursor:pointer;background:var(--dsw-alias-border-l2);flex:none;}
.eng-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);}
.eng-switch:disabled{opacity:.5;cursor:default;}
.eng-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform .15s ease;}
.eng-switch[aria-checked="true"]::after{transform:translateX(14px);}
.eng-chips{display:flex;flex-wrap:wrap;gap:6px;}
.eng-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);font-size:12px;max-width:100%;}
.eng-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.eng-chip button{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;border-radius:999px;width:18px;height:18px;padding:0;font:inherit;line-height:18px;}
.eng-chip button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);}
.eng-add{display:flex;gap:6px;}
.eng-input{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:inherit;padding:5px 9px;font:inherit;font-size:12px;outline:none;min-width:0;}
.eng-input:focus{border-color:var(--dsw-alias-brand-primary);}
.eng-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-error-primary);}
.eng-cap{display:flex;gap:12px;align-items:center;flex-wrap:wrap;}
.eng-cap label{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;}
.eng-cap input{width:110px;}
.eng-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 14px;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}
.eng-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.eng-btn:disabled{opacity:.5;cursor:default;}
.eng-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);}
.eng-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));opacity:.9;}
.eng-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.eng-mono{font-family:var(--dsw-font-mono,ui-monospace,monospace);}
`

    /** The settings the page edits, in the order the host computes its revision from. */
    const settingsOf = (data) => ({
      language: data.language === 'zh' ? 'zh' : 'en',
      companionPresets: [...data.companionPresets],
      ownerSessions: [...data.ownerSessions],
      maxLines: data.maxLines,
      maxBytes: data.maxBytes,
    })
    const revisionOf = (settings) => JSON.stringify(settings)
    const capOf = (text, max) => {
      const value = Number(text)
      return /^\s*\d+\s*$/.test(String(text)) && Number.isInteger(value) && value >= 1 && value <= max
        ? value
        : undefined
    }
    const isPrefix = (entry) => entry.endsWith('*')
    const matchesPrefix = (entry, id) => isPrefix(entry) && id.startsWith(entry.slice(0, -1))
    const without = (list, value) => list.filter((v) => v !== value)
    const withValue = (list, value) => (list.includes(value) ? list : [...list, value])

    /** fetch with a deadline: a request the host never answers must not hold the page busy. */
    async function request(init = {}) {
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), 15000)
      try {
        const response = await fetch(API, { cache: 'no-store', ...init, signal: deadline.signal,
          headers: { accept: 'application/json', ...(init.headers ?? {}) } })
        // the body is read under the same deadline: headers alone do not finish a request
        const body = await response.json().catch(() => undefined)
        return { ok: response.ok, status: response.status, body }
      } finally {
        clearTimeout(timer)
      }
    }

    async function fetchSettings() {
      const response = await request()
      if (!response.ok || response.body === undefined) throw new Error(`HTTP ${response.status}`)
      return response.body
    }

    /** A host-styled switch: role=switch with aria-checked, as the host's own. */
    function Switch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button', role: 'switch', className: 'eng-switch', 'aria-checked': checked,
        'aria-label': label, disabled, onClick: () => onChange(!checked),
      })
    }

    function Chips({ items, t, onRemove, disabled }) {
      if (items.length === 0) return null
      return h('div', { className: 'eng-chips' }, items.map((item) => h('span', { className: 'eng-chip', key: item },
        h('span', { className: 'eng-mono', title: item }, item),
        h('button', { type: 'button', 'aria-label': `${t('remove')} ${item}`, title: t('remove'), disabled,
          onClick: () => onRemove(item) }, '×'))))
    }

    function AddField({ placeholder, t, disabled, onAdd }) {
      const [text, setText] = useState('')
      const submit = () => {
        const value = text.trim()
        if (!value) return
        onAdd(value)
        setText('')
      }
      return h('div', { className: 'eng-add' },
        h('input', { className: 'eng-input eng-mono', value: text, placeholder, disabled, style: { flex: 1 },
          onChange: (e) => setText(e.target.value),
          onKeyDown: (e) => { if (e.key === 'Enter' && !e.nativeEvent?.isComposing) submit() } }),
        h('button', { type: 'button', className: 'eng-btn', disabled: disabled || !text.trim(), onClick: submit },
          t('add')))
    }

    function LanguageSection({ draft, t, disabled, update }) {
      const option = (value, label) => h('button', {
        type: 'button', 'aria-pressed': draft.language === value, disabled,
        onClick: () => update({ language: value }),
      }, label)
      return h('section', { className: 'eng-section' },
        h('h3', { className: 'eng-title' }, t('language')),
        h('div', { className: 'eng-segment', role: 'group', 'aria-label': t('language') },
          option('en', t('languageEn')), option('zh', t('languageZh'))),
        h('p', { className: 'eng-hint' }, t('languageHint')))
    }

    function PresetSection({ data, draft, t, disabled, update }) {
      const chosen = draft.companionPresets
      const toggle = (id, on) => update({ companionPresets: on ? withValue(chosen, id) : without(chosen, id) })
      let body
      if (data.presets === null) {
        body = [
          h('p', { className: 'eng-note', key: 'n' }, t('presetsUnavailable')),
          h(Chips, { key: 'c', items: chosen, t, disabled, onRemove: (id) => toggle(id, false) }),
          h(AddField, { key: 'a', placeholder: t('addPreset'), t, disabled, onAdd: (id) => toggle(id, true) }),
        ]
      } else {
        const known = new Set(data.presets.map((p) => p.id))
        const rows = [
          ...data.presets.map((p) => ({ id: p.id, name: p.name, missing: false })),
          ...chosen.filter((id) => !known.has(id)).map((id) => ({ id, missing: true })),
        ]
        body = rows.length === 0
          ? h('p', { className: 'eng-note' }, t('presetsNone'))
          : h('div', { className: 'eng-list' }, rows.map((p) => h('label', { className: 'eng-row eng-check', key: p.id },
            h('input', { type: 'checkbox', checked: chosen.includes(p.id), disabled,
              onChange: (e) => toggle(p.id, e.target.checked) }),
            h('span', { className: 'eng-row-main' },
              h('span', { className: 'eng-row-title' }, p.name || p.id),
              p.missing ? h('span', { className: 'eng-row-sub' }, t('presetMissing'))
                : p.name ? h('span', { className: 'eng-row-sub eng-mono' }, p.id) : null))))
      }
      return h('section', { className: 'eng-section' },
        h('h3', { className: 'eng-title' }, t('companion')),
        h('p', { className: 'eng-hint' }, t('companionHint')),
        body)
    }

    function OwnerSection({ data, draft, t, disabled, update, titles }) {
      const owners = draft.ownerSessions
      const setOwners = (next) => update({ ownerSessions: next })
      const chosen = new Set(draft.companionPresets)
      const presetName = new Map((data.presets ?? []).map((p) => [p.id, p.name || p.id]))
      const sessions = (data.sessions ?? []).filter((s) => chosen.has(s.preset))
        .map((s) => ({ ...s, ...titles.get(s.id) }))
        .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
      const listed = new Set(sessions.map((s) => s.id))
      const others = owners.filter((o) => isPrefix(o) || !listed.has(o))
      let list
      if (data.sessions === null) {
        list = h('p', { className: 'eng-note' }, t('sessionsUnavailable'))
      } else if (chosen.size === 0) {
        list = h('p', { className: 'eng-note' }, t('ownersNeedPreset'))
      } else if (sessions.length === 0) {
        list = h('p', { className: 'eng-note' }, t('ownersEmpty'))
      } else {
        list = h('div', { className: 'eng-list' }, sessions.map((s) => {
          const prefix = owners.find((o) => matchesPrefix(o, s.id))
          const exact = owners.includes(s.id)
          const when = new Date(s.updatedAt ?? s.createdAt)
          const sub = [presetName.get(s.preset) ?? s.preset,
            Number.isFinite(when.getTime()) && when.getTime() > 0
              ? `${t(s.updatedAt === undefined ? 'created' : 'active')} ${when.toLocaleString()}` : '',
            s.id].filter(Boolean).join(' · ')
          return h('div', { className: 'eng-row', key: s.id },
            h('span', { className: 'eng-row-main' },
              h('span', { className: 'eng-row-title', title: s.title || s.id }, s.title || s.id),
              h('span', { className: 'eng-row-sub', title: sub }, sub)),
            h('span', { className: 'eng-row-side' },
              prefix !== undefined && !exact ? `${t('byPrefix')} ${prefix}` : t('mine'),
              h(Switch, { checked: exact || prefix !== undefined, label: `${t('mine')}: ${s.title || s.id}`,
                disabled: disabled || (prefix !== undefined && !exact),
                onChange: (on) => setOwners(on ? withValue(owners, s.id) : without(owners, s.id)) })))
        }))
      }
      return h('section', { className: 'eng-section' },
        h('h3', { className: 'eng-title' }, t('owners')),
        h('p', { className: 'eng-hint' }, t('ownersHint')),
        list,
        others.length > 0 ? h('p', { className: 'eng-note' }, t('otherIds')) : null,
        h(Chips, { items: others, t, disabled, onRemove: (o) => setOwners(without(owners, o)) }),
        h(AddField, { placeholder: t('addId'), t, disabled, onAdd: (o) => setOwners(withValue(owners, o)) }))
    }

    function CapSection({ caps, t, disabled, setCaps }) {
      const field = (key, label, max) => h('label', null,
        h('input', { className: 'eng-input', inputMode: 'numeric', value: caps[key], disabled,
          'aria-invalid': capOf(caps[key], max) === undefined,
          onChange: (e) => setCaps({ ...caps, [key]: e.target.value }) }),
        label)
      return h('section', { className: 'eng-section' },
        h('h3', { className: 'eng-title' }, t('cap')),
        h('div', { className: 'eng-cap' },
          field('maxLines', t('capLines'), Number.MAX_SAFE_INTEGER), field('maxBytes', t('capBytes'), Number.MAX_SAFE_INTEGER)),
        h('p', { className: 'eng-hint' }, t('capHint')))
    }

    function SettingsForm({ t, titles }) {
      const [state, setState] = useState({ phase: 'loading' })
      const [draft, setDraft] = useState(undefined)
      const [caps, setCaps] = useState({ maxLines: String(DEFAULT_LINES), maxBytes: String(DEFAULT_BYTES) })
      const [busy, setBusy] = useState(false)
      const [banner, setBanner] = useState(undefined)
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])

      const adopt = useCallback((data) => {
        const settings = settingsOf(data)
        setState({ phase: 'ready', data, settings })
        setDraft(settings)
        setCaps({ maxLines: String(settings.maxLines), maxBytes: String(settings.maxBytes) })
      }, [])
      const load = useCallback(async () => {
        setState((s) => (s.phase === 'ready' ? s : { phase: 'loading' }))
        try {
          const data = await fetchSettings()
          if (alive.current) adopt(data)
        } catch {
          if (alive.current) setState({ phase: 'error' })
        }
      }, [adopt])
      useEffect(() => { load() }, [load])

      if (state.phase === 'loading' || draft === undefined && state.phase !== 'error') {
        return h('p', { className: 'eng-note' }, t('loading'))
      }
      if (state.phase === 'error') {
        return h('div', { className: 'eng-page' },
          h('div', { className: 'eng-banner', 'data-tone': 'error' }, t('loadFailed')),
          h('div', { className: 'eng-actions' }, h('button', { type: 'button', className: 'eng-btn', onClick: load }, t('retry'))))
      }

      const { data, settings } = state
      const editable = data.editable === true
      const disabled = !editable || busy
      const maxLines = capOf(caps.maxLines, Number.MAX_SAFE_INTEGER)
      const maxBytes = capOf(caps.maxBytes, Number.MAX_SAFE_INTEGER)
      const next = { ...draft, maxLines: maxLines ?? draft.maxLines, maxBytes: maxBytes ?? draft.maxBytes }
      const valid = maxLines !== undefined && maxBytes !== undefined
      const dirty = revisionOf(next) !== revisionOf(settings)
      const update = (patch) => { setDraft({ ...draft, ...patch }); setBanner(undefined) }

      const save = async () => {
        setBusy(true)
        setBanner(undefined)
        try {
          let result
          try {
            const response = await request({
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ revision: data.revision, ...next }),
            })
            result = response.body ?? { ok: false, error: 'failed', message: `HTTP ${response.status}` }
          } catch (error) {
            result = { ok: false, error: 'failed', message: String(error?.message ?? error) }
          }
          if (!alive.current) return
          if (result.ok) {
            // The plugin reloads with the new config; its route comes back with it.
            setBanner({ tone: 'ok', text: t('reloading') })
            const wanted = revisionOf(next)
            let fresh
            for (let i = 0; i < 20 && alive.current; i++) {
              await new Promise((resolve) => setTimeout(resolve, 400))
              try {
                fresh = await fetchSettings()
                if (revisionOf(settingsOf(fresh)) === wanted) break
              } catch { /* still reloading */ }
            }
            if (!alive.current) return
            if (fresh !== undefined) adopt(fresh)
            // The save landed either way; say so plainly when what came back differs.
            setBanner(fresh !== undefined && revisionOf(settingsOf(fresh)) === wanted
              ? { tone: 'ok', text: t('saved') }
              : { tone: 'error', text: t('savedUnconfirmed') })
          } else if (result.error === 'stale') {
            await load()
            if (alive.current) setBanner({ tone: 'error', text: t('stale') })
          } else if (result.error === 'overridden') {
            setBanner({ tone: 'error', text: t('overridden') })
          } else if (result.error === 'invalid') {
            setBanner({ tone: 'error', text: t('invalid') + (result.field ?? '') })
          } else if (result.error === 'unavailable') {
            setBanner({ tone: 'error', text: t('unavailable') })
          } else {
            setBanner({ tone: 'error', text: t('failed') + (result.message ?? '') })
          }
        } finally {
          if (alive.current) setBusy(false)
        }
      }
      const discard = () => {
        setDraft(settings)
        setCaps({ maxLines: String(settings.maxLines), maxBytes: String(settings.maxBytes) })
        setBanner(undefined)
      }

      return h('div', { className: 'eng-page' },
        editable ? null : h('div', { className: 'eng-banner' },
          t(data.readOnly === 'expression' ? 'expression' : 'unavailable')),
        h(LanguageSection, { draft, t, disabled, update }),
        h(PresetSection, { data, draft, t, disabled, update }),
        h(OwnerSection, { data, draft, t, disabled, update,
          titles: typeof titles === 'function' ? titles() : new Map() }),
        h(CapSection, { caps, t, disabled, setCaps }),
        banner ? h('div', { className: 'eng-banner', 'data-tone': banner.tone, role: 'status' }, banner.text) : null,
        editable ? h('div', { className: 'eng-actions' },
          h('button', { type: 'button', className: 'eng-btn eng-btn-primary', disabled: busy || !dirty || !valid, onClick: save },
            busy ? t('saving') : t('save')),
          h('button', { type: 'button', className: 'eng-btn', disabled: busy || !dirty, onClick: discard }, t('discard')))
          : null)
    }

    function SettingsPage(props) {
      if (props.view === 'summary') return props.t('summary')
      return h(SettingsForm, props)
    }

    /** Session titles and last activity from the page's own session list, when it has one. */
    function sessionTitles(ctx) {
      return () => {
        const titles = new Map()
        try {
          const byId = ctx.get('sessions')?.list?.getSnapshot?.()?.byId ?? {}
          for (const [id, row] of Object.entries(byId)) {
            titles.set(id, {
              ...(typeof (row?.title ?? row?.displayTitle) === 'string' ? { title: row.title ?? row.displayTitle } : {}),
              ...(Number.isFinite(row?.updatedAt) ? { updatedAt: row.updatedAt } : {}),
            })
          }
        } catch { /* no session list on this page: ids are shown instead */ }
        return titles
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-engramory: dictionaries')
        ctx.effect(() => {
          const tag = document.createElement('style')
          tag.dataset.plugin = 'dsh-engramory'
          tag.dataset.pluginCss = 'dsh-engramory/settings.css'
          tag.textContent = CSS
          document.head.appendChild(tag)
          return () => tag.remove()
        }, 'dsh-engramory: styles')
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: ROW,
          locale: NS,
          inject: () => ({ titles: sessionTitles(ctx) }),
        }, SettingsPage))
      },
    }
  },
})

/**
 * dsh-engramory, browser half: the settings on the package's own page in the Plugins page,
 * and the sidebar's Memory entry — a page listing the memory stores by name, with the two
 * settings that matter most at its top. The settings go through the route index.js
 * registers for them (the memory's language follows dsh's); the page lists the stores and
 * opens a note in the desktop's own app through the memory route, so no note's text is
 * ever read into the page.
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
    /** The Plugins page keys a package's own settings by its package name. */
    const PACKAGE = 'dsh-engramory'
    /** The sidebar entry and the main-column page it opens share this id. */
    const PANEL = 'engramory'
    /** Relative to the page, as dsh's own pages fetch, so a mounted deployment keeps its prefix. */
    const SETTINGS_API = 'api/engramory/settings'
    const MEMORY_API = 'api/engramory/memory'
    const DEFAULT_LINES = 200
    const DEFAULT_BYTES = 25600
    /** The order the memory page shows note types in (SKILL.md §2, §2.2). */
    const TYPES = ['user', 'feedback', 'project', 'reference', 'moment', 'upcoming', 'self', 'other']

    const zh = {
      summary: '大肥鱼模式和记忆权限、索引上限。',
      loading: '正在读取设置…',
      loadFailed: '读不到设置。',
      retry: '重试',
      unavailable: '这个 dsh 不能在页面里保存这些设置（没有配置编辑服务）。请改配置文件 cordis.patch.yml，写法见插件说明。',
      expression: '配置文件里有设置是用 !!js 表达式写的，这里显示不了它的实际值，所以只读。请直接改 cordis.patch.yml。',
      companion: '大肥鱼模式',
      companionHint: '多记三类：经历、约定、我自己，用角色口吻回忆。',
      audience: '记忆权限',
      audiencePrivate: '专属',
      audienceSocial: '社交',
      audiencePrivateHint: '只有你用这个 dsh：每个对话都能用记忆。',
      audienceSocialHint: '别人也能跟你的 AI 聊（接了 QQ、微信等）：只有你本人聊、没有别人插过话的对话能用记忆。',
      cap: '索引上限',
      capHint: '默认 200 行 / 25600 字节，超过后 AI 要先压缩才能再写。',
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
      panel: '记忆',
      memoryIntro: 'AI 自己记下的东西，这里只看不改。点名字用电脑上的默认程序打开。',
      memoryIntroNoOpen: 'AI 自己记下的东西，这里只看不改。',
      refresh: '刷新',
      stripNote: '说明和索引上限在「插件 → Engramory 记忆」。',
      stripReadOnly: '这里改不了，见「插件 → Engramory 记忆」。',
      listing: '正在读取记忆…',
      listFailed: '读不到记忆库。',
      listTimeout: '读取超时了，可能有工作区在连不上的网络盘上。稍后点刷新再试。',
      empty: '还没有记忆。AI 第一次存记忆时会自动建好记忆库。',
      pinnedRelative: '配置里固定的索引（indexPath）是相对路径，跟着每个会话的目录走，这里列不出来。改成绝对路径就能在这里看到。',
      storeUser: '全局记忆',
      storePinned: '固定的记忆库',
      usage: '{lines} / {maxLines} 行 · {size} / {maxSize}',
      usageOver: '{size} / {maxSize}，超出上限',
      usageSize: '{size} / {maxSize}',
      sizeBytes: '{n} B',
      sizeKB: '{n} KB',
      overHint: '超出上限了，AI 只读得到前面一部分，该压缩了。',
      noIndex: '还没有索引',
      openIndex: '打开索引',
      openFolder: '打开文件夹',
      opened: '已打开 {name}。',
      openUnavailable: '这台 dsh 不能在本机打开文件（比如远程访问时）。文件在上面写的位置。',
      openMissing: '找不到这个文件了，可能刚被改名或删掉。点刷新看看。',
      openBusy: '还在打开上一个，稍等一下再点。',
      openFailed: '打不开：{reason}',
      typeUser: '用户',
      typeFeedback: '反馈',
      typeProject: '项目',
      typeReference: '参考',
      typeMoment: '经历',
      typeUpcoming: '约定',
      typeSelf: '我自己',
      typeOther: '其他',
      group: '{type} · {count}',
      archive: '归档（{count}）',
      more: '文件太多，这里只列出了一部分。',
    }
    const en = {
      summary: 'Companion mode and memory access, and the index cap.',
      loading: 'Reading the settings…',
      loadFailed: 'Could not read the settings.',
      retry: 'Retry',
      unavailable: 'This dsh cannot save these settings from a page (it has no config editor). Edit cordis.patch.yml instead; the plugin README shows how.',
      expression: 'A setting in the config is written as a !!js expression, whose value this page cannot show, so it is read-only. Edit cordis.patch.yml directly.',
      companion: 'Companion mode (大肥鱼模式)',
      companionHint: 'Keeps three more kinds of note — moments, plans, the character itself — and recalls in character.',
      audience: 'Memory access',
      audiencePrivate: 'Private',
      audienceSocial: 'Social',
      audiencePrivateHint: 'Only you use this dsh: every conversation gets the memory.',
      audienceSocialHint: 'Others can talk to your AI too (through QQ, WeChat…): only conversations you alone have written in get the memory.',
      cap: 'Index cap',
      capHint: 'Default 200 lines / 25600 bytes; past it the AI must compact before writing more.',
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
      panel: 'Memory',
      memoryIntro: 'What the AI has noted down for itself — to look at, not to edit. Click a name to open it in your computer\'s default app.',
      memoryIntroNoOpen: 'What the AI has noted down for itself — to look at, not to edit.',
      refresh: 'Refresh',
      stripNote: 'Explanations and the index cap: Plugins → Engramory memory.',
      stripReadOnly: 'Cannot be changed here; see Plugins → Engramory memory.',
      listing: 'Reading the memory…',
      listFailed: 'Could not read the memory stores.',
      listTimeout: 'Reading took too long — a workspace may be on a network drive that does not answer. Refresh to try again.',
      empty: 'No memory yet. The store is created the first time the AI saves something.',
      pinnedRelative: 'The pinned index (indexPath) is a relative path, which follows each conversation\'s directory, so it cannot be listed here. Pin an absolute path to see it here.',
      storeUser: 'Global memory',
      storePinned: 'Pinned store',
      usage: '{lines} / {maxLines} lines · {size} / {maxSize}',
      usageOver: '{size} / {maxSize}, over the cap',
      usageSize: '{size} / {maxSize}',
      sizeBytes: '{n} B',
      sizeKB: '{n} KB',
      overHint: 'Over the cap: the AI reads only the first part. Time to compact it.',
      noIndex: 'No index yet',
      openIndex: 'Open the index',
      openFolder: 'Open the folder',
      opened: 'Opened {name}.',
      openUnavailable: 'This dsh cannot open files on its own computer (when reached remotely, say). The files are where the path above says.',
      openMissing: 'That file is gone — renamed or deleted just now, perhaps. Refresh to see.',
      openBusy: 'Still opening the previous one — click again in a moment.',
      openFailed: 'Could not open it: {reason}',
      typeUser: 'User',
      typeFeedback: 'Feedback',
      typeProject: 'Project',
      typeReference: 'Reference',
      typeMoment: 'Moments',
      typeUpcoming: 'Coming up',
      typeSelf: 'Myself',
      typeOther: 'Other',
      group: '{type} · {count}',
      archive: 'Archive ({count})',
      more: 'Too many files: only some are listed here.',
    }

    const CSS = `
.eng-page{display:flex;flex-direction:column;gap:18px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);max-width:760px;}
.eng-section{display:flex;flex-direction:column;gap:8px;}
.eng-title{font-size:14px;font-weight:600;margin:0;}
.eng-heading{display:flex;align-items:center;gap:10px;}
.eng-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);}
.eng-note{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);}
.eng-banner{padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:12px;}
.eng-banner[data-tone="error"]{color:var(--dsw-alias-state-error-primary);}
.eng-banner[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);}
.eng-segment{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);align-self:flex-start;}
.eng-segment button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:4px 12px;font:inherit;font-size:12px;cursor:pointer;}
.eng-segment button[aria-pressed="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12);}
.eng-segment button:disabled{cursor:default;}
.eng-switch{position:relative;width:32px;height:18px;border-radius:999px;border:0;padding:0;cursor:pointer;background:var(--dsw-alias-border-l2);flex:none;}
.eng-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);}
.eng-switch:disabled{opacity:.5;cursor:default;}
.eng-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-switch-thumb,#fff);transition:transform .15s ease;}
.eng-switch[aria-checked="true"]::after{transform:translateX(14px);}
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
.eng-memory{box-sizing:border-box;height:100%;overflow:auto;display:flex;flex-direction:column;align-items:center;gap:24px;padding:0 clamp(24px,4vw,48px) 48px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;}
.eng-memory>*{width:100%;max-width:960px;}
.eng-memory-head{box-sizing:border-box;display:flex;justify-content:space-between;align-items:flex-start;gap:16px;flex-wrap:wrap;padding-top:28px;}
[data-platform=darwin] .eng-memory-head{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));}
.eng-memory-title{margin:0;font-size:20px;font-weight:500;line-height:28px;}
.eng-memory-intro{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;}
.eng-strip{box-sizing:border-box;display:flex;align-items:center;flex-wrap:wrap;gap:8px 20px;padding:10px 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px);}
.eng-strip-item{display:inline-flex;align-items:center;gap:8px;}
.eng-strip-note{flex:1 1 200px;margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);}
.eng-store{display:flex;flex-direction:column;gap:12px;padding-top:20px;border-top:.5px solid var(--dsw-alias-border-l2);}
.eng-store-head{display:flex;align-items:center;gap:6px 12px;flex-wrap:wrap;}
.eng-store-title{margin:0;font-size:14px;font-weight:500;line-height:22px;}
.eng-usage{font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;}
.eng-usage[data-over="true"]{color:var(--dsw-alias-state-error-primary);}
.eng-store-actions{margin-left:auto;display:inline-flex;gap:8px;}
.eng-path{margin:-8px 0 0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;}
.eng-group{display:flex;flex-direction:column;gap:2px;}
.eng-group-title{margin:0;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary);}
.eng-names{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:0 12px;margin:0 -8px;padding:0;list-style:none;}
.eng-name{display:block;box-sizing:border-box;width:100%;text-align:left;border:0;background:transparent;color:inherit;font:inherit;font-size:13px;line-height:20px;padding:3px 8px;border-radius:var(--dsw-radius-sm,6px);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
button.eng-name{cursor:pointer;}
button.eng-name:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
button.eng-name:disabled{cursor:default;opacity:.6;}
.eng-name:focus-visible,.eng-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
.eng-archive>summary{cursor:pointer;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.eng-archive[open]>summary{margin-bottom:2px;}
`

    /** The settings the page edits, in the order the host computes its revision from. */
    const settingsOf = (data) => ({
      companion: data.companion === true,
      audience: data.audience === 'social' ? 'social' : 'private',
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

    /** fetch with a deadline: a request the host never answers must not hold the page busy. */
    async function request(url, init = {}) {
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), 15000)
      try {
        const response = await fetch(url, { cache: 'no-store', ...init, signal: deadline.signal,
          headers: { accept: 'application/json', ...(init.headers ?? {}) } })
        // the body is read under the same deadline: headers alone do not finish a request
        const body = await response.json().catch(() => undefined)
        return { ok: response.ok, status: response.status, body }
      } finally {
        clearTimeout(timer)
      }
    }

    async function fetchSettings() {
      const response = await request(SETTINGS_API)
      if (!response.ok || response.body === undefined) throw new Error(`HTTP ${response.status}`)
      return response.body
    }

    /**
     * The settings as the host has them, and a save that waits for the reloaded plugin to
     * read them back. `onAdopt` hears every settings read, a save's included.
     */
    function useSettings(t, onAdopt) {
      const [state, setState] = useState({ phase: 'loading' })
      const [busy, setBusy] = useState(false)
      const [banner, setBanner] = useState(undefined)
      const alive = useRef(true)
      // a second click before the page re-renders as busy must not send a second save
      const saving = useRef(false)
      useEffect(() => () => { alive.current = false }, [])

      const adopt = useCallback((data) => {
        const settings = settingsOf(data)
        setState({ phase: 'ready', data, settings })
        onAdopt?.(settings)
      }, [onAdopt])
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

      const save = async (next) => {
        if (saving.current) return
        saving.current = true
        setBusy(true)
        setBanner(undefined)
        try {
          let result
          try {
            const response = await request(SETTINGS_API, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ revision: state.data.revision, ...next }),
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
          } else if (result.error === 'expression') {
            // the profile changed under the page: read it again, which makes the page read-only
            await load()
            if (alive.current) setBanner({ tone: 'error', text: t('expression') })
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
          saving.current = false
          if (alive.current) setBusy(false)
        }
      }
      return { state, busy, banner, setBanner, load, save }
    }

    /** A host-styled switch: role=switch with aria-checked, as the host's own. */
    function Switch({ checked, disabled, label, onChange }) {
      return h('button', {
        type: 'button', role: 'switch', className: 'eng-switch', 'aria-checked': checked,
        'aria-label': label, disabled, onClick: () => onChange(!checked),
      })
    }

    /** A host-styled two-way choice: buttons with aria-pressed in one group. */
    function Segment({ label, value, options, disabled, onChange }) {
      return h('div', { className: 'eng-segment', role: 'group', 'aria-label': label },
        options.map(([key, text]) => h('button', {
          type: 'button', key, 'aria-pressed': value === key, disabled, onClick: () => onChange(key),
        }, text)))
    }

    function CompanionSection({ draft, t, disabled, update }) {
      return h('section', { className: 'eng-section' },
        h('div', { className: 'eng-heading' },
          h('h3', { className: 'eng-title' }, t('companion')),
          h(Switch, { checked: draft.companion, disabled, label: t('companion'),
            onChange: (on) => update({ companion: on }) })),
        h('p', { className: 'eng-hint' }, t('companionHint')))
    }

    function AudienceSection({ draft, t, disabled, update }) {
      return h('section', { className: 'eng-section' },
        h('h3', { className: 'eng-title' }, t('audience')),
        h(Segment, { label: t('audience'), value: draft.audience, disabled,
          options: [['private', t('audiencePrivate')], ['social', t('audienceSocial')]],
          onChange: (audience) => update({ audience }) }),
        h('p', { className: 'eng-hint' }, t(draft.audience === 'social' ? 'audienceSocialHint' : 'audiencePrivateHint')))
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

    /** The whole form, with what each setting means: the package's page in the Plugins page. */
    function SettingsForm({ t }) {
      const [draft, setDraft] = useState(undefined)
      const [caps, setCaps] = useState({ maxLines: String(DEFAULT_LINES), maxBytes: String(DEFAULT_BYTES) })
      const onAdopt = useCallback((settings) => {
        setDraft(settings)
        setCaps({ maxLines: String(settings.maxLines), maxBytes: String(settings.maxBytes) })
      }, [])
      const { state, busy, banner, setBanner, load, save } = useSettings(t, onAdopt)

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
      const discard = () => {
        setDraft(settings)
        setCaps({ maxLines: String(settings.maxLines), maxBytes: String(settings.maxBytes) })
        setBanner(undefined)
      }

      return h('div', { className: 'eng-page' },
        editable ? null : h('div', { className: 'eng-banner' },
          t(data.readOnly === 'expression' ? 'expression' : 'unavailable')),
        h(CompanionSection, { draft, t, disabled, update }),
        // memory access is a choice inside companion mode: off, it changes nothing
        draft.companion ? h(AudienceSection, { draft, t, disabled, update }) : null,
        h(CapSection, { caps, t, disabled, setCaps }),
        banner ? h('div', { className: 'eng-banner', 'data-tone': banner.tone, role: 'status' }, banner.text) : null,
        editable ? h('div', { className: 'eng-actions' },
          h('button', { type: 'button', className: 'eng-btn eng-btn-primary', disabled: busy || !dirty || !valid, onClick: () => save(next) },
            busy ? t('saving') : t('save')),
          h('button', { type: 'button', className: 'eng-btn', disabled: busy || !dirty, onClick: discard }, t('discard')))
          : null)
    }

    function SettingsPage(props) {
      if (props.view === 'summary') return props.t('summary')
      return h(SettingsForm, props)
    }

    /**
     * The two settings that matter most, atop the memory page, each saved as it is switched;
     * what they mean, and the index cap, stay on the package's page.
     */
    function SettingsStrip({ t }) {
      const { state, busy, banner, load, save } = useSettings(t)
      if (state.phase === 'error') {
        return h('section', { className: 'eng-strip' },
          h('p', { className: 'eng-strip-note' }, t('loadFailed')),
          h('button', { type: 'button', className: 'eng-btn', onClick: load }, t('retry')))
      }
      if (state.phase !== 'ready') return null
      const { data, settings } = state
      const disabled = data.editable !== true || busy
      const change = (patch) => save({ ...settings, ...patch })
      return h('section', { className: 'eng-strip' },
        h('div', { className: 'eng-strip-item' },
          h('span', null, t('companion')),
          h(Switch, { checked: settings.companion, disabled, label: t('companion'),
            onChange: (on) => change({ companion: on }) })),
        // memory access is a choice inside companion mode: off, it changes nothing
        settings.companion ? h('div', { className: 'eng-strip-item' },
          h('span', null, t('audience')),
          h(Segment, { label: t('audience'), value: settings.audience, disabled,
            options: [['private', t('audiencePrivate')], ['social', t('audienceSocial')]],
            onChange: (audience) => { if (audience !== settings.audience) change({ audience }) } })) : null,
        h('p', { className: 'eng-strip-note', role: banner ? 'status' : undefined },
          busy ? t('saving') : banner ? banner.text : t(data.editable === true ? 'stripNote' : 'stripReadOnly')))
    }

    /** The memory route's listing, read again on `load`; a reply that a later read overtook is dropped. */
    function useMemory() {
      const [state, setState] = useState({ phase: 'loading' })
      const alive = useRef(true)
      const generation = useRef(0)
      useEffect(() => () => { alive.current = false }, [])
      const load = useCallback(async () => {
        const mine = ++generation.current
        setState((s) => (s.phase === 'ready' ? s : { phase: 'loading' }))
        let next
        try {
          const response = await request(MEMORY_API)
          next = response.ok && Array.isArray(response.body?.stores)
            ? { phase: 'ready', data: response.body }
            : { phase: 'error', reason: response.status === 503 ? 'listTimeout' : 'listFailed' }
        } catch {
          next = { phase: 'error', reason: 'listFailed' }
        }
        if (alive.current && mine === generation.current) setState(next)
      }, [])
      useEffect(() => { load() }, [load])
      return { state, load }
    }

    /** What the page says for each way the memory route declines to open a file. */
    const OPEN_FAILURES = {
      unavailable: 'openUnavailable', missing: 'openMissing', busy: 'openBusy', timeout: 'listTimeout',
    }
    const nameOf = (file) => file.replace(/\.md$/i, '')
    const sizeOf = (t, bytes) => (bytes < 1024 ? t('sizeBytes', { n: bytes }) : t('sizeKB', { n: (bytes / 1024).toFixed(1) }))
    const typeKey = (type) => `type${type[0].toUpperCase()}${type.slice(1)}`
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    const byName = (a, b) => collator.compare(a, b)

    /** One store: where it is, how full its index is, and its notes' names by type. */
    function StoreSection({ store, cap, canOpen, open, t }) {
      const title = store.kind === 'user' ? [t('storeUser'), ...store.titles].join(' · ')
        : store.kind === 'pinned' ? [t('storePinned'), ...store.titles].join(' · ')
          : store.titles.join(' · ')
      const { index } = store
      const sizes = index === null ? {} : { size: sizeOf(t, index.bytes), maxSize: sizeOf(t, cap.maxBytes) }
      // lines are counted only for an index read whole; past that, its bytes say over or not
      const usage = index === null ? t('noIndex')
        : index.lines !== undefined ? t('usage', { lines: index.lines, maxLines: cap.maxLines, ...sizes })
          : t(index.over ? 'usageOver' : 'usageSize', sizes)
      const names = (list, archive) => h('ul', { className: 'eng-names' },
        [...list].sort(byName).map((file) => h('li', { key: file },
          canOpen
            ? h('button', { type: 'button', className: 'eng-name', title: file,
              onClick: () => open(store, file, archive) }, nameOf(file))
            : h('span', { className: 'eng-name', title: file }, nameOf(file)))))
      const groups = TYPES.map((type) => [type, store.notes.filter((note) => note.type === type).map((note) => note.name)])
        .filter(([, list]) => list.length > 0)
      return h('section', { className: 'eng-store' },
        h('div', { className: 'eng-store-head' },
          h('h2', { className: 'eng-store-title' }, title),
          h('span', { className: 'eng-usage', 'data-over': index?.over === true, title: index?.over ? t('overHint') : undefined }, usage),
          // the folder is shown with its index selected: no index, no folder to show
          canOpen && index !== null ? h('div', { className: 'eng-store-actions' },
            h('button', { type: 'button', className: 'eng-btn',
              onClick: () => open(store, index.name, false) }, t('openIndex')),
            h('button', { type: 'button', className: 'eng-btn', onClick: () => open(store, undefined, false) },
              t('openFolder'))) : null),
        h('p', { className: 'eng-path' }, store.dir),
        index?.over ? h('p', { className: 'eng-note' }, t('overHint')) : null,
        ...groups.map(([type, list]) => h('div', { className: 'eng-group', key: type },
          h('h3', { className: 'eng-group-title' }, t('group', { type: t(typeKey(type)), count: list.length })),
          names(list, false))),
        store.archive.length > 0 ? h('details', { className: 'eng-archive' },
          h('summary', null, t('archive', { count: store.archive.length })),
          names(store.archive, true)) : null,
        store.more ? h('p', { className: 'eng-note' }, t('more')) : null)
    }

    /** The sidebar's Memory page: the stores recall can use, by name, and two settings. */
    function MemoryPage({ t }) {
      const { state, load } = useMemory()
      const [status, setStatus] = useState(undefined)
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])

      const open = async (store, file, archive) => {
        setStatus(undefined)
        let reply
        try {
          const response = await request(MEMORY_API, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ store: store.id, ...(file === undefined ? {} : { file }), ...(archive ? { archive: true } : {}) }),
          })
          reply = response.body ?? { ok: false, error: 'failed', message: `HTTP ${response.status}` }
        } catch (error) {
          reply = { ok: false, error: 'failed', message: String(error?.message ?? error) }
        }
        if (!alive.current) return
        setStatus(reply.ok ? { tone: 'ok', text: t('opened', { name: file === undefined ? store.dir : nameOf(file) }) }
          : Object.hasOwn(OPEN_FAILURES, reply.error) ? { tone: 'error', text: t(OPEN_FAILURES[reply.error]) }
            : { tone: 'error', text: t('openFailed', { reason: reply.message ?? reply.error ?? '' }) })
      }

      const data = state.phase === 'ready' ? state.data : undefined
      const canOpen = data?.canOpen === true
      let body
      if (state.phase === 'loading') body = h('p', { className: 'eng-note' }, t('listing'))
      else if (state.phase === 'error') body = h('div', { className: 'eng-banner', 'data-tone': 'error' }, t(state.reason))
      else {
        body = [
          data.pinned === 'relative' ? h('p', { className: 'eng-note', key: 'pinned' }, t('pinnedRelative')) : null,
          data.stores.length === 0 && data.pinned === undefined ? h('p', { className: 'eng-note', key: 'empty' }, t('empty')) : null,
          ...data.stores.map((store) => h(StoreSection, { key: store.id, store, cap: data.cap, canOpen, open, t })),
          data.more ? h('p', { className: 'eng-note', key: 'more' }, t('more')) : null,
        ]
      }
      return h('div', { className: 'eng-memory' },
        h('header', { className: 'eng-memory-head' },
          h('div', null,
            h('h1', { className: 'eng-memory-title' }, t('panel')),
            h('p', { className: 'eng-memory-intro' }, t(data !== undefined && !canOpen ? 'memoryIntroNoOpen' : 'memoryIntro'))),
          h('button', { type: 'button', className: 'eng-btn', onClick: () => { setStatus(undefined); load() } }, t('refresh'))),
        h(SettingsStrip, { t }),
        status ? h('div', { className: 'eng-banner', 'data-tone': status.tone, role: 'status' }, status.text) : null,
        data !== undefined && !canOpen && data.stores.length > 0 ? h('p', { className: 'eng-note' }, t('openUnavailable')) : null,
        body)
    }

    /** The sidebar entry's icon: a book, drawn in the row's own colour at the size it asks for. */
    function MemoryIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M6 3.5h11.5v14H7.25A1.75 1.75 0 0 0 5.5 19.25V5A1.5 1.5 0 0 1 6 3.5z' }),
      h('path', { d: 'M5.5 19.25A1.75 1.75 0 0 0 7.25 21h10.25v-3.5' }),
      h('path', { d: 'M9 8h5.5M9 11h3.5' }))
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
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PACKAGE,
          locale: NS,
        }, SettingsPage))
        const t = ctx.locale.bind(NS)
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL,
          locale: NS,
        }, MemoryPage))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL,
          // after dsh's own entries (Plugins 0, Automations 10)
          order: 20,
          locale: NS,
          label: () => t('panel'),
        }, MemoryIcon))
      },
    }
  },
})

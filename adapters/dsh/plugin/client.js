/**
 * dsh-engramory, browser half: the settings page behind the Configure control on the
 * Plugins page. It edits the language, companion mode (大肥鱼模式) and the index cap
 * through the route index.js registers.
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
      summary: '记忆用哪种语言写、大肥鱼模式，以及索引上限。',
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
      companionHint: '别人也能跟你的 AI 聊天时打开，比如接了 QQ、微信、抖音。打开后，只有你在 dsh 窗口里亲手发过消息、又没有别人说过话的对话，才用得上你的记忆；接入插件转进来的、外部程序和自动化任务开的对话都算别人的，一点记忆都拿不到。只有你自己用，就保持关闭。',
      companionNote: '一段对话里只要出现过别人的消息，就一直算别人的。接入插件可以按 Engramory 的标准把你本人的消息标出来（比如你自己的 QQ 私聊），写法见插件说明。',
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
      summary: 'Which language the memory is written in, companion mode (大肥鱼模式), and the index cap.',
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
      companionHint: 'Turn it on when other people can talk to your AI too — through QQ, WeChat or Douyin, say. Then only a conversation you have written in, in dsh’s own window, and nobody else has, gets your memory; one a chat bridge, a program or an automation opened counts as someone else’s and gets none of it. If only you use this dsh, leave it off.',
      companionNote: 'A conversation stays someone else’s once anyone else has written in it. A chat bridge can mark your own messages (your own QQ chat, say) by the Engramory standard the plugin README describes.',
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
.eng-heading{display:flex;align-items:center;gap:10px;}
.eng-hint{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);}
.eng-note{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary);}
.eng-banner{padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);font-size:12px;}
.eng-banner[data-tone="error"]{color:var(--dsw-alias-state-error-primary);}
.eng-banner[data-tone="ok"]{color:var(--dsw-alias-state-success-primary);}
.eng-segment{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);align-self:flex-start;}
.eng-segment button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;padding:4px 12px;font:inherit;font-size:12px;cursor:pointer;}
.eng-segment button[aria-pressed="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12);}
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
`

    /** The settings the page edits, in the order the host computes its revision from. */
    const settingsOf = (data) => ({
      language: data.language === 'zh' ? 'zh' : 'en',
      companion: data.companion === true,
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

    function CompanionSection({ draft, t, disabled, update }) {
      return h('section', { className: 'eng-section' },
        h('div', { className: 'eng-heading' },
          h('h3', { className: 'eng-title' }, t('companion')),
          h(Switch, { checked: draft.companion, disabled, label: t('companion'),
            onChange: (on) => update({ companion: on }) })),
        h('p', { className: 'eng-hint' }, t('companionHint')),
        h('p', { className: 'eng-note' }, t('companionNote')))
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

    function SettingsForm({ t }) {
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
        h(CompanionSection, { draft, t, disabled, update }),
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
        }, SettingsPage))
      },
    }
  },
})

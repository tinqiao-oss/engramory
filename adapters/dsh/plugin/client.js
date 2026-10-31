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
    /** This plugin's version, for the feedback footer; a test keeps it equal to package.json's. */
    const VERSION = '1.1.0'
    /** Where feedback goes: a new issue on the repository, or the project's mailbox. Opening
     * the link is the browser's (the desktop app hands it to the system's); the footer submits
     * nothing by itself. */
    const ISSUES = 'https://github.com/tinqiao-oss/engramory/issues/new'
    const EMAIL = 'engramory@agent.qq.com'
    /** The how-to's lines, in order. */
    const HOW_TO = ['howToSay', 'howToRecall', 'howToEdit', 'howToMove', 'howToSocial']
    /** A note past this is almost always a timeline under one slug (SKILL.md: "A note has a size
     * too"); the doctor warns at the same size (ENGRAMORY_NOTE_WARN_BYTES). */
    const LARGE_NOTE = 12 * 1024
    /** An `upcoming` note named with its date: `2026-10-31-interview`, `2026-10-31面试` (SKILL.md §2.2). */
    const DATED = /^(\d{4})-(\d{2})-(\d{2})(?!\d)/
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
      panelTitle: 'Engramory 记忆',
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
      healthTitle: '体检',
      healthOk: '体检：没发现问题。',
      healthBroken: '索引里指向不存在的文件（{count}）',
      healthBrokenMore: '索引里指向不存在的文件（{count} 个以上）',
      healthBrokenUnlisted: '索引里有指向不存在的文件，太多了，这里没列出。',
      healthUnindexed: '不在索引里（{count}）：AI 回忆从索引开始，这些它通常找不到，除非别的笔记链到它们。',
      healthUntyped: '没写类型或类型不认识（{count}），列在「其他」里。',
      healthFix: '可以点上面的「复制整理指令」，粘贴进对话让 AI 整理。完整检查用 engramory_doctor.py。',
      healthLarge: '要核对的太多，没做体检。',
      healthUnreadable: '有文件读不了，没做体检。',
      healthPartial: '文件太多没列全，没做体检。',
      howTo: '怎么用',
      howToSay: '想让 AI 记住什么，直接跟它说，比如「记住：我习惯用 pnpm」「把这个决定记下来」。平时它也会尽量自己挑值得长期记住的记下来，比如你纠正过它的做法。',
      howToRecall: '默认每次对话都会带上记忆的目录（索引），AI 用到细节时再打开那条笔记，不用你提醒。',
      howToEdit: '这里列出读得到的记忆，打开笔记就能直接改；想让 AI 忘掉什么，跟它说「忘掉……」就行。',
      howToMove: '记忆是存在运行 dsh 那台电脑上的普通 markdown 文件，位置写在每个库的标题下面。换电脑时把那个文件夹拷到新电脑的同一位置；在配置里指定过位置的，配置也一起带过去。',
      howToSocial: '接了 QQ、微信等、别人也能跟你的 AI 聊的话，在上面打开「大肥鱼模式」，再把「记忆权限」改成「社交」：只有认得出是你本人的对话才拿得到记忆。这不是安全隔离，详见插件说明。',
      feedbackLead: '遇到问题或有建议：',
      feedbackIssue: '到 GitHub 提 issue',
      feedbackMail: '，或发邮件到',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制不了，请手动选中上面的地址。',
      feedbackNote: '邮件会由 AI 助手协助整理，issue 是公开的，两处都别把记忆内容原样贴上去。插件版本 {version}。',
      issueBody: '（写下遇到的问题或建议）\n\n---\ndsh-engramory {version}\n打开这个页面的电脑：{os}\ndsh 版本：',
      overview: '概览',
      statsNotes: '笔记 {notes} 条 · 归档文件 {archive} 个',
      listSep: '，',
      statsUpcoming: '约定：日期已过、结果待确认 {past} · 今天及以后 {ahead} · 未定日期 {undated}',
      statsLarge: '超过 12 KB 的笔记 {count} 篇，建议拆分',
      statsReadAt: '读取于 {time}，约定按那时的日期算，点刷新更新。',
      statsPartial: '列表太长，只列出了一部分，这些数字偏少。',
      statsUnreadable: '有 {count} 处可能存放记忆库的位置没读到（读不了或查不了），没算在内。',
      statsIncomplete: '有的库里有文件读不了，这些数字可能偏少。',
      upcomingTitle: '约定',
      upcomingPast: '日期已过，结果待确认',
      upcomingToday: '就是今天',
      upcomingTomorrow: '明天',
      upcomingSoon: '还有 {days} 天',
      upcomingUndated: '未定日期',
      filterLabel: '筛选笔记',
      filterPlaceholder: '按名字筛选',
      filterCount: '匹配 {count} 条（只在已列出的笔记里找）',
      filterNone: '这个库里没有匹配的笔记。',
      largeNotes: '超过 12 KB 的笔记（{count}）：一条笔记该只记一件事，可以让 AI 拆成几篇。',
      tidyCopy: '复制整理指令',
      tidyCopied: '已复制，粘贴进对话发给 AI',
      tidyFailed: '复制不了，请手动选中下面的指令：',
      tidyPrompt: '请按 Engramory 的记忆规则整理这个记忆库：{dir}\n- 索引里指向不存在文件的链接：找得到对应笔记的就改对，确实没有了的只删这个链接；一行里没有别的有效链接了，才删掉整行。\n- 不在索引里的笔记：以后回忆用得上的补进索引，过时的移进 archive/ 或删掉；不要为了补齐全部加进去。\n- 没写类型的笔记补上 type。\n- 索引超出上限就先压缩：合并重复，细节挪回笔记，索引只留指针。\n- 超过约 12 KB 的笔记，按规则拆成几篇。\n- 日期已过的约定别删，问到结果再改写成经历。\n改完再看一遍索引有没有超出上限，然后告诉我改了什么。',
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
      panelTitle: 'Engramory memory',
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
      healthTitle: 'Check-up',
      healthOk: 'Check-up: nothing to fix.',
      healthBroken: 'The index points to files that are not there ({count})',
      healthBrokenMore: 'The index points to files that are not there (over {count})',
      healthBrokenUnlisted: 'The index points to files that are not there: too many to list here.',
      healthUnindexed: 'Not in the index ({count}): recall starts from the index, so the AI will not find these unless another note links to them.',
      healthUntyped: 'No type, or one it does not know ({count}), listed under Other.',
      healthFix: 'Copy the tidy-up instructions above and paste them into a conversation for the AI to tidy this up. For a full check, run engramory_doctor.py.',
      healthLarge: 'Too much to check here, so no check-up.',
      healthUnreadable: 'Some files could not be read, so no check-up.',
      healthPartial: 'Too many files to list them all, so no check-up here.',
      howTo: 'How to use it',
      howToSay: 'To have the AI remember something, just tell it: "remember that I use pnpm", "note this decision down". It also tries to keep what is worth keeping on its own, such as a way of working you corrected.',
      howToRecall: 'By default every conversation carries the memory\'s table of contents (the index), and the AI opens a note when it needs the details; you do not have to remind it.',
      howToEdit: 'The memory this page can read is listed here; open a note to edit it. To have the AI forget something, tell it "forget …".',
      howToMove: 'The memory is plain markdown files on the computer dsh runs on, in the folder shown under each store\'s title. On a new computer, copy that folder to the same place, and if your configuration names where the store is, bring that setting along.',
      howToSocial: 'If others can talk to your AI too (through QQ, WeChat and the like), turn on Companion mode above and set Memory access to Social: only conversations it can tell are yours get the memory. This is not a security boundary; see the plugin\'s README.',
      feedbackLead: 'Found a problem or have an idea? ',
      feedbackIssue: 'Open an issue on GitHub',
      feedbackMail: ', or email ',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Could not copy; select the address above by hand.',
      feedbackNote: 'Emails are sorted with the help of an AI assistant, and issues are public: do not paste your memory notes into either. Plugin version {version}.',
      issueBody: '(What happened, or your idea)\n\n---\ndsh-engramory {version}\nComputer this page was opened on: {os}\ndsh version: ',
      overview: 'Overview',
      statsNotes: '{notes} notes · {archive} archived files',
      listSep: ', ',
      statsUpcoming: 'Coming up: date passed, outcome to confirm {past} · today or ahead {ahead} · no date yet {undated}',
      statsLarge: '{count} notes past 12 KB, worth splitting',
      statsReadAt: 'Read at {time}; plans stand as of that day. Refresh to update.',
      statsPartial: 'The listing was too long to finish, so these numbers fall short.',
      statsUnreadable: '{count} places that may hold a memory store could not be read and are not counted.',
      statsIncomplete: 'Some files in a store could not be read, so these numbers may fall short.',
      upcomingTitle: 'Coming up',
      upcomingPast: 'Date passed, outcome to confirm',
      upcomingToday: 'Today',
      upcomingTomorrow: 'Tomorrow',
      upcomingSoon: 'In {days} days',
      upcomingUndated: 'No date yet',
      filterLabel: 'Filter notes',
      filterPlaceholder: 'Filter by name',
      filterCount: '{count} matching (among the notes listed)',
      filterNone: 'No matching notes in this store.',
      largeNotes: 'Notes past 12 KB ({count}): a note should hold one fact; the AI can split these.',
      tidyCopy: 'Copy tidy-up instructions',
      tidyCopied: 'Copied; paste it into a conversation',
      tidyFailed: 'Could not copy; select the instructions below by hand:',
      tidyPrompt: 'Tidy up this memory store by the Engramory rules: {dir}\n- Links in the index to files that are not there: fix the ones whose note you can find; where there is none, remove that link alone, and the line only when it has no other live link left.\n- Notes the index does not name: add the ones recall will need, move the outdated ones into archive/ or delete them; do not add them all just to be complete.\n- Notes with no type: give them one.\n- An index over its cap: compact it first by merging duplicates and moving detail back into the notes, so the index holds pointers only.\n- Notes past about 12 KB: split them as the rules say.\n- Plans whose date has passed: do not delete them; rewrite them as what happened once you learn the outcome.\nThen check the index is within its cap, and tell me what you changed.',
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
.eng-memory>*{box-sizing:border-box;width:100%;max-width:960px;}
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
.eng-store-actions{margin-left:auto;display:inline-flex;flex-wrap:wrap;gap:8px;}
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
.eng-health{display:flex;flex-direction:column;gap:8px;padding:10px 14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg,10px);background:var(--dsw-alias-bg-layer-1);}
.eng-health-item{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.eng-howto{box-sizing:border-box;padding:10px 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px);}
.eng-howto>summary{cursor:pointer;font-size:13px;font-weight:500;line-height:20px;}
.eng-howto ul{display:flex;flex-direction:column;gap:4px;margin:8px 0 2px;padding-left:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.eng-feedback{display:flex;flex-direction:column;gap:2px;padding-top:16px;border-top:.5px solid var(--dsw-alias-border-l2);font-size:12px;line-height:22px;color:var(--dsw-alias-label-secondary);}
.eng-feedback p{margin:0;}
.eng-link{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:2px;}
.eng-link:hover{opacity:.8;}
.eng-email{margin:0 8px 0 2px;font-family:var(--ds-font-family-code,ui-monospace,monospace);user-select:all;color:var(--dsw-alias-label-primary);}
.eng-btn-small{padding:1px 8px;font-size:11.5px;}
.eng-feedback-note{color:var(--dsw-alias-label-tertiary);}
.eng-overview,.eng-upcoming{box-sizing:border-box;display:flex;flex-direction:column;gap:4px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg,10px);}
.eng-overview-line{margin:0;font-size:13px;line-height:20px;}
.eng-overview-note{margin:2px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.eng-upcoming-list{display:flex;flex-direction:column;gap:0;margin:4px -8px 0;padding:0;list-style:none;}
.eng-upcoming-list li{display:flex;align-items:center;gap:12px;}
.eng-upcoming-list .eng-name{width:auto;max-width:60%;}
.eng-upcoming-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.eng-upcoming-list li[data-status="past"] .eng-upcoming-status{color:var(--dsw-alias-label-primary);font-weight:600;}
.eng-filter{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.eng-filter input{width:240px;}
.eng-filter-count,.eng-filter-none{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.eng-meter{display:inline-block;width:96px;height:6px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden;}
.eng-meter-fill{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-label-secondary);}
.eng-meter[data-over="true"] .eng-meter-fill{background:var(--dsw-alias-state-error-primary);}
.eng-tidy{display:flex;flex-direction:column;gap:6px;}
.eng-tidy textarea{box-sizing:border-box;width:100%;min-height:150px;resize:vertical;font:inherit;font-size:12px;line-height:18px;}
.eng-link:focus-visible,.eng-howto>summary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
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
            ? { phase: 'ready', data: response.body, at: Date.now() }
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

    /** Put `text` on the clipboard; false where there is none (a page over plain http) or it is refused. */
    async function copyText(text) {
      try {
        await globalThis.navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    /** The date an `upcoming` note is named with, if it is a real day: `YYYY-MM-DD`, else undefined. */
    function dateOf(file) {
      const m = DATED.exec(nameOf(file))
      if (m === null) return undefined
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
      const day = new Date(Date.UTC(y, mo - 1, d))
      return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d
        ? `${m[1]}-${m[2]}-${m[3]}` : undefined
    }
    /** A `YYYY-MM-DD` day as a number of days, to subtract one from another. */
    const dayNumber = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1,
      Number(date.slice(8, 10))) / 86400000
    /** Today on this computer's calendar, as `YYYY-MM-DD`. */
    function todayOf(now) {
      const d = new Date(now)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }

    /**
     * Every `upcoming` note listed, against today on this computer: a date passed only says
     * the outcome is yet to be asked about (SKILL.md §2.2 keeps the note until it is known),
     * so nothing here is called late or stale. Passed first, then the nearest, then undated.
     */
    function upcomingOf(stores, now) {
      const today = dayNumber(todayOf(now))
      const items = []
      for (const store of stores) {
        for (const note of store.notes) {
          if (note.type !== 'upcoming') continue
          const date = dateOf(note.name)
          const days = date === undefined ? undefined : dayNumber(date) - today
          const status = days === undefined ? 'undated' : days < 0 ? 'past' : days === 0 ? 'today' : 'ahead'
          items.push({ store, name: note.name, days, status })
        }
      }
      const rank = { past: 0, today: 1, ahead: 2, undated: 3 }
      return items.sort((a, b) => rank[a.status] - rank[b.status] || (a.days ?? 0) - (b.days ?? 0) ||
        byName(a.name, b.name))
    }

    /** How full an index is, the nearer of its two caps; its lines only when they were counted. */
    function fillOf(index, cap) {
      const lines = index.lines === undefined ? 0 : index.lines / cap.maxLines
      return Math.max(lines, index.bytes / cap.maxBytes)
    }

    /** A name, to open where dsh can, as text where it cannot. */
    function noteName(store, file, archived, canOpen, open) {
      return canOpen
        ? h('button', { type: 'button', className: 'eng-name', title: file,
          onClick: () => open(store, file, archived) }, nameOf(file))
        : h('span', { className: 'eng-name', title: file }, nameOf(file))
    }

    /**
     * A store's check-up (index.js checkUp): that nothing was found, what was, or why it
     * did not run. An index over the cap is not checked, and the page already says so.
     */
    function Health({ store, names, t }) {
      const check = store.health
      if (check === undefined || check === null) return null
      if (!check.checked) {
        const reason = { large: 'healthLarge', partial: 'healthPartial', unreadable: 'healthUnreadable' }[check.reason]
        return reason === undefined ? null : h('p', { className: 'eng-note' }, t(reason))
      }
      const untyped = store.notes.filter((note) => note.type === 'other').length
      // pointers to nothing past what the page is told of are still pointers to nothing
      const broken = check.broken.length > 0 || check.brokenMore
      if (!broken && check.unindexed.length === 0 && untyped === 0) {
        return h('p', { className: 'eng-note' }, t('healthOk'))
      }
      return h('section', { className: 'eng-health', 'aria-label': t('healthTitle') },
        h('h3', { className: 'eng-group-title' }, t('healthTitle')),
        broken ? h('div', { className: 'eng-group' },
          h('p', { className: 'eng-health-item' },
            check.broken.length === 0 ? t('healthBrokenUnlisted')
              : t(check.brokenMore ? 'healthBrokenMore' : 'healthBroken', { count: check.broken.length })),
          // what the index says, as it says it: there is no file to open
          check.broken.length > 0 ? h('ul', { className: 'eng-names' }, check.broken.map((target) => h('li', { key: target },
            h('span', { className: 'eng-name', title: target }, target)))) : null) : null,
        check.unindexed.length > 0 ? h('div', { className: 'eng-group' },
          h('p', { className: 'eng-health-item' }, t('healthUnindexed', { count: check.unindexed.length })),
          names(check.unindexed, false)) : null,
        untyped > 0 ? h('p', { className: 'eng-health-item' }, t('healthUntyped', { count: untyped })) : null,
        h('p', { className: 'eng-note' }, t('healthFix')))
    }

    /**
     * One store: where it is, how full its index is (as a bar, the nearer of its two caps), its
     * check-up, its notes grown past what one fact needs, and its notes' names by type — those
     * `match` keeps while the page is filtering. Its tidy-up instructions are copied for the
     * user to hand the AI in a conversation; where there is no clipboard, shown to select.
     */
    function StoreSection({ store, cap, canOpen, open, match, t }) {
      const [tidy, setTidy] = useState('idle')
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])
      const title = store.kind === 'user' ? [t('storeUser'), ...store.titles].join(' · ')
        : store.kind === 'pinned' ? [t('storePinned'), ...store.titles].join(' · ')
          : store.titles.join(' · ')
      const { index } = store
      const sizes = index === null ? {} : { size: sizeOf(t, index.bytes), maxSize: sizeOf(t, cap.maxBytes) }
      // lines are counted only for an index read whole; past that, its bytes say over or not
      const usage = index === null ? t('noIndex')
        : index.lines !== undefined ? t('usage', { lines: index.lines, maxLines: cap.maxLines, ...sizes })
          : t(index.over ? 'usageOver' : 'usageSize', sizes)
      const fill = index === null ? undefined : fillOf(index, cap)
      const names = (list, archive) => h('ul', { className: 'eng-names' },
        [...list].sort(byName).map((file) => h('li', { key: file }, noteName(store, file, archive, canOpen, open))))
      const keep = (file) => match === undefined || match(file)
      const groups = TYPES.map((type) => [type, store.notes.filter((note) => note.type === type && keep(note.name))
        .map((note) => note.name)]).filter(([, list]) => list.length > 0)
      const archived = store.archive.filter(keep)
      const large = store.notes.filter((note) => note.bytes > LARGE_NOTE).map((note) => note.name)
      const prompt = t('tidyPrompt', { dir: store.dir })
      const copyTidy = async () => {
        const done = await copyText(prompt)
        if (alive.current) setTidy(done ? 'copied' : 'failed')
      }
      return h('section', { className: 'eng-store' },
        h('div', { className: 'eng-store-head' },
          h('h2', { className: 'eng-store-title' }, title),
          // the nearer cap, whichever it is; over it, full and marked, not a bar that stops at the edge
          fill === undefined ? null : h('span', { className: 'eng-meter', 'data-over': index.over === true || fill > 1,
            'aria-hidden': true },
          h('span', { className: 'eng-meter-fill', style: { width: `${Math.min(100, Math.floor(fill * 100))}%` } })),
          h('span', { className: 'eng-usage', 'data-over': index?.over === true, title: index?.over ? t('overHint') : undefined }, usage),
          h('div', { className: 'eng-store-actions' },
            h('button', { type: 'button', className: 'eng-btn', onClick: copyTidy },
              t(tidy === 'copied' ? 'tidyCopied' : 'tidyCopy')),
            // the folder is shown with its index selected: no index, no folder to show
            ...(canOpen && index !== null ? [
              h('button', { type: 'button', className: 'eng-btn', key: 'index',
                onClick: () => open(store, index.name, false) }, t('openIndex')),
              h('button', { type: 'button', className: 'eng-btn', key: 'folder',
                onClick: () => open(store, undefined, false) }, t('openFolder'))] : []))),
        h('p', { className: 'eng-path' }, store.dir),
        tidy === 'failed' ? h('div', { className: 'eng-tidy', role: 'status' },
          h('p', { className: 'eng-health-item' }, t('tidyFailed')),
          h('textarea', { readOnly: true, value: prompt, 'aria-label': t('tidyCopy'),
            onFocus: (event) => event.target.select() })) : null,
        index?.over ? h('p', { className: 'eng-note' }, t('overHint')) : null,
        // while filtering, the names that match and nothing else: the check-up comes back after
        match === undefined ? h(Health, { store, names, t }) : null,
        match === undefined && large.length > 0 ? h('div', { className: 'eng-group' },
          h('p', { className: 'eng-health-item' }, t('largeNotes', { count: large.length })),
          names(large, false)) : null,
        ...groups.map(([type, list]) => h('div', { className: 'eng-group', key: type },
          h('h3', { className: 'eng-group-title' }, t('group', { type: t(typeKey(type)), count: list.length })),
          names(list, false))),
        archived.length > 0 ? h('details', { className: 'eng-archive', open: match === undefined ? undefined : true },
          h('summary', null, t('archive', { count: archived.length })),
          names(archived, true)) : null,
        match !== undefined && groups.length === 0 && archived.length === 0
          ? h('p', { className: 'eng-filter-none' }, t('filterNone')) : null,
        store.more ? h('p', { className: 'eng-note' }, t('more')) : null)
    }

    /** When a listing was read, its day with its time, as this computer shows them. */
    const timeOf = (at) => new Date(at).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit',
      minute: '2-digit' })

    /**
     * The listing in numbers, as read at `at`: notes by type, archived files, plans, notes past
     * the size one fact needs — and whether that is all there is (a listing cut short, stores
     * that could not be read), since what was not listed is not counted as nothing.
     */
    function Overview({ data, at, upcoming, t }) {
      const notes = data.stores.flatMap((store) => store.notes)
      const archive = data.stores.reduce((sum, store) => sum + store.archive.length, 0)
      // a note it could not read has no type to count: the counts say the store was read in part
      const types = TYPES.map((type) => [type, notes.filter((note) => note.type === type && !note.unread).length])
        .filter(([, count]) => count > 0)
      const large = notes.filter((note) => note.bytes > LARGE_NOTE).length
      const partial = data.more === true || data.stores.some((store) => store.more)
      // a note or a folder it could not read: the check-up says so, and the counts may fall short
      const incomplete = data.stores.some((store) => store.health?.checked === false &&
        store.health.reason === 'unreadable')
      const count = (...statuses) => upcoming.filter((item) => statuses.includes(item.status)).length
      return h('section', { className: 'eng-overview', 'aria-label': t('overview') },
        h('h2', { className: 'eng-store-title' }, t('overview')),
        h('p', { className: 'eng-overview-line' }, t('statsNotes', { notes: notes.length, archive })),
        types.length > 0 ? h('p', { className: 'eng-overview-line' },
          types.map(([type, n]) => t('group', { type: t(typeKey(type)), count: n })).join(t('listSep'))) : null,
        upcoming.length > 0 ? h('p', { className: 'eng-overview-line' },
          t('statsUpcoming', { past: count('past'), ahead: count('today', 'ahead'), undated: count('undated') })) : null,
        large > 0 ? h('p', { className: 'eng-overview-line' }, t('statsLarge', { count: large })) : null,
        h('p', { className: 'eng-overview-note' }, [
          t('statsReadAt', { time: timeOf(at) }),
          partial ? t('statsPartial') : null,
          incomplete ? t('statsIncomplete') : null,
          data.unreadable > 0 ? t('statsUnreadable', { count: data.unreadable }) : null,
        ].filter((text) => text !== null).join(' ')))
    }

    /** The plans listed, by where they stand against today, names to open as everywhere else. */
    function UpcomingBoard({ items, canOpen, open, t }) {
      const status = (item) => (item.status === 'past' ? t('upcomingPast')
        : item.status === 'today' ? t('upcomingToday')
          : item.status === 'undated' ? t('upcomingUndated')
            : item.days === 1 ? t('upcomingTomorrow') : t('upcomingSoon', { days: item.days }))
      return h('section', { className: 'eng-upcoming', 'aria-label': t('upcomingTitle') },
        h('h2', { className: 'eng-store-title' }, t('upcomingTitle')),
        h('ul', { className: 'eng-upcoming-list' }, items.map((item) => h('li', { key: `${item.store.id}/${item.name}`,
          'data-status': item.status },
        noteName(item.store, item.name, false, canOpen, open),
        h('span', { className: 'eng-upcoming-status' }, status(item))))))
    }

    /** A store with anything in it: an index with text, a note, an archived note. A folder or an
     * empty index alone is not memory yet. */
    const hasMemory = (store) => (store.index !== null && store.index.bytes > 0) ||
      store.notes.length > 0 || store.archive.length > 0

    /** A store not read to its end: a listing cut short, or a file or folder it could not read. */
    const readInPart = (store) => store.more === true ||
      (store.health?.checked === false && store.health.reason === 'unreadable')

    /** How to use it, in a few lines: open while there is no memory yet, folded once there is. */
    function HowTo({ open, t }) {
      return h('details', { className: 'eng-howto', open },
        h('summary', null, t('howTo')),
        h('ul', null, HOW_TO.map((key) => h('li', { key }, t(key)))))
    }

    /** The OS family for a bug report, and nothing that tells one machine from another. */
    function osName() {
      const platform = String(globalThis.navigator?.userAgentData?.platform ?? globalThis.navigator?.platform ?? '')
      return /^win/i.test(platform) ? 'Windows' : /^mac/i.test(platform) ? 'macOS'
        : /linux/i.test(platform) ? 'Linux' : 'unknown'
    }

    /**
     * Where to report a problem or send an idea: a new issue, its body started with the
     * plugin's version and the OS (no path, no note), or the mailbox, whose address the
     * button copies — the desktop app opens only web links, not `mailto:`.
     */
    function Feedback({ t }) {
      const [copy, setCopy] = useState('copy')
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])
      const copyAddress = async () => {
        const done = await copyText(EMAIL)
        if (alive.current) setCopy(done ? 'copied' : 'copyFailed')
      }
      const href = `${ISSUES}?body=${encodeURIComponent(t('issueBody', { version: VERSION, os: osName() }))}`
      return h('footer', { className: 'eng-feedback' },
        h('p', null,
          t('feedbackLead'),
          h('a', { className: 'eng-link', href, target: '_blank', rel: 'noopener noreferrer' }, t('feedbackIssue')),
          t('feedbackMail'),
          h('span', { className: 'eng-email' }, EMAIL),
          h('button', { type: 'button', className: 'eng-btn eng-btn-small', onClick: copyAddress },
            t(copy === 'copied' ? 'copied' : 'copy'))),
        copy === 'copyFailed' ? h('p', { className: 'eng-feedback-note', role: 'status' }, t('copyFailed')) : null,
        h('p', { className: 'eng-feedback-note' }, t('feedbackNote', { version: VERSION })))
    }

    /** The sidebar's Memory page: the stores recall can use, by name, and two settings. */
    function MemoryPage({ t }) {
      const { state, load } = useMemory()
      const [status, setStatus] = useState(undefined)
      const [query, setQuery] = useState('')
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
      // a name filter over what was listed: case- and width-insensitive, the .md left out
      const needle = query.trim().normalize('NFKC').toLowerCase()
      const match = needle === '' ? undefined
        : (file) => nameOf(file).normalize('NFKC').toLowerCase().includes(needle)
      let body
      if (state.phase === 'loading') body = h('p', { className: 'eng-note' }, t('listing'))
      else if (state.phase === 'error') body = h('div', { className: 'eng-banner', 'data-tone': 'error' }, t(state.reason))
      else {
        const upcoming = upcomingOf(data.stores, state.at)
        const listed = data.stores.some((store) => store.notes.length + store.archive.length > 0)
        const matched = match === undefined ? 0 : data.stores.reduce((sum, store) =>
          sum + store.notes.filter((note) => match(note.name)).length + store.archive.filter(match).length, 0)
        body = [
          data.pinned === 'relative' ? h('p', { className: 'eng-note', key: 'pinned' }, t('pinnedRelative')) : null,
          data.stores.length === 0 && data.pinned === undefined && !(data.unreadable > 0) && data.more !== true
            ? h('p', { className: 'eng-note', key: 'empty' }, t('empty')) : null,
          data.stores.length > 0 || data.unreadable > 0
            ? h(Overview, { key: 'overview', data, at: state.at, upcoming, t }) : null,
          upcoming.length > 0 ? h(UpcomingBoard, { key: 'upcoming', items: upcoming, canOpen, open, t }) : null,
          listed ? h('div', { className: 'eng-filter', key: 'filter' },
            h('input', { type: 'search', className: 'eng-input', value: query, placeholder: t('filterPlaceholder'),
              'aria-label': t('filterLabel'), onChange: (event) => setQuery(event.target.value) }),
            match === undefined ? null : h('p', { className: 'eng-filter-count', role: 'status', 'aria-live': 'polite' },
              t('filterCount', { count: matched })))
            : null,
          ...data.stores.map((store) => h(StoreSection, { key: store.id, store, cap: data.cap, canOpen, open, match, t })),
          data.more ? h('p', { className: 'eng-note', key: 'more' }, t('more')) : null,
        ]
      }
      return h('div', { className: 'eng-memory' },
        h('header', { className: 'eng-memory-head' },
          h('div', null,
            h('h1', { className: 'eng-memory-title' }, t('panelTitle')),
            h('p', { className: 'eng-memory-intro' }, t(data !== undefined && !canOpen ? 'memoryIntroNoOpen' : 'memoryIntro'))),
          h('button', { type: 'button', className: 'eng-btn', onClick: () => { setStatus(undefined); load() } }, t('refresh'))),
        h(SettingsStrip, { t }),
        status ? h('div', { className: 'eng-banner', 'data-tone': status.tone, role: 'status' }, status.text) : null,
        data !== undefined && !canOpen && data.stores.length > 0 ? h('p', { className: 'eng-note' }, t('openUnavailable')) : null,
        h(HowTo, { open: data !== undefined && data.pinned !== 'relative' && data.more !== true &&
          !(data.unreadable > 0) && !data.stores.some((store) => hasMemory(store) || readInPart(store)), t }),
        body,
        h(Feedback, { t }))
    }

    /** The sidebar entry's icon: the logo, [[ ]] around a cursor, drawn in the row's own colour
     * (so it follows dsh's light and dark themes) at the size it asks for. */
    function MemoryIcon({ size }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      h('path', { d: 'M5.1 3.5H2.5v17h2.6M9.2 3.5H6.6v17h2.6' }),
      h('path', { d: 'M18.9 3.5h2.6v17h-2.6M14.8 3.5h2.6v17h-2.6' }),
      h('rect', { x: 10.4, y: 7, width: 3.2, height: 10, rx: 1, fill: 'currentColor', stroke: 'none' }))
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

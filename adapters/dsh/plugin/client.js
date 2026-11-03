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
 * notice), and the colours are the host's theme tokens, so light, dark and third-party themes
 * follow — but for the memory page's banner, in the project's own navy and mint on any theme,
 * that mint again in an index's fill bar and a clean check-up's tick, and the note types'
 * marks, each a muted colour of its own leaned toward the theme's text.
 * Visible text goes through the locale service.
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
    const STORE_API = 'api/engramory/store'
    const PICK_API = 'api/engramory/store/pick'
    /** How long the page waits on dsh's folder chooser: the route closes it after ten minutes. */
    const PICK_WAIT_MS = 11 * 60 * 1000
    /** How often the page asks after a move it started, and for how long in all. */
    const MOVE_POLL_MS = 500
    const MOVE_WATCH_MS = 120000
    /** How often the page looks again at a move it did not start, while one is under way. */
    const MOVE_FOLLOW_MS = 2000
    /** This plugin's version, for the feedback footer; a test keeps it equal to package.json's. */
    const VERSION = '1.5.0'
    /** Where feedback goes: a new issue on the repository, or the project's mailbox. Opening
     * the link is the browser's (the desktop app hands it to the system's); the footer submits
     * nothing by itself. */
    const ISSUES = 'https://github.com/tinqiao-oss/engramory/issues/new'
    const EMAIL = 'engramory@agent.qq.com'
    /** Where "Check for updates" asks for the latest version, in turn: npm's own registry, then
     * npmmirror, its mirror in China, for when npm cannot be reached. Asked on that click only. */
    const REGISTRIES = [['npm', 'https://registry.npmjs.org'], ['npmmirror', 'https://registry.npmmirror.com']]
    /** Where to look when neither answers, and what a newer version changed. */
    const NPM_PAGE = 'https://www.npmjs.com/package/dsh-engramory?activeTab=versions'
    const RELEASE = 'https://github.com/tinqiao-oss/engramory/releases/tag/v'
    /** A version as SemVer writes one: three numbers without leading zeros, then maybe a prerelease
     * tag and build metadata, each in dot-separated identifiers (a numeric one without leading zeros). */
    const SEMVER = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
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
      place: '记忆库位置',
      placeNow: '现在在',
      placeIsDefault: '（默认位置）',
      placeLoadFailed: '读不到记忆库在哪。',
      placeLoading: '正在读取记忆库位置…',
      placeChange: '换位置',
      globalAbsent: '全局记忆还没有建，AI 第一次往全局库存记忆时会自动建好。',
      placeHide: '收起',
      placeChoose: '选文件夹…',
      placeChoosing: '在弹出的窗口里选…',
      placeChosenInside: '选的文件夹里已经有东西，会在里面新建一个 {name} 文件夹来放记忆。',
      placeChooseFailed: '打不开选文件夹的窗口：{reason}',
      placeInput: '新位置',
      placePlaceholder: '新位置：一个空文件夹或还不存在的文件夹，例如 D:\\同步盘\\AI记忆',
      placeMove: '搬过去',
      placeBack: '搬回默认位置',
      placeHint: '整个记忆库连同归档一起搬过去，搬完旧位置自动清理；这台电脑上的桌面版和命令行都用这个位置。搬的那几秒 AI 存不了记忆，会过一会儿再存。放进网盘的话别让两台电脑同时写；放进 git 仓库会被一起提交；映射的网络盘可能让 dsh 卡顿。',
      placeMoving: '正在搬…',
      placeMoved: '搬好了，旧位置已经清理。',
      placeMovedConflicts: '搬好了。有 {count} 个文件在搬的时候两边都被改过：旧位置那份放在新位置、名字里带 .old-，索引里也加了一行，记得合并。',
      placeSame: '记忆库已经在这里了。',
      placeStillMoving: '还在搬，过一会儿刷新这一页看看。',
      placeEnded: '这次搬家已经结束，记忆库现在在上面写的位置。',
      placeMoveFailed: '没搬成：{reason}',
      placeResuming: '有一次搬家还没做完，dsh 会自动接着做完。',
      placeResumingWhy: '上次停在：{reason}会自动再试。',
      placePinned: '配置里固定了索引（indexPath），记忆库就在它所在的文件夹，这里不能搬。',
      placeRemote: 'dsh 主目录在网络位置上，这里不能搬。',
      placeProblem: '记录记忆库位置的文件读不懂，暂时找不到记忆库：{file}。把它改对后刷新这一页。',
      placeCustomSkill: '你用的是自己写的记忆规则（skill），里面写的位置搬完要自己改。',
      placeLegacy: 'dsh 主目录的 AGENTS.md 里还有不装插件时写进去的记忆规则，写的是默认位置；装了插件就用不着它了，可以用 engramory_init.py 卸掉。',
      whyRelative: '要写完整路径（Windows 上带盘符）。',
      whyNetwork: '不能放在网络路径上。',
      whyRoot: '不能是整个盘。',
      whyDeep: '路径太深了。',
      whyInvalid: '路径里有 Windows 不认的名字或字符。',
      whyReserved: '这个位置不能用：用户主目录、dsh 主目录和它们的上级都不行，名字也不能跟记忆库撞。',
      whyNested: '新位置不能在记忆库里面，也不能把记忆库包在里面。',
      whyNotEmpty: '那个文件夹里已经有东西了，要选空文件夹或还不存在的文件夹。',
      whyNotDir: '那里是个文件，不是文件夹。',
      whyLink: '新位置或记忆库里有目录链接，插件不替你搬，请手动处理。',
      whyUnreadable: '读不了那个位置。',
      whyUnavailable: '现在的记忆库找不到了，比如它所在的盘没接上。',
      whyBusy: '正在搬家，等它做完。',
      whyProblem: '记忆库位置的记录有问题，先修好它。',
      whyTooMany: '文件太多了。',
      whyTooBig: '太大了（超过 256 MB）。',
      whyTooDeep: '文件夹层数太多了。',
      whySpecial: '记忆库里有不是普通文件的东西。',
      whyChanged: '搬的时候记忆库被别处换了位置。',
      whyInterrupted: '上次搬到一半被打断了，已经撤销，记忆库还在原处。',
      whyFailed: '文件操作出错了。',
      locationUnknown: '记录记忆库位置的文件（dsh 主目录下的 .engramory-memory.json）读不懂，全局记忆这次没列出来。把它改对后点刷新。',
      panel: '记忆',
      panelTitle: 'Engramory 记忆',
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
      usage: '索引 {lines} / {maxLines} 行 · {size} / {maxSize}',
      usageOver: '索引 {size} / {maxSize}，超出上限',
      usageSize: '索引 {size} / {maxSize}',
      sizeBytes: '{n} B',
      sizeKB: '{n} KB',
      overHint: '超出上限了，AI 只读得到前面一部分，该压缩了。',
      noIndex: '还没有索引',
      openIndex: '打开索引',
      openFolder: '打开文件夹',
      opened: '已打开 {name}。',
      revealed: '已在文件夹里显示 {name}。',
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
      archive: '归档 {count} 份',
      more: '文件太多，这里只列出了一部分。',
      healthOk: '体检：没发现问题。',
      healthBroken: '索引里指向不存在的文件（{count}）',
      healthBrokenMore: '索引里指向不存在的文件（{count} 个以上）',
      healthBrokenUnlisted: '索引里有指向不存在的文件，太多了，这里没列出。',
      healthUnindexed: '不在索引里（{count}）：AI 回忆从索引开始，这些它通常找不到，除非别的笔记链到它们。',
      healthUntyped: '没写类型或类型不认识（{count}），列在「其他」里。',
      healthFix: '完整检查可以用 engramory_doctor.py。',
      healthLarge: '要核对的太多，没做体检。',
      healthUnreadable: '有文件读不了，没做体检。',
      healthPartial: '文件太多没列全，没做体检。',
      howTo: '怎么用',
      howToSay: '想让 AI 记住什么，直接跟它说，比如「记住：我习惯用 pnpm」「把这个决定记下来」。平时它也会尽量自己挑值得长期记住的记下来，比如你纠正过它的做法。',
      howToRecall: '默认每次对话都会带上记忆的目录（索引），AI 用到细节时再打开那条笔记，不用你提醒。',
      howToEdit: '这里列出读得到的记忆，打开笔记就能直接改；想让 AI 忘掉什么，跟它说「忘掉……」就行。',
      howToMove: '记忆是存在运行 dsh 那台电脑上的普通 markdown 文件，位置写在每个库的标题下面。想放到别处（比如网盘里），点「全局记忆」右上角的「换位置」，插件会整个搬过去。换电脑时，把那个文件夹拷到新电脑 dsh 主目录下的 .engramory-memory，想放别处再在新电脑上搬一次。',
      howToSocial: '接了 QQ、微信等、别人也能跟你的 AI 聊的话，在上面打开「大肥鱼模式」，再把「记忆权限」改成「社交」：只有认得出是你本人的对话才拿得到记忆。这不是安全隔离，详见插件说明。',
      feedbackLead: '遇到问题或有建议：',
      feedbackIssue: '到 GitHub 提 issue',
      feedbackMail: '，或发邮件到',
      copy: '复制',
      copied: '已复制',
      copyFailed: '复制不了，请手动选中上面的地址。',
      feedbackNote: '邮件会由 AI 助手协助整理，issue 是公开的，两处都别把记忆内容原样贴上去。',
      versionLine: '插件版本 {version}',
      checkUpdate: '检查更新',
      checking: '正在检查…',
      updateNewer: '有新版本 {latest}（你装的是 {current}）',
      updateNotes: '看这一版改了什么',
      updateHow: '升级时要写上版本号（只写名字的话，pnpm 默认不装发布不满 24 小时的版本）：',
      updateDesktop: '桌面版：在「插件」页卸载「Engramory 记忆」，再搜索安装',
      updateCli: '命令行：',
      updateProfile: '<名字>',
      updateAfter: '装完重启 dsh（桌面版从托盘退出再打开）。记忆和设置都会保留。',
      updateCurrent: '已是最新版本：{source} 上最新的就是 {latest}。',
      updateAhead: '你装的 {current} 比 {source} 上最新的 {latest} 还新。',
      updateMirror: 'npm 没有给出版本号，这是镜像 npmmirror 的结果，它有时比 npm 晚几分钟同步。',
      updateFailed: '查不到最新版本：npm 和 npmmirror 都没有给出版本号。可以到网页上看：',
      updateNpm: 'npm 上的版本列表',
      copySpecFailed: '复制不了，请手动选中上面的版本号。',
      updateNote: '检查更新会向 npm（连不上再试 npmmirror）查最新版本号，请求里不带任何记忆内容；不点就不联网。',
      issueBody: '（写下遇到的问题或建议）\n\n---\ndsh-engramory {version}\n打开这个页面的电脑：{os}\ndsh 版本：',
      statNote: '条记忆',
      statNotes: '条记忆',
      statStore: '个记忆库',
      statStores: '个记忆库',
      statArchive: '份归档',
      statsReadAt: '读取于 {time}，约定的天数按这时算',
      statsPartial: '列表太长，只列出了一部分，这些数字偏少。',
      statsUnreadable: '有 {count} 处可能存放记忆库的位置没读到（读不了或查不了），没算在内。',
      statsIncomplete: '有的库里有文件读不了，这些数字可能偏少。',
      typeAll: '全部',
      typeLabel: '按类型筛选',
      storeCount: '{count} 条',
      storeCountOne: '{count} 条',
      noteMeta: '{type} · {size}',
      noteUnread: '读不了',
      archived: '已归档',
      monthDay: '{m}月{d}日',
      yearMonthDay: '{y}年{m}月{d}日',
      badgePast: '{date} · 日期已过，待确认',
      badgeToday: '就是今天',
      badgeTomorrow: '{date} · 明天',
      badgeSoon: '{date} · 还有 {days} 天',
      badgeUndated: '未定日期',
      badgeLarge: '偏大，建议拆分',
      badgeUnindexed: '不在索引里',
      attnTitle: '可以整理一下',
      attnLarge: '超过 12 KB 的笔记 {count} 篇：一条笔记该只记一件事，可以让 AI 拆成几篇。',
      filterLabel: '筛选笔记',
      filterPlaceholder: '按名字筛选',
      filterCount: '匹配 {count} 条（只在已列出的笔记里找）',
      filterNone: '这个库里没有匹配的笔记。',
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
      place: 'Where the memory is',
      placeNow: 'Now in',
      placeIsDefault: ' (the default place)',
      placeLoadFailed: 'Could not read where the memory is.',
      placeLoading: 'Reading where the memory is…',
      placeChange: 'Move',
      globalAbsent: 'No global memory yet: the global store is made the first time the AI saves to it.',
      placeHide: 'Close',
      placeChoose: 'Choose folder…',
      placeChoosing: 'Choose in the window that opened…',
      placeChosenInside: 'That folder holds something already: a {name} folder is made inside it for the memory.',
      placeChooseFailed: 'The folder chooser did not open: {reason}',
      placeInput: 'New place',
      placePlaceholder: 'New place: an empty folder, or one not there yet, such as D:\\Sync\\AI memory',
      placeMove: 'Move it there',
      placeBack: 'Move it back to the default place',
      placeHint: 'The whole store moves, archive and all, and the old place is cleared once it has; the desktop app and the command line on this computer both use the new place. For the few seconds it takes, the AI cannot save memory and tries again a little later. In a synced folder, do not let two computers write at once; in a git repository it gets committed with the rest; a mapped network drive may make dsh stall.',
      placeMoving: 'Moving…',
      placeMoved: 'Moved, and the old place is cleared.',
      placeMovedConflicts: 'Moved. {count} file(s) changed in both places while it moved: the old place\'s copy is beside it in the new place, with .old- in its name and a line in the index. Merge them.',
      placeSame: 'The memory is there already.',
      placeStillMoving: 'Still moving. Refresh this page in a little while.',
      placeEnded: 'The move is over: the memory is where it says above.',
      placeMoveFailed: 'Not moved: {reason}',
      placeResuming: 'A move is not finished yet; dsh finishes it on its own.',
      placeResumingWhy: 'It last stopped at: {reason} It will try again.',
      placePinned: 'An index is pinned (indexPath): the memory is in its folder, and is not moved here.',
      placeRemote: 'dsh\'s home folder is on a network place: the memory is not moved here.',
      placeProblem: 'The file that says where the memory is cannot be read as written, so the memory cannot be found for now: {file}. Correct it, then refresh this page.',
      placeCustomSkill: 'You use memory rules of your own (skill): change the place they name once it has moved.',
      placeLegacy: 'AGENTS.md in dsh\'s home folder still holds memory rules written there for a setup without the plugin, naming the default place. With the plugin they are not needed: engramory_init.py can take them out.',
      whyRelative: 'Give the whole path (on Windows, with its drive).',
      whyNetwork: 'It cannot be on a network path.',
      whyRoot: 'It cannot be a whole drive.',
      whyDeep: 'The path is too deep.',
      whyInvalid: 'The path holds a name or a character Windows does not take.',
      whyReserved: 'That place cannot be used: not your home folder, not dsh\'s, nor any folder holding them, and not a name the memory store uses.',
      whyNested: 'The new place cannot be inside the store, nor hold it.',
      whyNotEmpty: 'There is something in that folder already: choose an empty folder, or one not there yet.',
      whyNotDir: 'That is a file, not a folder.',
      whyLink: 'The new place or the store holds a folder link: the plugin does not move it for you. Sort it out by hand.',
      whyUnreadable: 'That place cannot be read.',
      whyUnavailable: 'The store cannot be found where it is now: its drive may not be connected.',
      whyBusy: 'A move is under way: wait until it is done.',
      whyProblem: 'The record of where the memory is has a problem: fix it first.',
      whyTooMany: 'There are too many files.',
      whyTooBig: 'It is too big (over 256 MB).',
      whyTooDeep: 'Its folders go too deep.',
      whySpecial: 'The store holds something that is not a plain file.',
      whyChanged: 'The store was moved elsewhere while this move ran.',
      whyInterrupted: 'The last move was cut short and has been undone: the store is where it was.',
      whyFailed: 'A file operation failed.',
      locationUnknown: 'The file that says where the memory is (.engramory-memory.json in dsh\'s home folder) cannot be read as written, so the global memory is not listed this time. Correct it, then refresh.',
      panel: 'Memory',
      panelTitle: 'Engramory memory',
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
      usage: 'Index {lines} / {maxLines} lines · {size} / {maxSize}',
      usageOver: 'Index {size} / {maxSize}, over the cap',
      usageSize: 'Index {size} / {maxSize}',
      sizeBytes: '{n} B',
      sizeKB: '{n} KB',
      overHint: 'Over the cap: the AI reads only the first part. Time to compact it.',
      noIndex: 'No index yet',
      openIndex: 'Open the index',
      openFolder: 'Open the folder',
      opened: 'Opened {name}.',
      revealed: 'Showed {name} in its folder.',
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
      archive: 'Archive ({count})',
      more: 'Too many files: only some are listed here.',
      healthOk: 'Check-up: nothing to fix.',
      healthBroken: 'The index points to files that are not there ({count})',
      healthBrokenMore: 'The index points to files that are not there (over {count})',
      healthBrokenUnlisted: 'The index points to files that are not there: too many to list here.',
      healthUnindexed: 'Not in the index ({count}): recall starts from the index, so the AI will not find these unless another note links to them.',
      healthUntyped: 'No type, or one it does not know ({count}), listed under Other.',
      healthFix: 'For a full check, run engramory_doctor.py.',
      healthLarge: 'Too much to check here, so no check-up.',
      healthUnreadable: 'Some files could not be read, so no check-up.',
      healthPartial: 'Too many files to list them all, so no check-up here.',
      howTo: 'How to use it',
      howToSay: 'To have the AI remember something, just tell it: "remember that I use pnpm", "note this decision down". It also tries to keep what is worth keeping on its own, such as a way of working you corrected.',
      howToRecall: 'By default every conversation carries the memory\'s table of contents (the index), and the AI opens a note when it needs the details; you do not have to remind it.',
      howToEdit: 'The memory this page can read is listed here; open a note to edit it. To have the AI forget something, tell it "forget …".',
      howToMove: 'The memory is plain markdown files on the computer dsh runs on, in the folder shown under each store\'s title. To keep it elsewhere (a synced folder, say), click Move at the top right of the global memory, and the plugin moves it all there. On a new computer, copy that folder to .engramory-memory in dsh\'s home folder there, then move it again if you want it elsewhere.',
      howToSocial: 'If others can talk to your AI too (through QQ, WeChat and the like), turn on Companion mode above and set Memory access to Social: only conversations it can tell are yours get the memory. This is not a security boundary; see the plugin\'s README.',
      feedbackLead: 'Found a problem or have an idea? ',
      feedbackIssue: 'Open an issue on GitHub',
      feedbackMail: ', or email ',
      copy: 'Copy',
      copied: 'Copied',
      copyFailed: 'Could not copy; select the address above by hand.',
      feedbackNote: 'Emails are sorted with the help of an AI assistant, and issues are public: do not paste your memory notes into either.',
      versionLine: 'Plugin version {version}',
      checkUpdate: 'Check for updates',
      checking: 'Checking…',
      updateNewer: 'Version {latest} is out (you have {current})',
      updateNotes: 'What changed',
      updateHow: 'Name the version when you upgrade: by name alone, pnpm by default does not install a version published less than 24 hours ago.',
      updateDesktop: 'Desktop app: on the Plugins page, uninstall Engramory memory, then search for and install',
      updateCli: 'Command line: ',
      updateProfile: '<name>',
      updateAfter: 'Then restart dsh (in the desktop app, quit from the tray and open it again). Your memory and settings stay.',
      updateCurrent: 'You have the latest version: the latest on {source} is {latest}.',
      updateAhead: 'The {current} you have is newer than the latest on {source}, {latest}.',
      updateMirror: 'npm gave no version, so this is from its mirror npmmirror, which can be a few minutes behind npm.',
      updateFailed: 'Could not find the latest version: neither npm nor npmmirror gave one. The versions are listed on npm\'s site: ',
      updateNpm: 'dsh-engramory on npm',
      copySpecFailed: 'Could not copy; select the version above by hand.',
      updateNote: 'Checking asks npm (or npmmirror, when npm cannot be reached) for the latest version number; nothing from your memory goes with it. Nothing is asked until you click.',
      issueBody: '(What happened, or your idea)\n\n---\ndsh-engramory {version}\nComputer this page was opened on: {os}\ndsh version: ',
      statNote: 'note',
      statNotes: 'notes',
      statStore: 'store',
      statStores: 'stores',
      statArchive: 'archived',
      statsReadAt: 'Read at {time}; days to a plan count from then',
      statsPartial: 'The listing was too long to finish, so these numbers fall short.',
      statsUnreadable: '{count} places that may hold a memory store could not be read and are not counted.',
      statsIncomplete: 'Some files in a store could not be read, so these numbers may fall short.',
      typeAll: 'All',
      typeLabel: 'Filter by type',
      storeCount: '{count} notes',
      storeCountOne: '{count} note',
      noteMeta: '{type} · {size}',
      noteUnread: 'Could not be read',
      archived: 'Archived',
      monthDay: '{m}/{d}',
      yearMonthDay: '{y}/{m}/{d}',
      badgePast: '{date} · passed, outcome to confirm',
      badgeToday: 'Today',
      badgeTomorrow: '{date} · tomorrow',
      badgeSoon: '{date} · in {days} days',
      badgeUndated: 'No date yet',
      badgeLarge: 'Large: worth splitting',
      badgeUnindexed: 'Not in the index',
      attnTitle: 'Worth tidying up',
      attnLarge: 'Notes past 12 KB: {count}. A note should hold one fact, and the AI can split these.',
      filterLabel: 'Filter notes',
      filterPlaceholder: 'Filter by name',
      filterCount: '{count} matching (among the notes listed)',
      filterNone: 'No matching notes in this store.',
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
.eng-empty{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.eng-place{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;}
.eng-place-now{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}
.eng-place-now code{font-family:var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-primary);}
.eng-place-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.eng-place-row .eng-input{flex:1 1 260px;}
.eng-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 14px;font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;}
.eng-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.eng-btn:disabled{opacity:.5;cursor:default;}
.eng-btn-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff);}
.eng-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));opacity:.9;}
.eng-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 8px;}
.eng-btn-small{padding:1px 8px;font-size:11.5px;}
.eng-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;}
.eng-memory{box-sizing:border-box;height:100%;overflow:auto;display:flex;flex-direction:column;align-items:center;gap:20px;padding:28px clamp(24px,4vw,48px) 48px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;}
[data-platform=darwin] .eng-memory{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px));}
.eng-memory>*{box-sizing:border-box;width:100%;max-width:960px;flex:none;}
.eng-memory svg{display:block;flex:none;}
.eng-hero{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:24px 40px;padding:30px 32px;border-radius:24px;color:#e8f3f0;background:radial-gradient(120% 140% at 100% 0%,#1f4a5a 0%,rgba(31,74,90,0) 55%),linear-gradient(135deg,#0f1b2d 0%,#14263f 100%);box-shadow:0 12px 32px rgba(15,27,45,.18);}
.eng-hero-main{display:flex;flex-direction:column;gap:24px;flex:1 1 340px;min-width:0;}
.eng-brand{display:flex;align-items:center;gap:14px;}
.eng-logo{border-radius:12px;box-shadow:0 0 0 1px rgba(110,231,200,.35);}
.eng-hero-title{margin:0;font-size:21px;font-weight:600;line-height:28px;letter-spacing:.01em;}
.eng-hero-version{margin-left:10px;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:13px;font-weight:400;letter-spacing:0;color:rgba(232,243,240,.6);}
.eng-stats{display:flex;align-items:baseline;flex-wrap:wrap;gap:6px 0;}
.eng-stat{display:inline-flex;align-items:baseline;gap:6px;}
.eng-stat+.eng-stat{margin-left:18px;padding-left:18px;border-left:1px solid rgba(232,243,240,.18);}
.eng-stat b{font-size:40px;line-height:44px;font-weight:600;color:#6ee7c8;font-variant-numeric:tabular-nums;letter-spacing:-.02em;}
.eng-stat span{font-size:13px;color:rgba(232,243,240,.75);}
.eng-hero-foot{display:flex;align-items:center;flex-wrap:wrap;gap:8px 10px;}
.eng-hero-read{display:inline-flex;align-items:center;gap:6px;margin:0;padding:3px 10px;border-radius:999px;background:rgba(255,255,255,.06);font-size:12px;line-height:18px;color:rgba(232,243,240,.62);}
.eng-hero-side{display:flex;flex-direction:column;flex:0 1 300px;min-width:260px;}
.eng-hero .eng-strip{display:flex;flex-direction:column;gap:14px;padding:18px 20px;border-radius:18px;background:rgba(255,255,255,.06);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08);}
.eng-hero .eng-strip-item{display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:30px;font-size:13px;color:rgba(232,243,240,.8);}
.eng-hero .eng-strip-item:first-child{font-weight:600;color:#e8f3f0;}
.eng-hero .eng-strip-note{margin:0;font-size:11.5px;line-height:17px;color:rgba(232,243,240,.74);}
.eng-hero .eng-switch{width:46px;height:26px;background:rgba(255,255,255,.24);}
.eng-hero .eng-switch::after{top:3px;left:3px;width:20px;height:20px;}
.eng-hero .eng-switch[aria-checked="true"]::after{transform:translateX(20px);}
.eng-hero .eng-switch[aria-checked="true"]{background:#6ee7c8;}
.eng-hero .eng-switch[aria-checked="true"]::after{background:#0f1b2d;}
.eng-hero .eng-segment{border:0;border-radius:999px;background:rgba(0,0,0,.25);}
.eng-hero .eng-segment button{border-radius:999px;padding:3px 14px;font-size:12.5px;line-height:18px;color:rgba(232,243,240,.62);}
.eng-hero .eng-segment button[aria-pressed="true"]{background:#6ee7c8;color:#0f1b2d;box-shadow:none;}
.eng-hero .eng-btn,.eng-hero-btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:1px solid rgba(232,243,240,.22);border-radius:999px;background:transparent;color:#e8f3f0;font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;}
.eng-hero .eng-btn:hover:not(:disabled),.eng-hero-btn:hover{background:rgba(255,255,255,.08);}
.eng-hero :focus-visible{outline:2px solid #6ee7c8;outline-offset:2px;}
.eng-caveat{display:flex;align-items:flex-start;gap:8px;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.eng-caveat svg{margin-top:2px;color:var(--dsw-alias-state-warn-label);}
.eng-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;margin-top:6px;}
.eng-tabs{display:flex;flex-wrap:wrap;gap:2px;flex:1 1 auto;min-width:0;}
.eng-tab{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 10px;border:0;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer;}
.eng-tab:hover{background:var(--dsw-alias-interactive-bg-hover);}
.eng-tab[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:500;}
.eng-tab-count{font-size:11.5px;font-weight:400;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}
.eng-search{position:relative;display:flex;align-items:center;flex:0 1 240px;min-width:160px;color:var(--dsw-alias-label-caption);}
.eng-search svg{position:absolute;left:10px;pointer-events:none;}
.eng-search .eng-input{width:100%;height:34px;padding-left:32px;border-radius:10px;font-size:13px;}
.eng-filter-count,.eng-filter-none{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.eng-store{display:flex;flex-direction:column;gap:10px;margin-top:10px;}
.eng-store-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;}
.eng-store-title{margin:0;font-size:15px;font-weight:600;line-height:22px;}
.eng-store-count{font-size:12px;color:var(--dsw-alias-label-tertiary);}
.eng-meter{display:inline-block;width:56px;height:4px;margin-left:4px;border-radius:999px;background:var(--dsw-alias-border-l2);overflow:hidden;}
.eng-meter-fill{display:block;height:100%;border-radius:999px;background:#2bb894;background:color-mix(in srgb,#2bb894 76%,var(--dsw-alias-label-primary));}
.eng-meter[data-over="true"] .eng-meter-fill{background:var(--dsw-alias-state-error-primary);}
.eng-usage{font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;}
.eng-usage[data-over="true"]{color:var(--dsw-alias-state-error-primary);}
.eng-store-actions{margin-left:auto;display:inline-flex;flex-wrap:wrap;gap:2px;}
.eng-path{margin:-8px 0 0;font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;}
.eng-store-ok{display:flex;align-items:center;gap:6px;margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.eng-store-ok svg{color:#2bb894;color:color-mix(in srgb,#2bb894 76%,var(--dsw-alias-label-primary));}
.eng-attn{display:flex;align-items:flex-start;gap:10px;padding:10px 10px 10px 14px;border-radius:14px;background:var(--dsw-alias-state-warn-tertiary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 11%,transparent);}
.eng-attn>svg{margin-top:2px;color:var(--dsw-alias-state-warn-label);}
.eng-attn-body{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;}
.eng-attn-title{margin:0;font-size:12.5px;font-weight:600;line-height:20px;color:var(--dsw-alias-state-warn-label);}
.eng-attn-item{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.eng-broken{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 0;padding:0;list-style:none;}
.eng-broken code{padding:0 6px;border-radius:6px;background:var(--dsw-alias-interactive-bg-hover);font-family:var(--ds-font-family-code,ui-monospace,monospace);font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;}
.eng-attn>.eng-btn{flex:none;}
.eng-tidy{display:flex;flex-direction:column;gap:6px;}
.eng-tidy p{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.eng-tidy textarea{box-sizing:border-box;width:100%;min-height:150px;resize:vertical;font:inherit;font-size:12px;line-height:18px;}
.eng-list{display:flex;flex-direction:column;padding:4px;border:.5px solid var(--dsw-alias-border-l3);border-radius:16px;}
.eng-rows{display:flex;flex-direction:column;margin:0;padding:0;list-style:none;}
.eng-row{box-sizing:border-box;display:flex;align-items:center;gap:12px;width:100%;min-height:52px;padding:6px 10px;border:0;border-radius:12px;background:transparent;color:inherit;font:inherit;text-align:left;}
button.eng-row{cursor:pointer;}
button.eng-row:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.eng-row[data-type="user"]{--eng-type:#6f86c6;}
.eng-row[data-type="feedback"]{--eng-type:#b39a45;}
.eng-row[data-type="project"]{--eng-type:#4e9a78;}
.eng-row[data-type="reference"]{--eng-type:#8b78c4;}
.eng-row[data-type="moment"]{--eng-type:#c07193;}
.eng-row[data-type="upcoming"]{--eng-type:#c9735c;}
.eng-row[data-type="self"]{--eng-type:#3f9aa6;}
.eng-mark{display:grid;place-items:center;width:32px;height:32px;flex:none;border-radius:10px;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l4);color:var(--eng-type,var(--dsw-alias-label-tertiary));color:color-mix(in srgb,var(--eng-type,var(--dsw-alias-label-tertiary)) 80%,var(--dsw-alias-label-primary));}
.eng-row-text{display:flex;flex-direction:column;flex:1;min-width:0;}
.eng-name{font-size:13.5px;font-weight:500;line-height:19px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eng-row-meta{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.eng-badges{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;max-width:55%;}
.eng-badge{padding:0 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:20px;white-space:nowrap;}
.eng-badge[data-tone="warn"]{background:var(--dsw-alias-state-warn-tertiary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-label);}
.eng-badge[data-tone="quiet"]{background:transparent;box-shadow:inset 0 0 0 .5px var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);}
.eng-row-go{color:var(--dsw-alias-label-caption);}
.eng-archive{border-top:.5px dashed var(--dsw-alias-border-l2);margin-top:4px;padding-top:4px;}
.eng-list>.eng-archive:first-child{border-top:0;margin-top:0;padding-top:0;}
.eng-archive>summary{display:flex;align-items:center;gap:12px;min-height:44px;padding:4px 14px 4px 18px;border-radius:12px;cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary);list-style:none;}
.eng-archive>summary::-webkit-details-marker{display:none;}
.eng-archive>summary::after,.eng-howto>summary::after{content:"";margin-left:auto;width:6px;height:6px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg);opacity:.55;}
.eng-archive[open]>summary::after,.eng-howto[open]>summary::after{transform:rotate(45deg);}
.eng-archive>summary:hover{background:var(--dsw-alias-interactive-bg-hover);}
.eng-howto{box-sizing:border-box;padding:12px 14px;border:.5px solid var(--dsw-alias-border-l3);border-radius:14px;}
.eng-howto>summary{display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:500;line-height:20px;list-style:none;}
.eng-howto>summary::-webkit-details-marker{display:none;}
.eng-howto ul{display:flex;flex-direction:column;gap:4px;margin:10px 0 2px;padding-left:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);}
.eng-feedback{display:flex;flex-direction:column;gap:2px;padding-top:14px;border-top:.5px solid var(--dsw-alias-border-l2);font-size:12px;line-height:22px;color:var(--dsw-alias-label-secondary);}
.eng-feedback p{display:flex;align-items:center;flex-wrap:wrap;margin:0;}
.eng-feedback p svg{margin-right:6px;color:var(--dsw-alias-label-tertiary);}
.eng-link{color:var(--dsw-alias-brand-primary);text-decoration:underline;text-underline-offset:2px;}
.eng-link:hover{opacity:.8;}
.eng-email{margin:0 8px 0 2px;font-family:var(--ds-font-family-code,ui-monospace,monospace);user-select:all;color:var(--dsw-alias-label-primary);}
.eng-feedback-note{color:var(--dsw-alias-label-tertiary);}
.eng-version,.eng-update{display:flex;flex-direction:column;gap:2px;}
.eng-update{margin:2px 0 6px;}
.eng-version>p>.eng-btn{margin-left:8px;}
.eng-update-new{margin-right:8px;font-weight:500;color:var(--dsw-alias-label-primary);}
.eng-update ul{margin:0;padding-left:18px;}
.eng-update li{margin:0;}
.eng-update li .eng-btn{margin-left:6px;}
.eng-code{margin:0 2px 0 6px;font-family:var(--ds-font-family-code,ui-monospace,monospace);user-select:all;color:var(--dsw-alias-label-primary);}
.eng-name:focus-visible,.eng-row:focus-visible,.eng-btn:focus-visible,.eng-tab:focus-visible,.eng-link:focus-visible,.eng-howto>summary:focus-visible,.eng-archive>summary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:1px;}
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
    async function request(url, { timeout = 15000, signal, ...init } = {}) {
      const deadline = new AbortController()
      const timer = setTimeout(() => deadline.abort(), timeout)
      // the caller's own end too (a section closed while dsh's chooser is open)
      signal?.addEventListener('abort', () => deadline.abort(), { once: true })
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

    /** "No memory yet", and where the store is to be made: it can be moved before there is any. */
    function NoMemory({ t, onMoved, note = 'empty' }) {
      const [placing, setPlacing] = useState(false)
      return h('div', { className: 'eng-section' },
        h('div', { className: 'eng-empty' },
          h('p', { className: 'eng-note' }, t(note === 'global' ? 'globalAbsent' : 'empty')),
          h('button', { type: 'button', className: 'eng-btn eng-btn-ghost', 'aria-expanded': placing,
            onClick: () => setPlacing(!placing) }, icon('move', 14), t(placing ? 'placeHide' : 'placeChange'))),
        placing ? h(PlaceSection, { t, onMoved, showNow: true }) : null)
    }

    /** Why the store route turned a move down, or a move stopped (its codes, index.js). */
    function whyNot(t, code, detail) {
      const why = {
        relative: () => t('whyRelative'), network: () => t('whyNetwork'), root: () => t('whyRoot'),
        deep: () => t('whyDeep'), invalid: () => t('whyInvalid'), reserved: () => t('whyReserved'),
        nested: () => t('whyNested'), notEmpty: () => t('whyNotEmpty'), notDir: () => t('whyNotDir'),
        link: () => t('whyLink'), unreadable: () => t('whyUnreadable'), unavailable: () => t('whyUnavailable'),
        busy: () => t('whyBusy'), problem: () => t('whyProblem'), pinned: () => t('placePinned'),
        remote: () => t('placeRemote'), tooMany: () => t('whyTooMany'), tooBig: () => t('whyTooBig'),
        tooDeep: () => t('whyTooDeep'), special: () => t('whySpecial'), changed: () => t('whyChanged'),
        interrupted: () => t('whyInterrupted'),
      }[code]
      return why === undefined ? `${t('whyFailed')}${typeof detail === 'string' ? ` (${detail})` : ''}` : why()
    }

    /**
     * Moving the global store: on the memory page, opened from the global store's own actions
     * (or beside "no memory yet"). The folder comes from dsh's own chooser where it opens on this
     * desktop, or is typed; the page starts a move and asks after it until it is done (the plugin
     * carries it on whether or not the page stays), then has the listing read again (`onMoved`).
     * `showNow`: say where the store is, where the page does not show it already.
     */
    function PlaceSection({ t, onMoved, showNow = false }) {
      const [state, setState] = useState({ phase: 'loading' })
      const [text, setText] = useState('')
      const [busy, setBusy] = useState(false)
      const [choosing, setChoosing] = useState(false)
      const [banner, setBanner] = useState(undefined)
      const alive = useRef(true)
      const moving = useRef(false)
      const chooserRequest = useRef(undefined)
      // a move on record the last time it was read: over now, the listing is read again
      const wasMoving = useRef(false)
      useEffect(() => () => {
        alive.current = false
        chooserRequest.current?.abort() // closed: the chooser it asked for closes with it
      }, [])
      const load = useCallback(async () => {
        try {
          const response = await request(STORE_API)
          if (!response.ok || response.body === undefined) throw new Error(`HTTP ${response.status}`)
          if (!alive.current) return
          setState({ phase: 'ready', data: response.body })
          const under = response.body.moving !== undefined
          if (wasMoving.current && !under) onMoved?.()
          wasMoving.current = under
        } catch {
          if (alive.current) setState((s) => (s.phase === 'ready' ? s : { phase: 'error' }))
        }
      }, [onMoved])
      useEffect(() => { load() }, [load])
      // a move under way when the page opened (another window's, or one carried on after a
      // restart): asked after until it is over, as one this page starts
      const underWay = state.phase === 'ready' && state.data.moving !== undefined && !busy
      // each look, answered or not, schedules the next while the move is still on record
      const [looks, setLooks] = useState(0)
      useEffect(() => {
        if (!underWay) return undefined
        const timer = setTimeout(() => {
          if (alive.current) load().finally(() => { if (alive.current) setLooks((n) => n + 1) })
        }, MOVE_FOLLOW_MS)
        return () => clearTimeout(timer)
      }, [underWay, looks])

      const choose = async () => {
        if (moving.current || choosing) return
        setChoosing(true)
        setBanner(undefined)
        try {
          let response
          const ending = new AbortController()
          chooserRequest.current = ending
          try {
            response = await request(PICK_API, { method: 'POST', headers: { 'content-type': 'application/json' },
              body: '{}', timeout: PICK_WAIT_MS, signal: ending.signal })
          } catch (error) {
            response = { ok: false, body: { message: String(error?.message ?? error) } }
          } finally {
            if (chooserRequest.current === ending) chooserRequest.current = undefined
          }
          if (!alive.current) return
          const body = response.body ?? {}
          if (response.ok && body.cancelled === true) return
          if (response.ok && typeof body.to === 'string') {
            setText(body.to)
            if (typeof body.inside === 'string') setBanner({ tone: 'ok', text: t('placeChosenInside', { name: body.inside }) })
            return
          }
          setBanner({ tone: 'error', text: t('placeChooseFailed', { reason: body.message ?? body.error ?? `HTTP ${response.status}` }) })
        } finally {
          if (alive.current) setChoosing(false)
        }
      }

      const move = async (to) => {
        if (moving.current) return
        moving.current = true
        setBusy(true)
        setBanner(undefined)
        try {
          let response
          try {
            response = await request(STORE_API, {
              method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to }),
            })
          } catch (error) {
            response = { ok: false, body: { error: 'failed', detail: String(error?.message ?? error) } }
          }
          if (!alive.current) return
          const body = response.body ?? {}
          if (response.ok && body.same === true) {
            await load() // another dsh may have moved it there: the page shows where it is now
            if (alive.current) setBanner({ tone: 'ok', text: t('placeSame') })
            onMoved?.()
            return
          }
          if (response.status !== 202 || typeof body.id !== 'string') {
            setBanner({ tone: 'error', text: t('placeMoveFailed', { reason: whyNot(t, body.reason ?? body.error, body.detail) }) })
            await load()
            return
          }
          setBanner({ tone: 'ok', text: t('placeMoving') })
          let outcome
          // by the clock, not by count: each ask may itself wait out its own deadline
          const until = Date.now() + MOVE_WATCH_MS
          while (alive.current && outcome?.done !== true && Date.now() < until) {
            await new Promise((resolve) => setTimeout(resolve, MOVE_POLL_MS))
            try {
              const polled = await request(`${STORE_API}?id=${encodeURIComponent(body.id)}`)
              if (polled.ok && polled.body !== undefined && alive.current) {
                setState({ phase: 'ready', data: polled.body })
                outcome = polled.body.outcome
              }
            } catch { /* asked again */ }
          }
          if (!alive.current) return
          if (outcome?.done === true && outcome.elsewhere === true) {
            setText('')
            setBanner({ tone: 'ok', text: t('placeEnded') })
            onMoved?.()
          } else if (outcome?.done === true && outcome.ok === true) {
            setText('')
            setBanner({ tone: 'ok', text: outcome.conflicts > 0
              ? t('placeMovedConflicts', { count: outcome.conflicts }) : t('placeMoved') })
            onMoved?.()
          } else if (outcome?.done === true) {
            setBanner({ tone: 'error', text: t('placeMoveFailed', { reason: whyNot(t, outcome.error, outcome.detail) }) })
          } else {
            setBanner({ tone: 'error', text: t('placeStillMoving') })
          }
        } finally {
          moving.current = false
          if (alive.current) setBusy(false)
        }
      }

      if (state.phase === 'loading') return h('p', { className: 'eng-note' }, t('placeLoading'))
      if (state.phase === 'error') {
        return h('section', { className: 'eng-place', 'aria-label': t('place') },
          h('p', { className: 'eng-note' }, t('placeLoadFailed')),
          h('div', { className: 'eng-actions' }, h('button', { type: 'button', className: 'eng-btn', onClick: load }, t('retry'))))
      }
      const { data } = state
      const atDefault = typeof data.store === 'string' && data.store === data.default
      const blocked = data.pinned === true ? 'placePinned' : data.remote === true ? 'placeRemote' : undefined
      const stopped = data.moving !== undefined && !busy
      return h('section', { className: 'eng-place', 'aria-label': t('place') },
        showNow && typeof data.store === 'string' ? h('p', { className: 'eng-place-now' },
          `${t('placeNow')} `, h('code', null, legible(data.store)), atDefault ? t('placeIsDefault') : '') : null,
        data.problem !== undefined ? h('div', { className: 'eng-banner', 'data-tone': 'error' },
          t('placeProblem', { file: legible(data.file ?? '') })) : null,
        stopped ? h('p', { className: 'eng-note' }, t('placeResuming'),
          data.moving.error === undefined ? '' : ` ${t('placeResumingWhy', { reason: whyNot(t, data.moving.error) })}`) : null,
        blocked !== undefined ? h('p', { className: 'eng-note' }, t(blocked)) : data.problem === undefined ? [
          h('div', { className: 'eng-place-row', key: 'row' },
            data.chooser === true ? h('button', { type: 'button', className: 'eng-btn', disabled: busy || choosing,
              onClick: choose }, icon('folder', 14), t(choosing ? 'placeChoosing' : 'placeChoose')) : null,
            h('input', { className: 'eng-input', value: text, disabled: busy, placeholder: t('placePlaceholder'),
              'aria-label': t('placeInput'), spellCheck: false, onChange: (e) => { setText(e.target.value); setBanner(undefined) } }),
            h('button', { type: 'button', className: 'eng-btn eng-btn-primary', disabled: busy || choosing || text.trim() === '',
              onClick: () => move(text.trim()) }, busy ? t('placeMoving') : t('placeMove'))),
          atDefault ? null : h('div', { className: 'eng-actions', key: 'back' },
            h('button', { type: 'button', className: 'eng-btn', disabled: busy, onClick: () => move(null) }, t('placeBack'))),
          h('p', { className: 'eng-hint', key: 'hint' }, t('placeHint')),
          data.customSkill === true ? h('p', { className: 'eng-note', key: 'skill' }, t('placeCustomSkill')) : null,
          data.legacyRules === true ? h('p', { className: 'eng-note', key: 'legacy' }, t('placeLegacy')) : null,
        ] : null,
        banner ? h('div', { className: 'eng-banner', 'data-tone': banner.tone, role: 'status' }, banner.text) : null)
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
    /**
     * A name or path from disk as the page shows it: a control character, a line or paragraph
     * separator, a bidirectional mark, embedding, override or isolate, or a character with no
     * width of its own (a zero-width space, a word joiner, a byte order mark) — any of which can
     * make a name read as another, or hide part of it — shown as its code point (`[U+202E]`).
     * The joiners some scripts and emoji are written with (U+200C, U+200D) are left as they are.
     * What the page sends back to open a file is the name as it is.
     */
    const HIDDEN = [[0x0, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x200b, 0x200b], [0x200e, 0x200f],
      [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]]
    const legible = (text) => Array.from(String(text), (ch) => {
      const code = ch.codePointAt(0)
      return HIDDEN.some(([low, high]) => code >= low && code <= high)
        ? `[U+${code.toString(16).toUpperCase().padStart(4, '0')}]`
        : ch
    }).join('')
    const sizeOf = (t, bytes) => (bytes < 1024 ? t('sizeBytes', { n: bytes }) : t('sizeKB', { n: (bytes / 1024).toFixed(1) }))
    const typeKey = (type) => `type${type[0].toUpperCase()}${type.slice(1)}`
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    const byName = (a, b) => collator.compare(a, b)
    /** Notes in the protocol's order of types, then by name. */
    const byTypeThenName = (a, b) => TYPES.indexOf(a.type) - TYPES.indexOf(b.type) || byName(a.name, b.name)

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
     * Where an `upcoming` note stands against today on this computer: a date passed only says
     * the outcome is yet to be asked about (SKILL.md §2.2 keeps the note until it is known),
     * so nothing here is called late or stale. No date, or no real one, is undated.
     */
    function planOf(file, now) {
      const date = dateOf(file)
      if (date === undefined) return { status: 'undated' }
      const days = dayNumber(date) - dayNumber(todayOf(now))
      return { status: days < 0 ? 'past' : days === 0 ? 'today' : 'ahead', days, date }
    }

    /** A note's name as listed: a plan's date is in its badge, so it is not said again before the name. */
    function shownName(file, plan) {
      const name = nameOf(file)
      if (plan?.date === undefined) return name
      const rest = name.slice(10).replace(/^[\s_-]+/, '')
      return rest === '' ? name : rest
    }

    /** How full an index is, the nearer of its two caps; its lines only when they were counted. */
    function fillOf(index, cap) {
      const lines = index.lines === undefined ? 0 : index.lines / cap.maxLines
      return Math.max(lines, index.bytes / cap.maxBytes)
    }

    /** Line icons on a 24-unit grid, in the current colour: [element, attributes] each. One per
     * note type (TYPES), drawn alike, so the type's colour tells them apart before the shape does. */
    const ICONS = {
      refresh: [['path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }], ['path', { d: 'M20 4v7h-7' }]],
      search: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'm20 20-3.5-3.5' }]],
      copy: [['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }], ['path', { d: 'M5 15V5a2 2 0 0 1 2-2h8' }]],
      folder: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }]],
      move: [['path', { d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z' }],
        ['path', { d: 'M9 13h6m-2-2 2 2-2 2' }]],
      index: [['path', { d: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' }]],
      tidy: [['path', { d: 'm4 20 11-11M14 4l1 2 2 1-2 1-1 2-1-2-2-1 2-1zM19 11l.7 1.3L21 13l-1.3.7L19 15l-.7-1.3L17 13l1.3-.7z' }]],
      archive: [['rect', { x: 3, y: 4, width: 18, height: 5, rx: 1 }], ['path', { d: 'M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4' }]],
      alert: [['path', { d: 'M12 4 2.5 20h19z' }], ['path', { d: 'M12 10v4M12 17h.01' }]],
      clock: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 7.5V12l3 2' }]],
      check: [['path', { d: 'm5 12 5 5 9-10' }]],
      chevron: [['path', { d: 'm9 6 6 6-6 6' }]],
      book: [['path', { d: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z' }], ['path', { d: 'M4 19V5' }]],
      issue: [['path', { d: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z' }]],
      mail: [['rect', { x: 3, y: 5, width: 18, height: 14, rx: 2 }], ['path', { d: 'm3 7 9 6 9-6' }]],
      package: [['path', { d: 'M12 3 4 7v10l8 4 8-4V7z' }], ['path', { d: 'm4 7 8 4 8-4M12 11v10' }]],
      user: [['circle', { cx: 12, cy: 8.6, r: 3.6 }], ['path', { d: 'M5 19.5c1.2-3.3 3.9-5 7-5s5.8 1.7 7 5z' }]],
      feedback: [['path', { d: 'M4.5 6.5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11l-4 3v-3h-.5a2 2 0 0 1-2-2z' }],
        ['path', { d: 'm9 10.3 2 2 4-4' }]],
      project: [['path', { d: 'M12 4 3.5 8.5 12 13l8.5-4.5z' }], ['path', { d: 'm3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.3 12 20.8l8.5-4.5' }]],
      reference: [['path', { d: 'M7 3.5h10a1 1 0 0 1 1 1v16l-6-3.8-6 3.8v-16a1 1 0 0 1 1-1z' }]],
      moment: [['path', { d: 'M10 3.5l1.6 4.4L16 9.5l-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6z' }],
        ['path', { d: 'M17.5 14v5.5M14.75 16.75h5.5' }]],
      upcoming: [['rect', { x: 4, y: 5.5, width: 16, height: 14.5, rx: 2.5 }], ['path', { d: 'M4 10h16M8.5 3.5v4M15.5 3.5v4' }],
        ['circle', { cx: 15.3, cy: 15, r: 1.3, fill: 'currentColor', stroke: 'none' }]],
      self: [['path', { d: 'M12 19.5s-7-4.3-7-9.6A3.9 3.9 0 0 1 12 7.6a3.9 3.9 0 0 1 7 2.3c0 5.3-7 9.6-7 9.6z' }]],
      other: [['path', { d: 'M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z' }], ['path', { d: 'M13.5 3.5V9H19' }]],
    }
    const icon = (name, size = 16, weight = 1.8) => h('svg', {
      width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: weight,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false',
    }, ...ICONS[name].map(([tag, attributes], i) => h(tag, { key: i, ...attributes })))

    /** The project's mark, [[▮]] in mint on its dark tile, as in its icon. */
    function Logo() {
      return h('svg', { className: 'eng-logo', width: 44, height: 44, viewBox: '0 0 64 64', 'aria-hidden': true, focusable: 'false' },
        h('rect', { width: 64, height: 64, rx: 14, fill: '#0F1B2D' }),
        h('path', { d: 'M13 17.5H9v29h4M22 17.5h-4v29h4M42 17.5h4v29h-4M51 17.5h4v29h-4', fill: 'none', stroke: '#6EE7C8',
          strokeWidth: 4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('rect', { x: 27.5, y: 23, width: 9, height: 18, rx: 2.4, fill: '#6EE7C8' }))
    }

    /** When a listing was read, its day with its time, as this computer shows them. */
    const timeOf = (at) => new Date(at).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit',
      minute: '2-digit' })

    /**
     * The banner atop the memory page, in the project's own colours on any theme: its name with
     * the plugin's version, the listing in three numbers as read at `at` with a refresh beside the
     * time, and the two settings that matter most in a panel of their own. Numbers only once there
     * is a listing with something to count.
     */
    function Hero({ data, at, refresh, t }) {
      const counted = data !== undefined && (data.stores.length > 0 || data.unreadable > 0)
      const sum = (of) => data.stores.reduce((total, store) => total + of(store), 0)
      const notes = counted ? sum((store) => store.notes.length) : 0
      const stat = (n, label) => h('div', { className: 'eng-stat', key: label }, h('b', null, String(n)), h('span', null, label))
      return h('header', { className: 'eng-hero' },
        h('div', { className: 'eng-hero-main' },
          h('div', { className: 'eng-brand' }, h(Logo), h('h1', { className: 'eng-hero-title' }, t('panelTitle'),
            h('span', { className: 'eng-hero-version' }, `v${VERSION}`))),
          counted ? h('div', { className: 'eng-stats' },
            stat(notes, t(notes === 1 ? 'statNote' : 'statNotes')),
            stat(data.stores.length, t(data.stores.length === 1 ? 'statStore' : 'statStores')),
            stat(sum((store) => store.archive.length), t('statArchive'))) : null,
          h('div', { className: 'eng-hero-foot' },
            data === undefined ? null : h('p', { className: 'eng-hero-read' },
              icon('clock', 13), t('statsReadAt', { time: timeOf(at) })),
            h('button', { type: 'button', className: 'eng-hero-btn', onClick: refresh }, icon('refresh', 14), t('refresh')))),
        h('div', { className: 'eng-hero-side' }, h(SettingsStrip, { t })))
    }

    /** What the numbers leave out — a listing cut short, files or stores it could not read — since
     * what was not listed is not counted as nothing. */
    function Caveats({ data, t }) {
      const partial = data.more === true || data.stores.some((store) => store.more)
      // a note or a folder it could not read: the store's check-up says so too
      const incomplete = data.stores.some((store) => store.health?.checked === false &&
        store.health.reason === 'unreadable')
      const lines = [
        partial ? t('statsPartial') : null,
        incomplete ? t('statsIncomplete') : null,
        data.unreadable > 0 ? t('statsUnreadable', { count: data.unreadable }) : null,
      ].filter((line) => line !== null)
      return lines.length === 0 ? null
        : h('p', { className: 'eng-caveat' }, icon('alert', 14), h('span', null, lines.join(' ')))
    }

    /**
     * One store: where it is, how full its index is (a bar to the nearer of its two caps), what
     * its check-up (index.js checkUp) found for the AI to tidy up — with the tidy-up instructions
     * to copy, or to select where there is no clipboard — and its notes, a row each: the type's
     * mark, the name, the type and size, and what stands out (a plan's day, a note grown past one
     * fact, one the index leaves out). While the page filters, the rows that match and no more.
     */
    function StoreSection({ store, cap, canOpen, open, match, kind, now, t, onMoved }) {
      const [tidy, setTidy] = useState('idle')
      // the global store's: moving it, opened from its actions
      const [placing, setPlacing] = useState(false)
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])
      const title = legible(store.kind === 'user' ? [t('storeUser'), ...store.titles].join(' · ')
        : store.kind === 'pinned' ? [t('storePinned'), ...store.titles].join(' · ')
          : store.titles.join(' · '))
      const { index } = store
      const sizes = index === null ? {} : { size: sizeOf(t, index.bytes), maxSize: sizeOf(t, cap.maxBytes) }
      // lines are counted only for an index read whole; past that, its bytes say over or not
      const usage = index === null ? t('noIndex')
        : index.lines !== undefined ? t('usage', { lines: index.lines, maxLines: cap.maxLines, ...sizes })
          : t(index.over ? 'usageOver' : 'usageSize', sizes)
      const fill = index === null ? undefined : fillOf(index, cap)
      const filtering = match !== undefined || kind !== undefined
      const keep = (file) => match === undefined || match(file)
      const notes = store.notes.filter((note) => (kind === undefined || note.type === kind) && keep(note.name))
        .sort(byTypeThenName)
      const archived = kind === undefined ? store.archive.filter(keep).sort(byName) : []

      const check = store.health ?? undefined
      const checked = check?.checked === true
      const unindexed = new Set(checked ? check.unindexed : [])
      const untyped = store.notes.filter((note) => note.type === 'other').length
      const large = store.notes.filter((note) => note.bytes > LARGE_NOTE).length
      // pointers to nothing past what the page is told of are still pointers to nothing
      const broken = checked && (check.broken.length > 0 || check.brokenMore)
      const findings = [
        index?.over ? h('p', { className: 'eng-attn-item', key: 'over' }, t('overHint')) : null,
        broken ? h('div', { className: 'eng-attn-item', key: 'broken' },
          check.broken.length === 0 ? t('healthBrokenUnlisted')
            : t(check.brokenMore ? 'healthBrokenMore' : 'healthBroken', { count: check.broken.length }),
          // what the index says, as it says it: there is no file to open
          check.broken.length > 0 ? h('ul', { className: 'eng-broken' },
            check.broken.map((target) => h('li', { key: target }, h('code', null, legible(target))))) : null) : null,
        checked && check.unindexed.length > 0
          ? h('p', { className: 'eng-attn-item', key: 'unindexed' }, t('healthUnindexed', { count: check.unindexed.length })) : null,
        checked && untyped > 0 ? h('p', { className: 'eng-attn-item', key: 'untyped' }, t('healthUntyped', { count: untyped })) : null,
        large > 0 ? h('p', { className: 'eng-attn-item', key: 'large' }, t('attnLarge', { count: large })) : null,
      ].filter((finding) => finding !== null)
      // while filtering, the names that match and nothing else: the findings come back after
      const attention = !filtering && findings.length > 0
      // a check-up that did not run says why, except past the cap, which the findings say already
      const unchecked = check === undefined || check === null || check.checked ? undefined
        : { large: 'healthLarge', partial: 'healthPartial', unreadable: 'healthUnreadable' }[check.reason]

      const prompt = t('tidyPrompt', { dir: store.dir })
      const copyTidy = async () => {
        const done = await copyText(prompt)
        if (alive.current) setTidy(done ? 'copied' : 'failed')
      }
      // one per store: in the findings where there are any, else among the store's own actions
      const tidyButton = (className) => h('button', { type: 'button', className, onClick: copyTidy },
        icon('tidy', 14), t(tidy === 'copied' ? 'tidyCopied' : 'tidyCopy'))

      const planText = (plan) => {
        if (plan.status === 'undated') return t('badgeUndated')
        if (plan.status === 'today') return t('badgeToday')
        // the year where it is not this one, so last year's plan is not taken for this year's
        const year = Number(plan.date.slice(0, 4))
        const day = { m: Number(plan.date.slice(5, 7)), d: Number(plan.date.slice(8, 10)) }
        const date = year === new Date(now).getFullYear() ? t('monthDay', day) : t('yearMonthDay', { y: year, ...day })
        return plan.status === 'past' ? t('badgePast', { date })
          : plan.days === 1 ? t('badgeTomorrow', { date }) : t('badgeSoon', { date, days: plan.days })
      }
      /** A note's row, or an archived file's (no note given): to open where dsh can, else text. */
      const row = (file, note) => {
        const type = note === undefined ? 'archive' : note.type
        const plan = type === 'upcoming' ? planOf(file, now) : undefined
        const meta = note === undefined ? t('archived')
          : note.unread ? t('noteUnread')
            : note.bytes === undefined ? t(typeKey(type))
              : t('noteMeta', { type: t(typeKey(type)), size: sizeOf(t, note.bytes) })
        const badges = [
          plan === undefined ? null : h('span', { className: 'eng-badge', key: 'plan',
            'data-tone': plan.status === 'past' ? 'warn' : plan.status === 'undated' ? 'quiet' : undefined }, planText(plan)),
          note?.bytes > LARGE_NOTE ? h('span', { className: 'eng-badge', 'data-tone': 'warn', key: 'large' }, t('badgeLarge')) : null,
          note !== undefined && unindexed.has(file) ? h('span', { className: 'eng-badge', key: 'unindexed' }, t('badgeUnindexed')) : null,
        ].filter((badge) => badge !== null)
        const parts = [
          h('span', { className: 'eng-mark', key: 'mark' }, icon(Object.hasOwn(ICONS, type) ? type : 'other', 18, 1.6)),
          h('span', { className: 'eng-row-text', key: 'text' },
            h('span', { className: 'eng-name' }, legible(shownName(file, plan))),
            h('span', { className: 'eng-row-meta' }, meta)),
          badges.length > 0 ? h('span', { className: 'eng-badges', key: 'badges' }, badges) : null,
          canOpen ? h('span', { className: 'eng-row-go', key: 'go' }, icon('chevron', 14)) : null,
        ]
        const props = { className: 'eng-row', 'data-type': type, title: legible(file) }
        return h('li', { key: file }, canOpen
          ? h('button', { type: 'button', ...props, onClick: () => open(store, file, note === undefined) }, ...parts)
          : h('div', props, ...parts))
      }
      const archive = archived.length === 0 ? null
        : h('details', { className: 'eng-archive', open: match === undefined ? undefined : true },
          h('summary', null, icon('archive', 16), h('span', null, t('archive', { count: archived.length }))),
          h('ul', { className: 'eng-rows' }, archived.map((file) => row(file, undefined))))

      return h('section', { className: 'eng-store', 'aria-label': title },
        h('div', { className: 'eng-store-head' },
          h('h2', { className: 'eng-store-title' }, title),
          h('span', { className: 'eng-store-count' },
            t(store.notes.length === 1 ? 'storeCountOne' : 'storeCount', { count: store.notes.length })),
          // the nearer cap, whichever it is; over it, full and marked, not a bar that stops at the edge
          fill === undefined ? null : h('span', { className: 'eng-meter', 'data-over': index.over === true || fill > 1,
            'aria-hidden': true },
          h('span', { className: 'eng-meter-fill', style: { width: `${Math.min(100, Math.floor(fill * 100))}%` } })),
          h('span', { className: 'eng-usage', 'data-over': index?.over === true, title: index?.over ? t('overHint') : undefined }, usage),
          h('div', { className: 'eng-store-actions' },
            store.kind === 'user' ? h('button', { type: 'button', className: 'eng-btn eng-btn-ghost', key: 'place',
              'aria-expanded': placing, onClick: () => setPlacing(!placing) },
            icon('move', 14), t(placing ? 'placeHide' : 'placeChange')) : null,
            attention ? null : tidyButton('eng-btn eng-btn-ghost'),
            // the folder is shown with its index selected: no index, no folder to show
            ...(canOpen && index !== null ? [
              h('button', { type: 'button', className: 'eng-btn eng-btn-ghost', key: 'index',
                onClick: () => open(store, index.name, false) }, icon('index', 14), t('openIndex')),
              h('button', { type: 'button', className: 'eng-btn eng-btn-ghost', key: 'folder',
                onClick: () => open(store, undefined, false) }, icon('folder', 14), t('openFolder'))] : []))),
        h('p', { className: 'eng-path' }, legible(store.dir)),
        placing ? h(PlaceSection, { t, onMoved }) : null,
        !filtering && checked && findings.length === 0
          ? h('p', { className: 'eng-store-ok' }, icon('check', 13), t('healthOk')) : null,
        attention ? h('div', { className: 'eng-attn', role: 'note' },
          icon('alert', 16),
          h('div', { className: 'eng-attn-body' },
            h('h3', { className: 'eng-attn-title' }, t('attnTitle')),
            ...findings,
            h('p', { className: 'eng-attn-item', key: 'doctor' }, t('healthFix'))),
          tidyButton('eng-btn')) : null,
        tidy === 'failed' ? h('div', { className: 'eng-tidy', role: 'status' },
          h('p', null, t('tidyFailed')),
          h('textarea', { readOnly: true, value: prompt, 'aria-label': t('tidyCopy'),
            onFocus: (event) => event.target.select() })) : null,
        !filtering && unchecked !== undefined ? h('p', { className: 'eng-note' }, t(unchecked)) : null,
        notes.length > 0 || archive !== null ? h('div', { className: 'eng-list' },
          notes.length > 0 ? h('ul', { className: 'eng-rows' }, notes.map((note) => row(note.name, note))) : null,
          archive) : null,
        filtering && notes.length === 0 && archived.length === 0
          ? h('p', { className: 'eng-filter-none' }, t('filterNone')) : null,
        store.more ? h('p', { className: 'eng-note' }, t('more')) : null)
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
        h('summary', null, icon('book', 15), t('howTo')),
        h('ul', null, HOW_TO.map((key) => h('li', { key }, t(key)))))
    }

    /** The OS family for a bug report, and nothing that tells one machine from another. */
    function osName() {
      const platform = String(globalThis.navigator?.userAgentData?.platform ?? globalThis.navigator?.platform ?? '')
      return /^win/i.test(platform) ? 'Windows' : /^mac/i.test(platform) ? 'macOS'
        : /linux/i.test(platform) ? 'Linux' : 'unknown'
    }

    /** The latest version on npm and the registry that said so, asked of each in turn until one
     * answers with a version; undefined when none does. Each gets 8 seconds, body included, and no cookie or
     * referrer goes with the request: the package's name is all it asks about. */
    async function latestVersion() {
      for (const [source, registry] of REGISTRIES) {
        const deadline = new AbortController()
        const timer = setTimeout(() => deadline.abort(), 8000)
        try {
          const response = await fetch(`${registry}/${PACKAGE}/latest`, { cache: 'no-store', credentials: 'omit',
            referrerPolicy: 'no-referrer', signal: deadline.signal, headers: { accept: 'application/json' } })
          const version = response.ok ? (await response.json())?.version : undefined
          if (typeof version === 'string' && version.length <= 64 && SEMVER.test(version)) return { version, source }
        } catch {
          // unreachable, refused, too slow or not JSON: the next registry
        } finally {
          clearTimeout(timer)
          // a body left unread (an error's) or half read is let go, not left streaming
          deadline.abort()
        }
      }
      return undefined
    }

    /** -1, 0 or 1 as version `a` is older than, the same as or newer than `b` (both SEMVER): by
     * the three numbers, then a prerelease before its release. Two prereleases of one release
     * count as the same; this package publishes none to npm's `latest`. */
    function compareVersions(a, b) {
      const x = SEMVER.exec(a)
      const y = SEMVER.exec(b)
      for (let i = 1; i <= 3; i++) {
        if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1
      }
      return x[4] === y[4] || (x[4] !== undefined && y[4] !== undefined) ? 0 : x[4] === undefined ? 1 : -1
    }

    /**
     * The installed version and, on a click and only then, how it stands against the latest on
     * npm. A newer one comes with the steps that install it, the version named: by name alone,
     * pnpm (the desktop's, and the CLI's from pnpm 11) takes only a version a day old. dsh has no
     * update for a plugin outside its own catalog, so the desktop's way is uninstall and install.
     */
    function UpdateCheck({ t }) {
      const [check, setCheck] = useState({ phase: 'idle' })
      const [copy, setCopy] = useState('copy')
      const alive = useRef(true)
      useEffect(() => () => { alive.current = false }, [])
      const run = async () => {
        setCheck({ phase: 'checking' })
        setCopy('copy')
        const found = await latestVersion()
        if (!alive.current) return
        setCheck(found === undefined ? { phase: 'failed' } : { phase: 'done', latest: found.version,
          source: found.source, order: compareVersions(found.version, VERSION) })
      }
      const spec = `${PACKAGE}@${check.latest}`
      const copySpec = async () => {
        const done = await copyText(spec)
        if (alive.current) setCopy(done ? 'copied' : 'copyFailed')
      }
      const external = (href, text) => h('a', { className: 'eng-link', href, target: '_blank', rel: 'noopener noreferrer' }, text)
      let result = null
      if (check.phase === 'failed') {
        result = h('p', { role: 'status' }, t('updateFailed'), external(NPM_PAGE, t('updateNpm')))
      } else if (check.phase === 'done' && check.order <= 0) {
        result = h('p', { role: 'status' },
          check.order === 0 ? t('updateCurrent', { latest: check.latest, source: check.source })
            : t('updateAhead', { latest: check.latest, current: VERSION, source: check.source }))
      } else if (check.phase === 'done') {
        result = h('div', { className: 'eng-update', role: 'status' },
          h('p', null,
            h('span', { className: 'eng-update-new' }, t('updateNewer', { latest: check.latest, current: VERSION })),
            external(`${RELEASE}${check.latest}`, t('updateNotes'))),
          h('p', null, t('updateHow')),
          h('ul', null,
            h('li', null, t('updateDesktop'), h('code', { className: 'eng-code' }, spec),
              h('button', { type: 'button', className: 'eng-btn eng-btn-small', onClick: copySpec },
                t(copy === 'copied' ? 'copied' : 'copy'))),
            h('li', null, t('updateCli'),
              h('code', { className: 'eng-code' }, `dsh plugin --profile ${t('updateProfile')} add ${spec}`))),
          copy === 'copyFailed' ? h('p', { className: 'eng-feedback-note' }, t('copySpecFailed')) : null,
          h('p', null, t('updateAfter')))
      }
      // a mirror's word, which may trail npm's, is said to be one
      const mirrored = check.phase === 'done' && check.source !== 'npm'
        ? h('p', { className: 'eng-feedback-note' }, t('updateMirror')) : null
      return h('div', { className: 'eng-version' },
        h('p', null,
          icon('package', 14),
          t('versionLine', { version: VERSION }),
          h('button', { type: 'button', className: 'eng-btn eng-btn-small', disabled: check.phase === 'checking',
            onClick: run }, t(check.phase === 'checking' ? 'checking' : 'checkUpdate'))),
        result,
        mirrored,
        h('p', { className: 'eng-feedback-note' }, t('updateNote')))
    }

    /**
     * Where to report a problem or send an idea: a new issue, its body started with the
     * plugin's version and the OS (no path, no note), or the mailbox, whose address the
     * button copies — the desktop app opens only web links, not `mailto:`. Above them, the
     * version and the check for a newer one.
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
        h(UpdateCheck, { t }),
        h('p', null,
          icon('issue', 14),
          t('feedbackLead'),
          h('a', { className: 'eng-link', href, target: '_blank', rel: 'noopener noreferrer' }, t('feedbackIssue')),
          t('feedbackMail'),
          h('span', { className: 'eng-email' }, EMAIL),
          h('button', { type: 'button', className: 'eng-btn eng-btn-small', onClick: copyAddress },
            t(copy === 'copied' ? 'copied' : 'copy'))),
        copy === 'copyFailed' ? h('p', { className: 'eng-feedback-note', role: 'status' }, t('copyFailed')) : null,
        h('p', { className: 'eng-feedback-note' }, t('feedbackNote')))
    }

    /**
     * The sidebar's Memory page: a banner with the listing's numbers and two settings, then the
     * stores recall can use, their notes a row each, by type and by name as the user filters.
     */
    function MemoryPage({ t }) {
      const { state, load } = useMemory()
      const [status, setStatus] = useState(undefined)
      const [query, setQuery] = useState('')
      const [kind, setKind] = useState(undefined)
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
        // a file shown in its folder rather than opened (an index not named .md) is said to be
        setStatus(reply.ok ? { tone: 'ok', text: file === undefined ? t('opened', { name: legible(store.dir) })
          : t(reply.revealed === true ? 'revealed' : 'opened', { name: legible(nameOf(file)) }) }
          : Object.hasOwn(OPEN_FAILURES, reply.error) ? { tone: 'error', text: t(OPEN_FAILURES[reply.error]) }
            : { tone: 'error', text: t('openFailed', { reason: reply.message ?? reply.error ?? '' }) })
      }

      const data = state.phase === 'ready' ? state.data : undefined
      const canOpen = data?.canOpen === true
      // a type a refresh left with nothing is no longer a filter, nor one again when it returns
      const present = data === undefined || kind === undefined ||
        data.stores.some((store) => store.notes.some((note) => note.type === kind))
      useEffect(() => { if (!present) setKind(undefined) }, [present])
      // a name filter over what was listed: case- and width-insensitive, the .md left out — by
      // the name as it is or as the page shows it (legible), so what is on the page can be typed
      const needle = query.trim().normalize('NFKC').toLowerCase()
      const match = needle === '' ? undefined
        : (file) => [nameOf(file), legible(nameOf(file))]
          .some((name) => name.normalize('NFKC').toLowerCase().includes(needle))
      let body
      if (state.phase === 'loading') body = h('p', { className: 'eng-note' }, t('listing'))
      else if (state.phase === 'error') body = h('div', { className: 'eng-banner', 'data-tone': 'error' }, t(state.reason))
      else {
        const notes = data.stores.flatMap((store) => store.notes)
        const archived = data.stores.reduce((sum, store) => sum + store.archive.length, 0)
        const counts = TYPES.map((type) => [type, notes.filter((note) => note.type === type).length])
          .filter(([, count]) => count > 0)
        const shown = present ? kind : undefined
        const tab = (type, label, count) => h('button', { type: 'button', className: 'eng-tab', key: type ?? 'all',
          'data-type': type ?? 'all', 'aria-pressed': shown === type, onClick: () => setKind(type) },
        label, h('span', { className: 'eng-tab-count' }, String(count)))
        const matched = match === undefined ? 0 : data.stores.reduce((sum, store) => sum +
          store.notes.filter((note) => (shown === undefined || note.type === shown) && match(note.name)).length +
          (shown === undefined ? store.archive.filter(match).length : 0), 0)
        body = [
          data.pinned === 'relative' ? h('p', { className: 'eng-note', key: 'pinned' }, t('pinnedRelative')) : null,
          data.location !== undefined ? h('p', { className: 'eng-note', key: 'location' }, t('locationUnknown')) : null,
          data.stores.length === 0 && data.pinned === undefined && data.location === undefined &&
            !(data.unreadable > 0) && data.more !== true
            ? h(NoMemory, { key: 'empty', t, onMoved: load })
            // projects' stores listed, the global one not made yet: still to be moved from here
            : data.stores.length > 0 && data.global === 'absent'
              ? h(NoMemory, { key: 'global', t, onMoved: load, note: 'global' }) : null,
          notes.length + archived > 0 ? h('div', { className: 'eng-toolbar', key: 'toolbar' },
            h('div', { className: 'eng-tabs', role: 'group', 'aria-label': t('typeLabel') },
              tab(undefined, t('typeAll'), notes.length),
              ...counts.map(([type, count]) => tab(type, t(typeKey(type)), count))),
            h('label', { className: 'eng-search' },
              icon('search', 15),
              h('input', { type: 'search', className: 'eng-input', value: query, placeholder: t('filterPlaceholder'),
                'aria-label': t('filterLabel'), onChange: (event) => setQuery(event.target.value) }))) : null,
          match === undefined ? null : h('p', { className: 'eng-filter-count', key: 'count', role: 'status',
            'aria-live': 'polite' }, t('filterCount', { count: matched })),
          ...data.stores.map((store) => h(StoreSection, { key: store.id, store, cap: data.cap, canOpen, open, match, onMoved: load,
            kind: shown, now: state.at, t })),
          data.more ? h('p', { className: 'eng-note', key: 'more' }, t('more')) : null,
        ]
      }
      return h('div', { className: 'eng-memory' },
        h(Hero, { data, at: state.at, refresh: () => { setStatus(undefined); load() }, t }),
        data === undefined ? null : h(Caveats, { data, t }),
        status ? h('div', { className: 'eng-banner', 'data-tone': status.tone, role: 'status' }, status.text) : null,
        data !== undefined && !canOpen && data.stores.length > 0 ? h('p', { className: 'eng-note' }, t('openUnavailable')) : null,
        body,
        h(HowTo, { open: data !== undefined && data.pinned !== 'relative' && data.more !== true &&
          !(data.unreadable > 0) && !data.stores.some((store) => hasMemory(store) || readInPart(store)), t }),
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

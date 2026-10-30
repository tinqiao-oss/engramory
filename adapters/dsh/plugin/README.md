[English](README.md) | [简体中文](README.zh-CN.md)

# dsh-engramory

[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Ftinqiao-oss__engramory.json)](https://unstone.github.io/dsh-xray/registry.html#tinqiao-oss__engramory)

Curated, file-based long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
plain markdown notes you can open with anything,
[one writer and many readers](../../reader/README.md) across hosts, and a pre-write
index guard for matched file tools. (If the store
lives inside a project's git repo it must be git-ignored — memories carry machine-local
detail; see SKILL.md §1. A *dedicated private* repo for the store itself is fine.)

Part of [Engramory](https://github.com/tinqiao-oss/engramory).

## Why a plugin, when an `AGENTS.md` block already works

The block carries the discipline. Three things it cannot do:

**The index is already in context — recall needs no read.** On every step the plugin
puts the memory index into dsh's runtime context: the project store
(`<project>/.engramory-memory/MEMORY.md`, the nearest one between the session's
directory and its git root — the way dsh finds a project's `AGENTS.md`) and the global one
(`$DSH_HOME/.engramory-memory/MEMORY.md`, `~/.dsh` when `$DSH_HOME` is unset) —
where `tools/engramory_init.py dsh` puts them — or, when set, `indexPath` alone. It is
re-read whenever it changes, so a write shows on the next request, and cut at the cap:
lines past it are left out, and the model is told to compact. Turn it off with
`injectIndex: false`.

**The cap becomes deterministic for matched tools.** `ctx.tools.guard()` is a
synchronous, **monotonic** refusal: once a guard returns a reason, later listeners
cannot allow the call. This keeps the index within its configured growth limits
without relying on the agent to run a checker. Use **`dsh-engramory >= 0.2.7`**;
[PORTING.md](../../../PORTING.md) records which hosts have shipped guards, and
[CHANGELOG.md](../../../CHANGELOG.md) holds release history.

**The protocol arrives with the plugin.** The skill is registered at runtime through
dsh's skill registry — via a reactive `ctx.inject(['skills'], …)` child, so a profile
without a registry still gets the cap and one whose registry activates late still gets
the skill — which means it does not depend on landing files in one of the five skill
roots dsh scans, a path that is easy to get subtly wrong and fails silently when you do.

## Install

Zero-dependency ESM with no build step; requires Node.js 18+ and `pnpm` on PATH
for dsh's plugin command.

```sh
dsh plugin --profile <name> add dsh-engramory
```

Check `dsh.compatibility.dshReleases` in [`package.json`](package.json) for the
exact compatible releases, backed by [`results.json`](../../../tests/dsh_e2e/results.json).
Use the [E2E guide](../../../tests/dsh_e2e/README.md) to verify another release.

The package ships a `dsh.bundle` manifest pointing at its own
`cordis.patch.yml`, so the row is inserted into the profile's plugin tree for you — no
hand-editing. To change a default, patch the EXISTING row by id in your profile's own
patch layer — do **not** use a second `- insert:` (insert always appends, so you would
end up with two engramory rows and the original caps still enforced):

```yaml
- id: engramory
  config:
    indexName: MEMORY.md
    maxLines: 200
    maxBytes: 25600
```

A patch replaces the targeted row's whole `config`, so list every key you mean to keep.

With the plugin alone, the memory is one global store, `$DSH_HOME/.engramory-memory/`
(`$DSH_HOME` defaults to `~/.dsh`): the skill tells the AI where it is, and the AI
creates it on its first save. A project can have a store of its own,
`.engramory-memory/` in its root, which only you create — the installer does it and
git-ignores it (`python tools/engramory_init.py dsh --project-root <project>`). The AI
never creates one; where one exists, what holds only in that project goes there, and
everything else stays in the global store. The installer also writes the always-on block
into `AGENTS.md` (`python tools/engramory_init.py dsh --install-skill`).

To uninstall:

```sh
dsh plugin --profile <name> remove dsh-engramory
```

## Companion mode (大肥鱼模式)

For a character the user chats with — the community's 大肥鱼, or any persona. Turn it on
with `companion: true`, or the 大肥鱼模式 switch on the settings page (below).

- **Three more types for the character's own life** ([SKILL.md §2.2](../../../SKILL.md)):
  `moment` — something the character and the user shared, with its date; kept, and
  folded into a monthly archive when the index fills. `upcoming` — something coming up
  in the user's life; asked about once its date passes, and rewritten as a `moment`
  once the user has said how it went. `self` —
  a change in the character itself, such as a nickname; updated in place, never folded.
  A `moment` or `self` note is deleted only when the user asks to forget. In a Chinese
  store their headings are `## 经历`, `## 约定` and `## 我自己`. The other four types
  keep their meaning.
- **Recall in character.** The agent is told that, when it plays a character for you,
  any message, a greeting included, may call for recall, and to speak of what it
  remembered — or failed to save — in character, without naming files or tools.
- **The persona preset decides what it can do with memory.** With companion mode or
  social mode on, what a conversation is given — the memory and its rules, or social
  mode's note — is a *required* runtime context, so it arrives even under a preset that
  turns optional context off (dsh-persona's `includeRuntimeContext: false`, as dsh's
  `minimal` preset does). Saving is another matter: the preset needs dsh's file tools and
  the skill tool for the character to write notes the way the skill describes. A preset
  with only a shell can read the memory it is given, and its writes go past the guard.

## Social mode

A choice inside companion mode, for a character other people can talk to as well — one
wired to QQ, WeChat, Douyin or Bilibili through a bridge plugin. With companion mode on,
choose *Social* (社交) under *Memory access* (记忆权限) on the settings page, or set
`audience: social`. The default, *Private* (专属), gives every conversation the memory:
if only you talk to this dsh, keep it. Without companion mode, `audience` changes
nothing.

- **Only your own conversations get the memory.** A conversation is yours when you have
  written in it in dsh's own window — the desktop app or `dsh web` — and nobody else has.
  dsh stamps every user message with where it came from, and its browser client sends
  each prompt with a request id and the browser's time zone: that is how a message you
  typed there is told apart. Everything else is someone else's:
  - a message a bridge plugin submits, under a kind of its own (`plugin:<name>`, as
    dsh-onebot writes, or any other kind dsh's own producers do not use) or dsh's plain
    `user` kind, unless the bridge marks it as yours (the standard below);
  - a program calling dsh web's API, `dsh headless`, an editor or terminal client;
  - a conversation an automation or a plugin opened, until you write in it;
  - a caller dsh itself names as someone other than the owner.

  Once anyone else has written in a conversation it stays theirs, even after you write
  in it too: what the memory put into it earlier stays in its history. Messages dsh
  adds itself (runtime context, skills, compaction, agent-to-agent messages) decide
  nothing.
- **Someone else's conversation gets no memory:** no index, a note saying so, no full path
  to the store (the skill, which every conversation reads, gives none in social mode; your
  own conversations are told it in their runtime context), and file tools that may name
  files only. A directory is refused (so grep, glob and directory
  views are — any tree may hold a store), and so is any path into a store, however it is
  spelled or linked, including a store that does not exist yet, so none can be planted
  for you. A subagent is yours while its live parent is — read afresh on every call —
  and nobody else has written to it directly; a forked conversation is judged by its own
  history, the part it inherited included. A call with no session, a
  dsh without session projections, or a network path counts as someone else's.

This keeps the user's memory out of others' context by the routes dsh's own file tools
take. It is **not** a security boundary: a shell tool reads any file, and a different
profile on the same account can still read the store's files. Keeping others away from
the store needs filesystem permissions or a sandbox.

### For bridge authors: marking who wrote a message

With social mode on, every message a bridge submits counts as someone else's. For the
owner's own chat to get the memory — their private QQ chat with the character, say —
put a `speaker` on the message's source:

```js
agent.followup(createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin:your-bridge', speaker: { role: 'owner' } },
}))
```

| `speaker.role` | Meaning |
|---|---|
| `owner` | The dsh owner wrote it: a message from the account the user set as theirs in your bridge. |
| `guest` | Someone else wrote it — the same as no `speaker` at all. |
| `none` | Nobody wrote it: your plugin's own report, reminder or notice. It does not turn the owner's conversation into someone else's. |

Mark a message `owner` only when it comes from the owner's own account. A group's
conversation stays someone else's once anyone else in it speaks. dsh keeps unknown
source fields in the session log, so the role survives a restart.

A program that talks to dsh only through dsh web's API cannot set a source, and its
messages count as someone else's — unless it sends `clientTimeZone` with a prompt: dsh
then records exactly what its own page sends, and the message counts as the owner's. A
program forwarding other people's messages must leave `clientTimeZone` out.

## Settings page

On dsh's **Plugins** page, open *Engramory memory*: its page sets companion mode (a
switch) and, while it is on, its memory access (private or social), and the index cap.
The memory's language follows dsh's own (see `language` below).

Saving goes through dsh's own profile editor: it validates the whole config, writes it
to your profile's `cordis.patch.yml`, and reloads the plugin with it — or leaves the
file as it was. A save made against settings that changed elsewhere in the meantime is
refused, and the page reads them again. Settings put back to their defaults remove
their override instead of pinning it. Other fields (`indexName`, `indexPath`, …) stay
in the file.

Only you reach the page's route — your signed-in browser, or a program holding your
login: dsh answers 401 to a request without it and 403 to a cross-site one, so an agent
cannot call it to switch social mode off. A dsh without the profile editor shows the page read-only.
Companion mode and its memory access are also at the top of the memory page (below).

## Memory page

dsh's sidebar gets a **Memory** entry. Its page lists the stores recall can use — the
global store under `$DSH_HOME` and each workspace's project store, found as recall finds
one, or, with `indexPath` pinned, that index's directory alone — with each index's size
against the cap, its notes' names by type, and its archive. It is read-only and shows
names only, never a note's text: a name opens the note in your computer's default app,
through dsh's own opener, on the machine dsh runs on. Where dsh says it cannot open there
(over SSH, say), the names are plain text and the page shows where the files are.
*Open the index* opens the index the same way; *Open the folder* shows the index in your
file manager (Explorer and Finder select it in the store's folder; on Linux the folder
opens), so a store with no index has no such button. At the top, companion mode and its
memory access save as they are switched; what they mean, and the index cap, are on the
settings page.

The listing is bounded — 2000 entries looked at per folder, 200 workspaces, 5000 names in
all — and never looks into a workspace on a network share path (`\\server\share\…`), or
one whose folder has since become a link to somewhere else. A note that is a link is not
listed; what is opened is a note or the index found again, by name, directly in its store,
and refused if it has become a link. A relative `indexPath` follows each conversation's
directory, so the page cannot list it. Only you reach the page's route, as the settings
page's.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `indexName` | `MEMORY.md` | Basename treated as the memory index (case-insensitive; both `file_path` and `str_replace_editor`'s `path` are checked) — the name a write is called by, or the name of the file it lands on, so a symlink under another name is caught too. An empty or non-string value falls back to the default. |
| `maxLines` | `200` | Hard line cap. Non-positive or non-finite values fall back to the default. |
| `maxBytes` | `25600` | Hard UTF-8 byte cap (25 KB). |
| `indexPath` | unset | Absolute path of the ONE index to guard. Without it the guard matches on basename alone, so an unrelated `MEMORY.md` in another project is gated too; set this and only that exact file is. Compared by identity — the file the write lands on, whatever it is called (symlinks and `..` resolved; case-folded on Windows only) — and a path that does not exist yet still has its first write guarded. |
| `registerSkill` | `true` | Set `false` to keep the cap but skip the runtime skill. |
| `injectIndex` | `true` | Put the memory index into dsh's runtime context on every step (see above). Set `false` to recall by reading the file instead. |
| `language` | dsh's | Unset (or empty), the memory follows dsh's language — the one chosen in dsh's Settings → General, else the language of the system dsh runs on (dsh's page, with no choice made, follows the browser's, so on a remote `dsh web` the two can differ); a change applies once dsh restarts. Set it to pin one: `zh` writes the store in Chinese (SKILL.md §1.1): Chinese note names, `## 用户` / `## 反馈` / `## 项目` / `## 参考` headings, `**为什么：**` / `**怎么用：**` labels, and the skill and the injected index in Chinese. Frontmatter keys and `type:` values stay English, so every host still reads the store. The cap's refusals stay English. `zh` and its regional forms (`zh-CN`, `zh-TW`, …) select Chinese; any other string selects `en`. |
| `companion` | `false` | `true` turns companion mode on (above): three more types for the character's own life, and recall in character. Only the boolean `true` counts. |
| `audience` | `private` | With companion mode on, `social` turns social mode on (above): only your own conversations get the memory. Any other value is `private`, where every conversation does. Without companion mode it changes nothing. |
| `skill` | built-in | Replace the skill body with your own markdown — which must then say where the store is itself. |

## What the guard actually does

| Call | Decision |
|---|---|
| `write` (or `str_replace_editor` `create`) ending within caps | allow |
| `write`/`create` that GROWS the index past a cap | **deny**, naming the numbers and what to compact |
| `write`/`create` that SHRINKS or keeps an over-cap index | allow — incremental compaction (210 → 205 → 198) must stay possible |
| Edit carrying `old_str`/`new_str`: result simulated | judged by the RESULT, same grow/shrink rule as a write — sized before it is built, so a `replace_all` whose result would be too long to build is judged on lower bounds of its bytes and lines |
| Unsimulable partial (e.g. `insert`) on an over-cap index | **deny**, telling the agent a shrinking whole-file write passes |
| Unsimulable partial on a healthy index | allow |
| `read`, `view`, or any unknown tool | allow — recall must never be blocked, even over cap |
| Any write to any other file | allow — not the guard's business |
| Missing/unreadable current index on a whole-file write | treated as EMPTY (mirrors the Python guard) — a within-caps write passes, an over-cap first write is refused |
| Missing/unreadable index on a partial edit | allow — a guard must never block work over a path it cannot read |
| A FIFO, device, or directory under the index's name | never read — counts as unreadable (a read there would hang or flood the host, which runs guards on its main thread) |
| An index past the read limit (`min(16 MiB, max(1 MiB, 4 × maxBytes))`) | not read whole: a whole-file write is judged on bytes against the filesystem's size (every shrink passes; its line count is unknown, so lines are not capped there), and an edit passes unmeasured, as on an unreadable index |
| Malformed execution (no arguments, non-string path/content) | allow — not recognisably a write |

For measured results, deny only a dimension that is over its cap AND grew past
the current file. The line count ignores a trailing newline, so an index exactly
at the cap stays writable. This decision table is pinned by `node --test` in CI.

Relative paths use the session's `workingDirectory` service when available,
falling back to the process cwd. Edits match LF-normalised text and preserve the
file's line endings when sizing the result, including CRLF bytes.

## Known limits

- **Unsimulable partial edits can cross the cap from below.** On a readable,
  already-over-cap index they are denied; use a shrinking whole-file write to
  compact. Missing/unreadable files and the read-limit exceptions are listed above.
  Run `engramory_check.py` after index edits and `engramory_doctor.py` periodically.
- **Coverage is limited to known file tools:** `write`/`edit` with `file_path`,
  `str_replace`/`insert`, and mutating `str_replace_editor` commands with `path`.
  Unknown tools pass. **Shell tools, MCP file tools, and external editors bypass
  the guard.**
- **Injection finds the stores where the installer puts them.** A store elsewhere
  (`--memory-root`) needs `indexPath`. The project root is found by dsh's default `.git`
  marker only (a profile's custom `projectRootMarkers` are not visible to a plugin), and
  a project store created mid-session can take up to ten seconds to appear. A project
  store whose real path leaves the project — a symlink out of the checkout — is not
  read; point `indexPath` at it if that is deliberate. The global store's location comes
  from `$DSH_HOME`, resolved the way dsh resolves it. What is injected is framed as notes,
  not instructions, that may be stale; a host without runtime context
  (no `ctx.systemPrompt.context`) goes without it.
- **Social mode knows your typing by what dsh's browser client sends.** A program that
  sends the same request id and time zone as dsh's own page is taken for you, and a
  browser whose time zone cannot be read leaves your messages unmarked. dsh's terminal,
  editor (ACP) and SDK clients do not mark them either: with social mode on, only
  dsh's own window counts.
- **Some of dsh's messages carry no author.** An answer to the agent's question, a
  scheduled prompt and a message a slash command adds (`/plan <text>`, `/goal`'s
  attachments) count as nobody's, and a queued message edited through dsh's API keeps the
  author it had. On dsh 0.2.1 only the owner can answer, schedule or edit — in dsh's
  window, or through a program with the owner's login, which can read the store's files
  through dsh's own file API anyway — and a chat bridge that forwards a command runs it in
  its own conversation, which its other messages already make someone else's.
- **A kind of message a later dsh adds counts as someone else's** until this plugin knows
  it: a conversation of yours may lose the memory, never the other way round.
- **The memory page reads the disks as they answer.** On a filesystem whose directory
  entries carry no type (some network mounts), Node stats each listed entry on dsh's main
  thread, at most 2000 per folder; and a listing stuck on a drive that never answers keeps
  reporting a timeout until it does, rather than starting another that would get stuck too.
- **What the memory page opens is checked by path.** dsh's opener takes a path, which it
  resolves once more before the desktop opens it; a process changing a store's files at
  that very moment could still redirect what the desktop opens — as with dsh's own opener
  for any workspace file — though not to a link the page saw.
- dsh's plugin API can change. The plugin uses `ctx.tools.guard()` and reactive
  `ctx.inject()` children for the skill registry, the session working directory, the
  prompt registry, and — in social mode — dsh's session projections, where it folds
  who has written in each session; a compatible-release declaration needs recorded host
  evidence, not just unit tests. The recorded end-to-end runs cover the cap, the skill
  and the injected index; companion mode, social mode, the settings page and the memory page were checked by hand on
  a real dsh (0.2.1-rc.5) — messages typed in dsh's window, sent by `dsh headless` and by
  a program through dsh web's API, a save through the page, and the memory page's listing,
  a switch saved from it and a note opened from it — but are not part of that record yet.

## License

MIT — see the [Engramory repository](https://github.com/tinqiao-oss/engramory).

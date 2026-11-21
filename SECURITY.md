# Security Policy

Engramory is a local developer tool: a discipline, a Claude Code index hook, a dsh
guard plugin (`adapters/dsh/plugin/`) and helper scripts. It runs entirely on your machine and opens no network service of its own. Two things
touch a network, both in the dsh plugin's settings and memory pages:

- **Four routes on dsh's own web server**, which dsh answers only for the signed-in
  owner. `/api/engramory/settings` saves the plugin's settings into the dsh profile.
  `/api/engramory/memory` lists note names and asks dsh to open a note, or show a
  store's folder, on the dsh machine. `/api/engramory/store` says where the global
  store is and moves it to another local folder: it copies the store there, checks the
  copy, then removes the old place. `/api/engramory/store/pick` opens dsh's own folder
  chooser on the dsh machine. None serves a note's text.
- **One outbound request, on a click.** "Check for updates" on the memory page asks the
  npm registry (then npmmirror, when npm gives no version) for the plugin's latest
  version number: from the browser, with no cookie, no referrer and nothing from the
  store. The plugin calls out at no other time, and its host half (`index.js`) never
  does.

## Reporting a vulnerability

Please **do not** open a public issue for a security-sensitive report. Instead open a
private GitHub Security Advisory on this repository, or email **support@tinqiao.com**
with details and a minimal repro. We aim to acknowledge within a few business days
(no formal SLA).

## Scope & threat model

- **The store is plain, unencrypted text** by design. `.gitignore` is not a security
  boundary: a store in a synced or backed-up folder leaves the machine. **Never put
  secret values in memory**, only where they live; this is unenforced discipline
  (`SKILL.md` §5).
- **The index caps are size nudges, not security controls.** The Claude Code hook
  fails open on unexpected input (it must never brick editing) and sees only
  `Edit | Write | MultiEdit`; the dsh plugin sees only dsh's own file tools, and not
  `apply_patch` (dsh 0.2.2-alpha.3 on, off by default), whose paths are in its patch
  text. Shell tools (Bash, PowerShell, background commands), MCP file tools, external
  editors and sync clients go past both.
- **The dsh plugin's social mode is best-effort, not access control.** It keeps the
  memory out of conversations that are not the owner's by not injecting it there and
  refusing dsh's file tools pointed at a store. It recognises the owner by what dsh's
  browser client sends, which a program can imitate; a shell tool reads any file, and
  another profile on the same account can read the store. Real isolation needs
  filesystem permissions or a sandbox.
- **Moving the dsh plugin's global store is careful, not atomic.** The store route
  copies regular files and folders only; refuses as a destination a network path (a
  share mapped to a drive letter is not recognised), a link, a whole drive, the home
  folders and a folder with anything in it; never replaces a file at the new place (one
  changed in both places is kept beside it, with a line added to the index); and
  removes the old place file by file, each after it is compared. While it runs it holds
  off writes made through dsh's file tools (`write`, `edit`, `str_replace_editor`,
  `apply_patch`) and nothing else: a shell, an MCP file tool, an editor or another host writing to the
  store at that moment is not coordinated. Its link checks are on paths, so a process
  that swaps a folder for a link between a check and its use can still redirect a copy
  or a removal (as with the installer, below).
- **Memory is attacker-influenceable input.** Another process, a synced document or a
  manipulated earlier session can alter the files, and a tampered `feedback` note is a
  *stored prompt injection*. Engramory does not authenticate memory: recall is advisory
  data, never a command, and never outranks the user's live instructions or safety
  (`SKILL.md` §4). Keep the store private and review surprising memories.
- **The installer's symlink-escape checks are best-effort.** `engramory_init.py`
  refuses targets outside `--project-root` and re-checks before each write, delete and
  copy, but an attacker who swaps a parent directory for a symlink between check and
  write still wins (closing that needs handles the stdlib lacks). It does not roll
  back: a failure part-way leaves the completed steps and reports them.

**In scope:** a crafted `tool_input` that makes the hook wrongly block or pass a real
index edit; a crafted dsh tool execution that does the same to the plugin; output that
is not safely JSON-encoded. **Out of scope:** the store being readable by local processes
(intended) and the unenforced secrets discipline (documented).

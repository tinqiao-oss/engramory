# Codex adapter

Codex uses the Engramory rules and optional skill with a local plain-file store.

```sh
python tools/engramory_init.py codex --project-root /path/to/project --install-skill
```

The installer adds a marked rules block to `AGENTS.md`, creates the store at
`.engramory-memory/`, and adds its path to `.gitignore`. Pass `--memory-root`
to use an existing store. The optional skill is installed in
`.agents/skills/engramory/`. Keep the store separate from Codex native Memories.

Before compacting, clearing, or starting a new thread, run the continuity sync
in [SKILL.md](../../SKILL.md). After writing the index, run
`python tools/engramory_check.py <MEMORY.md>` and compact it if over the cap.
The cap is best-effort rules, check, and doctor; there is no pre-write deny shim.

To recall from a store owned by another host, use `codex-reader` with
`--memory-root` pointing at that existing store. See the
[reader adapter](../reader/README.md).

# dsh-worktree

English | [中文](README.zh.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

Codex-style **permanent git worktrees** for DeepSeek Harness — a Cordis
plugin that gives a DSH profile the same durable-worktree workflow as
`codex worktree create --permanent`.

A permanent worktree is a real `git worktree add --detach` checkout that
**survives sessions and restarts**. You (or the agent) create it once, and
any later session can be opened inside it to keep working where the previous
one left off — without ever touching your main working tree.

## What you get

| Codex CLI | dsh-worktree equivalent |
|---|---|
| `codex worktree create --permanent <name> [<base>]` | agent tool `worktree_create`, or `/worktree create <name> [<base>]` |
| `codex worktree list` | agent tool `worktree_list`, or `/worktree` / `/worktree list` |
| `codex worktree open <name>` | `/worktree open <name>` (registers the worktree as a DSH workspace; start a new session there) |
| `codex worktree close/delete <name>` | agent tool `worktree_remove`, or `/worktree remove <name>` |
| worktree shown in session context | one-shot context note when a session runs inside a registered worktree |

On top of the CLI parity, the model itself gets the tools, so it can fork
its own permanent workspace mid-task — create a worktree at a specific
commit, work there with the normal file tools, and clean up afterwards.

## How it works

- Worktrees live at `<repo-root>/.dsh-worktrees/<name>` — the same hidden
  directory pattern as Codex's `.codex/worktrees/` — so they stay inside the
  repository (and, when the session workspace is the repo root, inside the
  session's `workspace-write` sandbox).
- Every worktree is recorded in a per-repository manifest,
  `<repo-root>/.dsh-worktrees/manifest.json` (name, path, base commit,
  created-at, creator session). The manifest is what makes worktrees
  **permanent**: they survive DSH restarts, are listed by the tools/command,
  and are recognized when a new session is opened inside one.
- Creating a worktree also registers it in `ctx.workspaceRegistry`, so it
  appears in the DSH workspace list — the native way to "open" it later.
- Removing a worktree runs `git worktree remove` (with `--force` when
  requested), deletes the manifest entry, and unregisters the workspace.
  It refuses to remove the worktree the current session is running inside.

## Requirements

- git ≥ 2.31 (uses `git rev-parse --path-format=absolute --git-common-dir`).
- A DSH profile with the `tools`, `commands`, and `subprocess` services
  (the `web` profile has all three via `dsh-base`).

## Installation

```sh
# 1. make the plugin available to your profile (installs from npm)
dsh plugin --profile web add dsh-worktree

# 2. activate it in the profile's patch layer
#    add to ~/.dsh/profiles/web/cordis.patch.yml:
#
#    - insert:
#        - id: worktree
#          name: 'dsh-worktree'

# 3. restart the profile (e.g. restart the `dsh web` process)
```

Installing from source (development, or to match a different harness version):

```sh
git clone https://github.com/FlashingChen/dsh-worktree.git
cd dsh-worktree
npm install            # self-contained deps, pinned to the harness versions
dsh plugin --profile web add "$PWD"
# ... then the patch row and restart as above
```

> The plugin's dependencies are pinned to the harness versions it was built
> against (`@deepseek-ai/* 0.1.0-rc.6`). If your DSH installation is a
> different version, install from source and run `npm install <matching
> versions>` in the plugin directory (or adjust `package.json`) so the
> plugin loads against your harness.

Configuration (all optional):

```yaml
- insert:
    - id: worktree
      name: 'dsh-worktree'
      config:
        dirName: .dsh-worktrees   # directory inside each repo root (default)
```

## Usage

### Agent tools

- `worktree_create {name, baseCommit?}` — create a permanent detached
  worktree of the repository containing the current session (default base:
  current HEAD). Returns the worktree path, repo root, and base commit.
- `worktree_list` — list registered worktrees with live git state
  (exists, HEAD, branch).
- `worktree_remove {name, force?}` — remove a registered worktree
  (`--force` also discards uncommitted changes). Refuses to remove the
  worktree the current session is working inside.

### Chat command

```
/worktree                          # list (same as /worktree list)
/worktree list
/worktree create <name> [<base-commit>]
/worktree open <name>              # print path/state + register as workspace
/worktree remove <name>            # (close/delete accepted as aliases)
```

### Session context

When a session's workspace is inside a registered permanent worktree, the
agent is told once: which worktree, of which repo, at which base commit,
plus the management commands.

## Sandbox note

The git operations run through DSH's own `ctx.subprocess` seam (not the
agent bash tool), like other harness-managed processes. With the default
`workspace-write` permission mode, worktree files are writable by the agent
when the worktree lives under the session's workspace root — which is the
case whenever the session was started at the repository root (the normal
setup). If a session starts from a subdirectory of the repo, `.dsh-worktrees`
lands outside that session's workspace; open a new session with the worktree
as its workspace to work inside it.

## Development

- `node test/smoke.js` — standalone end-to-end test of the git logic against
  a scratch repository (no DSH boot needed).
- Activation check: boot a minimal cordis tree
  (`system-prompt`, `tools`, `commands`, `subprocess`, `dsh-worktree`) from
  the profile's node_modules and assert registration + a real
  create/list/remove round trip.

## Layout

```
lib/manager.js   WorktreeManager: repo discovery, git worktree lifecycle,
                 per-repo manifest (pure logic over ctx.subprocess)
lib/index.js     Cordis plugin: Config, tools, /worktree command,
                 one-shot session context note, ctx.worktree service
test/smoke.js    standalone smoke test
```

## License

MIT — see [LICENSE](LICENSE).

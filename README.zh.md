# dsh-worktree

[中文](README.zh.md) | [English](README.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

为 DeepSeek Harness 打造的 **Codex 同款永久 git 工作树** 插件——让 DSH profile 获得与 `codex worktree create --permanent` 一样的持久工作树工作流。

永久工作树是一个真实的 `git worktree add --detach` 检出目录，**跨会话、跨重启永久存在**。你（或 agent）创建一次，之后任何会话都可以在它里面继续之前的工作——完全不碰你的主工作树。

## 功能一览

| Codex CLI | dsh-worktree 对应能力 |
|---|---|
| `codex worktree create --permanent <name> [<base>]` | agent 工具 `worktree_create`，或 `/worktree create <name> [<base>]` |
| `codex worktree list` | agent 工具 `worktree_list`，或 `/worktree` / `/worktree list` |
| `codex worktree open <name>` | `/worktree open <name>`（注册为 DSH 工作区；在那里开新会话即可） |
| `codex worktree close/delete <name>` | agent 工具 `worktree_remove`，或 `/worktree remove <name>` |
| 会话中展示工作树信息 | 会话运行在已注册工作树内时，agent 收到一次上下文提示 |

除了 CLI 对齐，模型本身也能使用这些工具：任务进行中就可以自己派生一个永久工作空间——在指定 commit 上创建工作树、用常规文件工具在里面干活、用完清理。

## 工作原理

- 工作树位于 `<仓库根>/.dsh-worktrees/<name>`——与 Codex 的 `.codex/worktrees/` 相同的隐藏目录模式——因此始终在仓库内部（当会话工作区就是仓库根时，也在会话的 `workspace-write` 沙箱内）。
- 每个工作树都会写入按仓库持久化的 manifest：`<仓库根>/.dsh-worktrees/manifest.json`（名称、路径、基线 commit、创建时间、创建者会话）。manifest 就是"永久"的载体：DSH 重启后依然存在，可被工具/命令列出，新会话在其中打开时也能被识别。
- 创建工作树的同时会注册到 `ctx.workspaceRegistry`，出现在 DSH 工作区列表里——这就是之后"打开"它的原生方式。
- 移除工作树会执行 `git worktree remove`（可选 `--force`）、删除 manifest 条目并注销工作区；拒绝删除当前会话正在运行其中的工作树。

## 环境要求

- git ≥ 2.31（使用 `git rev-parse --path-format=absolute --git-common-dir`）。
- 带 `tools`、`commands`、`subprocess` 服务的 DSH profile（`web` profile 通过 `dsh-base` 三者齐全）。

## 安装

```sh
# 1. 让 profile 可用该插件（从 npm 安装）
dsh plugin --profile web add dsh-worktree

# 2. 在 profile 的 patch 层激活
#    在 ~/.dsh/profiles/web/cordis.patch.yml 中加入：
#
#    - insert:
#        - id: worktree
#          name: 'dsh-worktree'

# 3. 重启 profile（例如重启 `dsh web` 进程）
```

从源码安装（开发调试，或用于匹配不同版本的 Harness）：

```sh
git clone https://github.com/FlashingChen/dsh-worktree.git
cd dsh-worktree
npm install            # 自带依赖，与 Harness 版本对齐
dsh plugin --profile web add "$PWD"
# ... 然后同上加激活行并重启
```

> 插件依赖锁定在构建时对应的 Harness 版本（`@deepseek-ai/* 0.1.0-rc.6`）。如果你的 DSH 安装版本不同，请从源码安装，并在插件目录执行 `npm install <匹配版本>`（或修改 `package.json`），确保插件能对你的 Harness 正常加载。

配置（全部可选）：

```yaml
- insert:
    - id: worktree
      name: 'dsh-worktree'
      config:
        dirName: .dsh-worktrees   # 每个仓库根内的工作树目录名（默认值）
```

## 使用方法

### Agent 工具

- `worktree_create {name, baseCommit?}` —— 在当前会话所在仓库创建永久分离工作树（默认基线：当前 HEAD）。返回工作树路径、仓库根和基线 commit。
- `worktree_list` —— 列出已注册工作树及其实时 git 状态（是否存在、HEAD、分支）。
- `worktree_remove {name, force?}` —— 移除已注册工作树（`--force` 会连同未提交改动一起丢弃）。拒绝删除当前会话所在的工作树。

### 聊天命令

```
/worktree                          # 列出（同 /worktree list）
/worktree list
/worktree create <name> [<base-commit>]
/worktree open <name>              # 打印路径/状态 + 注册为工作区
/worktree remove <name>            # （close/delete 也接受）
```

### 会话上下文

当会话的工作区位于已注册的永久工作树内时，agent 会收到一次提示：在哪个工作树、属于哪个仓库、基线 commit 是什么，以及管理命令。

## 沙箱说明

git 操作走 DSH 自己的 `ctx.subprocess` 通道（而非 agent 的 bash 工具），与其他 Harness 托管的进程一致。默认 `workspace-write` 权限模式下，只要工作树位于会话工作区根之下（会话在仓库根启动即是如此，属常规场景），agent 即可写入工作树文件。如果会话从仓库子目录启动，`.dsh-worktrees` 会落在该会话工作区之外；把工作树作为工作区开一个新会话即可在其中工作。

## 开发

- `node test/smoke.js` —— 针对临时仓库的 git 逻辑端到端冒烟测试（无需启动 DSH）。
- 激活检查：用 profile 的 node_modules 最小化启动 cordis 树（`system-prompt`、`tools`、`commands`、`subprocess`、`dsh-worktree`），断言注册成功并完成一次真实的 create/list/remove 往返。

## 目录结构

```
lib/manager.js   WorktreeManager：仓库发现、git 工作树生命周期、
                 按仓库持久化的 manifest（基于 ctx.subprocess 的纯逻辑）
lib/index.js     Cordis 插件：Config、工具、/worktree 命令、
                 一次性会话上下文提示、ctx.worktree 服务
test/smoke.js    独立冒烟测试
```

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

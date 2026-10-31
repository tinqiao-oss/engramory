**简体中文** | [English](README.en.md)

<p align="center"><img src="brand/anim/engramory-merged.gif" alt="Engramory 标志动画：书往右翻开，在光标处打出 engramory" width="640"></p>

# Engramory

[![CI](https://github.com/tinqiao-oss/engramory/actions/workflows/test.yml/badge.svg)](https://github.com/tinqiao-oss/engramory/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Ftinqiao-oss__engramory.json)](https://unstone.github.io/dsh-xray/registry.html#tinqiao-oss__engramory)

**通用 Agent 长期记忆层。** AI 记住的东西存成一个个普通 markdown 文件，一个只放指针的索引 `MEMORY.md` 列出全部笔记，每次会话开头读进来，细节要用时再打开。不需要数据库、向量或服务器，文件你能直接看、能改。Claude Code、Codex、[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）、OpenClaw、Kiro 等都能用；一个工具负责写，别的工具可以只读同一个库。

**dsh 有专用插件** `dsh-engramory`：装上就能用，每轮自动带上索引，把索引写超上限的写入大多在落盘前就被拦下，侧栏还多一个记忆页。Claude Code 用 hook 拦超限写入；其他工具靠规则加校验脚本。

> 名字来自 *engram*（记忆痕迹）+ *memory*。本项目是 `tinqiao-oss/engramory`（dsh 插件的 npm 包叫 `dsh-engramory`），与其他所有者名下的同名仓库无关。

> 🤖 **你是被要求安装或检查它的 AI agent？** 先读 [AGENT-SETUP.md](AGENT-SETUP.md)。

> **状态:1.0.4。** 记忆库格式、工具和索引上限从此只在主版本做不兼容改动，见[版本规则](#版本规则)。

## 长什么样

```text
.engramory-memory/
├── MEMORY.md           索引：每条笔记一行
├── 改完先跑测试.md      一个文件 = 一条事实
├── 数据库迁移约定.md
└── archive/            过时的笔记归档在这里
```

索引里的一行：`- [改完先跑测试](改完先跑测试.md) — 改代码后先跑测试再说完成`

一条 `feedback` 笔记记下一次可复用的纠正，带上原因和用法：

```markdown
---
name: 改完先跑测试
description: 改代码后先跑测试再说完成
type: feedback
created: 2026-10-31
updated: 2026-10-31
---
改完代码先跑测试，过了再说完成。
**为什么：** 有一次没跑测试就报完成，CI 挂了。
**怎么用：** 任何代码改动收尾前跑一遍测试。
```

## 安装

> dsh 插件从 npm 装，别的都不需要。其他工具需要 Python 3.9+，在本仓库目录里运行；macOS / Linux 没有 `python` 就用 `python3`。

### DeepSeek Harness（dsh）

```sh
dsh plugin --profile <名字> add dsh-engramory
```

dsh 桌面版也可以在插件页搜 `dsh-engramory` 安装。装好就能用：记忆默认存在 `~/.dsh/.engramory-memory/`，侧栏多一个只读的「记忆」页。配置、大肥鱼模式、社交模式和上限规则见[插件说明](adapters/dsh/plugin/README.md)。

![dsh 里的记忆页](https://raw.githubusercontent.com/tinqiao-oss/engramory/master/adapters/dsh/plugin/screenshots/memory-page.png)

### Claude Code

1. 把 [`rules-snippet.md`](rules-snippet.md) 贴进 `~/.claude/CLAUDE.md`（所有项目）或项目的 `CLAUDE.md`。
2. 可选：把本仓库复制或链接为 Claude Code 技能目录下的 `engramory/`，让 [`SKILL.md`](SKILL.md) 按需可用。
3. 按 [`hooks/settings.snippet.json`](hooks/settings.snippet.json) 在 `settings.json` 里注册写前 hook。

具体路径和验证 hook 确实生效的方法见 [hooks/INSTALL.md](hooks/INSTALL.md)。另附 `tools/engramory_trace.py`，在本地只读搜索 Claude Code 的会话记录，查某条记忆当时的来龙去脉。

### Codex

```sh
python tools/engramory_init.py codex --project-root /path/to/project --install-skill
```

默认库在 `<项目>/.engramory-memory/`，已有目录用 `--memory-root` 指定；和 Codex 自带的 Memories 分开。加 `--install-hooks` 可装生命周期提醒，要在 Codex 里信任项目 hook 才会运行（`/hooks` 查看）。每条消息都开新会话的聊天桥接，先看 [adapters/codex/README.md](adapters/codex/README.md) 里的说明。

### 其他宿主

- **OpenClaw：** `python tools/engramory_init.py openclaw --install-skill`，见 [adapters/openclaw](adapters/openclaw/README.md)。
- **Kiro：** 手动复制 steering 模板，见 [adapters/kiro](adapters/kiro/README.md)。笔记别放进 `.kiro/steering/`，否则每次请求都会全部加载。
- **Cursor、Cline、Hermes 等：** 按 [PORTING.md](PORTING.md) 把 `rules-snippet.md` 放进常驻指令。接入已有的记忆库见其中 [Adopting an existing store](PORTING.md#adopting-an-existing-store)。

这些宿主没有写前上限，靠规则、写完索引后跑 `tools/engramory_check.py`、定期跑 `tools/engramory_doctor.py`。

### 让另一个 AI 只读同一个库

一个库只有一个 AI 负责写，别的 AI 只读（[单写者、多读者](adapters/reader/README.md)）：

```sh
python tools/engramory_init.py codex-reader --project-root ~/.codex \
  --memory-root ~/.claude/projects/<project>/memory
```

读者不建库，`--memory-root` 里必须已有 `MEMORY.md`。"只读"靠规则约束，不是强制的；回忆到的内容会发给那个宿主的模型服务商。详见[读取器指南](adapters/reader/README.md)。

## 为什么这样做

- **索引小，细节按需打开。** 索引每次会话开头都要读进来（宿主自动注入，比如 dsh 插件；或者由 AI 自己读），所以只放指针，默认上限 200 行 / 25 KB。
- **笔记要整理，不是堆日志。** 四种类型 `user | feedback | project | reference`。写之前查重，能更新旧笔记就不新建，过时的删掉或归档，git 和代码里已有的不重复记。陪伴角色另有 `moment`（经历）、`upcoming`（约定）、`self`（我自己）三类（[SKILL.md](SKILL.md) §2.2）；记忆库可以用中文写（§1.1）。
- **写入前卡上限。** 在 dsh（插件）和 Claude Code（hook）上，算得出结果、会把索引写超上限的写入，在写入前就被拒绝，压缩照样放行。其他工具靠规则加校验脚本。
- **任务续接不另建交接库。** 没做完的任务只留一条 `project` 笔记，就地更新状态和下一步；compact、清空或开新线程前做一次[续接同步](PORTING.md#3-wire-continuity-sync--explicit-first-hooks-optional)。

## 和别的方案比

- **原生记忆**（如 Claude Code auto-memory）：同样是索引加详情文件；Engramory 多了明确的整理规则和写前上限。
- **检索和自动捕获系统**（basic-memory、mem0、Zep、agentmemory 等）：面向大量记忆；Engramory 不做搜索和自动摄取，只管人工精选的个人记忆。
- **不做 MCP server。** 对能读写文件、能加载常驻规则的宿主，MCP 会多出一条绕过写前上限的写入通道，还会把"每次都加载的索引"降级成"模型得记得去调用的工具"。两样都没有的宿主，可以把 MCP 当补充入口。

## 卸载

dsh 插件：`dsh plugin --profile <名字> remove dsh-engramory`。用安装脚本装的，用安装时的宿主和路径再跑一次，加 `--uninstall`（先加 `--dry-run` 看计划）：

```sh
python tools/engramory_init.py codex --uninstall
```

只删安装器自己的东西：规则块、skill 副本、Codex hook。**记忆库永远不删**，真想清空请自己删。

## 安全与隐私

记忆库是**未加密的明文**，本机进程都能读；`.gitignore` 只管 git，云同步、备份照样会复制它。

- **永远不存密码、key、token、cookie 的值**，只记它们在哪（密码管理器、环境变量名）。
- 手机号、邮箱、地址这类个人信息少存，尽量只记指针。

没有自动扫描，全靠纪律。见 [SKILL.md](SKILL.md) §5/§8 和 [SECURITY.md](SECURITY.md)。

## 版本规则

仓库的 `vX.Y.Z` 和 npm 包 `dsh-engramory@X.Y.Z` 是同一次发布，只改了一边也一起发（[CHANGELOG](CHANGELOG.md) 写明改了哪边）。

**只在主版本做不兼容改动：**

- **记忆库格式：** 目录结构（`MEMORY.md`、一条笔记一个文件、`archive/`）、frontmatter 字段、四种类型及各自的必填项、索引的标题和指针行，中英文都算。
- **工具：** `tools/` 下脚本的命令和参数（包括 `engramory_init.py` 把库建在哪），以及 Claude Code、Codex 的 hook。
- **dsh 插件：** 包名、上限判定，以及 `indexName`、`maxLines`、`maxBytes`、`indexPath`、`registerSkill`、`injectIndex`、`language`、`skill` 这些配置。

**实验性，小版本也可能改：** 大肥鱼模式（`companion`）和它的三种类型、社交模式（`audience`）、插件的设置页和记忆页。

协议措辞每次发布都可能修订，但会让合格的记忆库变得不合格的规则要等主版本。记忆库不带版本号，格式变了的迁移步骤写在 CHANGELOG。安全修复可能在任何版本改变不安全配置的行为，CHANGELOG 会写明。

## 已知局限

- **只有 dsh 和 Claude Code 有写前拒绝**，而且 shell、MCP 文件工具、外部编辑器都能绕过。其他宿主只靠规则，尽力而为；各宿主的情况以 [PORTING.md](PORTING.md) 为准。
- **整理靠模型自觉遵守规则**，不是强制的。
- **没有来源、可信度、过期字段。** 回忆到的内容只供参考，可能被人为影响（[SKILL.md](SKILL.md) §4）。
- **没有项目 ID。** 多个项目共用一个库时，笔记名可能撞、内容可能串。
- **一个库只能有一个写入者**，见[单写者、多读者](adapters/reader/README.md)。
- **只适合个人规模。** 活跃记忆要装得进有界的索引；大量资料请用检索系统。

## 前人工作与致谢

Andrej Karpathy 的 LLM Wiki / 知识库 · Claude Code auto-memory · basic-memory · obsidian-second-brain · claude-memory-compiler · Anthropic memory tool · OpenAI Codex memory · [agentmemory](https://github.com/rohitg00/agentmemory) · markdown 记忆社区。底层做法都有前人工作，Engramory 的贡献在于这套纪律和它的组合方式。

## 许可证

MIT，见 [LICENSE](LICENSE)。

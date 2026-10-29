[English](README.md) | **简体中文**

# Engramory

[![CI](https://github.com/tinqiao-oss/engramory/actions/workflows/test.yml/badge.svg)](https://github.com/tinqiao-oss/engramory/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-blue.svg)](https://www.python.org/)

**一套零基础设施、面向小规模本地文件式智能体记忆的*协议***。Engramory 把策展规则与校验器(`tools/engramory_doctor.py`)组合起来:小篇幅 markdown 笔记、只放指针的索引,以及通过 `CLAUDE.md`、`AGENTS.md` 或宿主常驻指令加载的规则。文件可直接阅读、编辑;真实记忆库保持 git-ignore。

> *Engramory* —— *engram*(记忆留下的物理痕迹)+ *memory*。
> 在这里:**一个文件 = 一条事实**。

> ⚠️ **有同名但无关的项目。** 本项目是 `tinqiao-oss/engramory`(npm 包名 `dsh-engramory`);其他所有者名下的同名仓库不是它的 fork、镜像或新版本。

> 🤖 **你是被要求安装或检查它的 AI agent 吗?** 先读 **[AGENT-SETUP.md](AGENT-SETUP.md)**,判断宿主能力、已有记忆库、安全安装方式,以及哪些功能确实可以汇报为已启用。

> **状态:0.12.4 —— 实验性。** Claude Code 的 `PreToolUse` hook 为匹配的直接编辑工具(`Edit|Write|MultiEdit`)提供硬性索引上限;`dsh-engramory` 插件是第二个,管 dsh 的文件工具。shell 工具(Bash、PowerShell、后台 Monitor 命令)、MCP 文件工具、外部编辑器和同步程序都能绕过防护。策展仍靠模型遵守规则,只能尽力而为;这还不是强制、可靠的跨 agent 记忆层。见[宿主覆盖范围](PORTING.md)和[协议局限](SKILL.md)。

---

## 它是什么 —— 以及它**不是**什么

Engramory 是**一套纪律,不是存储引擎**:不需要数据库、向量或服务器。常驻规则承载召回与写入指令,可选 skill 提供完整协议。它需要具备规则机制和文件访问能力的宿主,缺少这些能力的纯聊天界面用不了。模型本身不限。

markdown 加索引的模式、类型化笔记都是前人工作。Engramory 的贡献是策展契约与适配宿主的防护实现,不是新的记忆架构。它关注智能体的工作记忆:用户是谁、该怎么做事、项目下一步需要什么。

## 真正的差异点

1. **小索引,详情按需打开。** `MEMORY.md` 只放指针,不抄笔记正文。每次会话通过宿主注入或显式读取取得索引:Codex 需要实际读取;dsh 上由插件自动注入(不装插件时 dsh 也需要读取)。限制索引大小既控制持续的上下文开销,也避免超过宿主的加载窗口。
2. **经过策展、可落实的笔记。** 类型是 `user | feedback | project | reference`。程序性的 `feedback` 保存可复用纠错,带 **Why:**(为什么)和 **How to apply:**(怎么落实)。agent 写前查重、更新已有笔记、清理错误或过时事实,不重复记录 git、代码或项目指令已有的内容。这些规则靠模型遵守。
3. **已实现宿主上的写前尺寸兜底。** 硬上限默认 200 行 / 25 KB,任一维度都能触发。防护拒绝它能测量到的、把索引扩到上限之外的写入,允许压缩(dsh 插件测量不了 `insert` 这类局部编辑)。Claude Code 也可能提供写后警报;Engramory 的 hook 在写入之前生效。配置与覆盖范围见 [hooks/INSTALL.md](hooks/INSTALL.md)、[dsh 插件指南](adapters/dsh/plugin/README.zh-CN.md)和 [PORTING.md](PORTING.md)。

## 不另建 handoff 库的任务续接

未完成任务在规范记忆库中**至多保留一条**活跃的 `project` 笔记,就地更新目标、状态、决策、约束、阻塞和下一步。不另加 `handoff` 类型、不按日期攒状态文件、也不附逐轮交接日志。`feedback` 只保存能跨任务复用的纠错或工作流。

主动 compact、clear 或新开线程前,执行[续接同步](PORTING.md#3-wire-continuity-sync--explicit-first-hooks-optional):策展笔记、清理过时或已完成的瞬时状态、运行 check + doctor,确认冷启动 agent 能继续。仓库状态只留稳定指针,召回时复核,不重复保存变化中的 git/测试状态。汇报 added、updated、archived(含删除)、skipped 及理由,加上索引大小和检查结果。生命周期 hook 能提醒或拦住转换,不能代做或保证这次语义同步。

## 横向对比

- **Claude Code auto-memory 等原生记忆:**同样采用索引加详情文件的模式;Engramory 增加显式策展契约,并对适配器覆盖的操作提供写前防护。
- **markdown 记忆项目:**[obsidian-second-brain](https://github.com/eugeniughelbur/obsidian-second-brain) 和 [claude-memory-compiler](https://github.com/coleam00/claude-memory-compiler) 同样以文件为基础。Engramory 强调小篇幅、类型明确、经过策展的笔记。
- **检索与自动捕获系统:**[basic-memory](https://github.com/basicmachines-co/basic-memory)、mem0、Zep、[agentmemory](https://github.com/rohitg00/agentmemory) 面向小型常驻索引之外的需求。Engramory 不提供搜索引擎或自动摄取流水线,适用于人工精选的个人活跃记忆集。
- **MCP server —— 对已经能读写文件、加载常驻规则的宿主,这是刻意不走的路线:**它会开出一条绕过写前防护的第二写入通道,还会把召回从"每次会话都加载的索引"降级成"模型得记得去调用的工具"。对两者都不具备的宿主,MCP 入口值得作为补充加上,但不能替代协议。

---

## 安装

> hook 和 `tools/` 脚本需要 **Python 3.9+**。请在本仓库目录运行以下命令。命令写作 `python`;macOS / Linux 若没有裸 `python`,请用 `python3`;Windows 用 `python`(`python3` 可能只是商店占位程序)。

### Claude Code

1. 把 [`rules-snippet.md`](rules-snippet.md) 贴进 `~/.claude/CLAUDE.md`(所有项目)或项目 `CLAUDE.md`,让纪律常驻上下文。
2. 可选:把本文件夹复制或软链接为 Claude Code 技能目录里的 `engramory/`,让 [`SKILL.md`](SKILL.md) 按需可用。
3. 用 [`hooks/settings.snippet.json`](hooks/settings.snippet.json) 把 `hooks/engramory_index_guard.py` 注册进 `settings.json`。
4. 把 `<MEMORY_ROOT>` 指向记忆目录;在仓库内就 `.gitignore` 掉。

具体路径、解释器设置,以及确认 hook 确实拒绝写入的临时文件检查,见 [hooks/INSTALL.md](hooks/INSTALL.md)。

> **可选 —— 回查记忆背后的会话记录。** `tools/engramory_trace.py` 在本地只读搜索 Claude Code 的 JSONL 记录,不上传、不建索引、不做向量化。它可用于查找简略笔记背后的推理、原始证据,或讨论过但没保存的内容:
>
> ```bash
> python tools/engramory_trace.py "streaming parser"   # 搜当前项目
> python tools/engramory_trace.py --show <session-id>  # 展开某次会话
> ```
>
> 默认只搜对话消息,排除会反复带入记忆的工具输出。若笔记标有来源会话号,用 `--show` 直达原会话。这是 Claude Code 的便利工具,独立于记忆协议。

### Codex

初始化助手在 `AGENTS.md` 中安装规则、创建记忆模板、复制 skill,并将项目内的记忆库加入 `.gitignore`:

```sh
python tools/engramory_init.py codex --project-root /path/to/project --install-skill
```

默认库是 `<project>/.engramory-memory/`;已有目录可用 `--memory-root` 指定。与 Codex 自行管理的原生 Memories 保持分离。

可追加 `--install-hooks --mode explicit`(默认)安装生命周期辅助,或用 `--mode assisted` 增加里程碑提醒。两者都依赖 agent 执行同步。审查并信任项目 hook,用 `/hooks` 确认启用状态;`.engramory-codex-state.json` 只保存有界的同步记录,不保存 prompt、会话全文或笔记正文。

详见 [adapters/codex/README.md](adapters/codex/README.md)。若每条消息都启动新会话,先读其中的 chat-bridge 说明:Engramory 索引需要文件工具读取,不会自动加载。上限靠规则 + check + doctor,尽力而为。

### 只读读取器(召回另一个 agent 的记忆)

用[单写者、多读者](adapters/reader/README.md)模式,让另一个宿主读取已有库,不成为第二个策展者:

```sh
python tools/engramory_init.py codex-reader   --project-root ~/.codex \
  --memory-root ~/.claude/projects/<project>/memory
# 另一个宿主——把召回规则写进它自己的规则文件:
python tools/engramory_init.py cursor-reader  --project-root /path/to/repo --memory-root <store>
```

`--memory-root` 必须已有 `MEMORY.md`;读取器不建库。`--project-root` 必须在库外。[读取器指南](adapters/reader/README.md)说明可用读取器、验证状态、指令层只读的局限和数据出境;宿主能力见 [PORTING.md](PORTING.md)。

### OpenClaw

助手默认指向 workspace `~/.openclaw/workspace`:

```sh
python tools/engramory_init.py openclaw --install-skill
```

它接好 workspace 的 `AGENTS.md`,安装 `.agents/skills/engramory`,另建 `.engramory-memory/` 库。上限靠规则 + check + doctor,尽力而为;见 [adapters/openclaw/README.md](adapters/openclaw/README.md)。

### Kiro

目前手动安装(无 init 助手):将 [steering 模板](adapters/kiro/steering-engramory.md)复制到 `.kiro/steering/engramory.md`。它使用 `inclusion: always` 和实时索引引用 `#[[file:.engramory-memory/MEMORY.md]]`;笔记放在**非 steering** 的 `.engramory-memory/` 目录。

> ⚠️ **别把笔记放进 `.kiro/steering/`。** 未写 `inclusion` 的 steering 默认常驻加载,会把每条笔记塞进每次请求。记忆库要 git-ignore,但不要加入 `.kiroignore`,否则 agent 无法读取。

这里没有已交付或验证的 Kiro 防护。使用规则 + check + doctor,尽力而为;完整安装与校验器路径见 [adapters/kiro/README.md](adapters/kiro/README.md)(手动安装不会把 `tools/` 复制进工作区)。

### DeepSeek Harness(dsh)

[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Ftinqiao-oss__engramory.json)](https://unstone.github.io/dsh-xray/registry.html#tinqiao-oss__engramory)

徽章链接到插件的静态能力扫描。安装默认使用 `$DSH_HOME`,未设置时使用 `~/.dsh`:

```sh
python tools/engramory_init.py dsh --install-skill
```

它接好 `$DSH_HOME/AGENTS.md`,安装 `$DSH_HOME/skills/engramory`,另建 `.engramory-memory/` 库。传 `--project-root` 可改为项目安装,skill 放在 `<project>/.dsh/skills/engramory`。全局规则使用记忆库绝对路径,项目规则使用相对路径。详见 [adapters/dsh/README.md](adapters/dsh/README.md)。

助手本身只提供规则 + check + doctor。要启用确定性防护(0.2.7 起)和每次请求自动注入索引、无需读取(0.2.8 起),请在使用的 profile 中安装 **`dsh-engramory`**(`pnpm` 必须在 PATH 中):

```sh
dsh plugin --profile <name> add dsh-engramory
```

配置和防护边界见[插件指南](adapters/dsh/plugin/README.zh-CN.md)。兼容 dsh 版本只以 [package.json](adapters/dsh/plugin/package.json) 的 `dsh.compatibility.dshReleases` 中标为 `compatible` 的条目为准,并由 [results.json](tests/dsh_e2e/results.json) 支持;未列出的版本未经验证。验证方法见 [E2E 指南](tests/dsh_e2e/README.md),版本历史以 [CHANGELOG.md](CHANGELOG.md) 为准。

### 任何其他智能体(Hermes、Cursor、Cline、Windsurf……)

按 [PORTING.md](PORTING.md) 接线:把 [`rules-snippet.md`](rules-snippet.md) 放进常驻指令,可选导入 [`SKILL.md`](SKILL.md),选定一个自己掌控的 `<MEMORY_ROOT>`。原生记忆仅在普通文件可编辑时才复用;对宿主管理的记忆,另建独立库。

这些宿主使用规则 + 写索引后运行 `tools/engramory_check.py` + 定期运行 `tools/engramory_doctor.py`,尽力而为。宿主暴露写前接口不等于已有 Engramory 防护;见[宿主能力表](PORTING.md)。

接入已有库时,按 [Adopting an existing store](PORTING.md#adopting-an-existing-store):先用 `--no-schema` 检查结构,用文档片段补齐日期,再手写 Why/How,最后重跑严格 doctor。

## 卸载

对同一宿主和安装路径再跑一次,加 `--uninstall`:

```sh
python tools/engramory_init.py codex --uninstall --dry-run   # 先打印计划
python tools/engramory_init.py codex --uninstall             # 执行
```

它移除带标记的规则块、安装的 skill 副本和托管 Codex hook handler。其他 handler 保留;仅当 `.codex/hooks.json` 没有其他内容时才删除它。规则文件若有散落或重复标记,会逐字节原样保留并报告,由你手动清理。

**记忆库及其 `.gitignore` 条目永不删除**,即便库在待清理目录中。只删除安装器自己的文件,并报告保留项。非默认库请传原来的 `--memory-root`,让报告正确点名。真要清空记忆,请自行删除。

## 配置

- **`<MEMORY_ROOT>`** —— 选一个你会去检查的目录;在仓库内就 git-ignore。
- **索引上限** —— Claude Code 默认值及环境变量覆盖见 [hooks/INSTALL.md](hooks/INSTALL.md);dsh 默认值与配置键见[插件配置表](adapters/dsh/plugin/README.zh-CN.md#配置)。

## 安全与隐私

记忆库是**未加密的明文**,有文件访问权限的本地进程可读。`.gitignore` 只让它不进 git;云同步、备份、桌面搜索仍可能复制或索引内容。同步或远程备份目录可能把内容带出机器。

- **永不保存凭据值**——key、token、密码、cookie、恢复码。只记所在位置(密码管理器 / 环境变量 `FOO`)。IP、路径、序列号可以是定位符,凭据值不行。
- 尽量少存手机号、邮箱、地址等个人信息,优先用指针。

没有 hook 扫描记忆中的秘密。这只能靠纪律尽力而为;见 [SKILL.md](SKILL.md) §5/§8 和 [SECURITY.md](SECURITY.md)。

## 已知局限

**恰好两个宿主有已编写、测试且在运行的确定性写前拒绝:**Claude Code([`hooks/engramory_index_guard.py`](hooks/engramory_index_guard.py))和 dsh([`dsh-engramory >= 0.2.7`](adapters/dsh/plugin/README.zh-CN.md))。其他宿主都靠规则 + `engramory_check.py` + doctor,尽力而为。即便已暴露接口——Hermes、Cursor、通过 `before_tool_call` 的 OpenClaw、Kiro CLI——也只是**原则上可移植,这里尚未编写或验证**。权威宿主说明见 [PORTING.md](PORTING.md);shell、MCP 和外部编辑器写入能绕过所有防护。

- **版本 / 迁移:**语义记忆库没有 `schema_version` 或已定义的升级路径。Codex 带版本号的同步记录不含记忆。
- **来源 / 可信度:**没有 `source`、`confidence`、`last_verified`、过期或 `superseded-by` 字段。召回内容只供参考、未经鉴权,可能受攻击者影响([SKILL.md](SKILL.md) §4)。
- **作用域 / 多项目:**可选 `scope: global | repo` 由 doctor 校验,但没有 `project_id`;扁平 slug 命名空间可能碰撞、串项目。包含协议版本、作用域、宿主配置的库级 manifest 仍是计划,尚未实现。
- **并发:**采用[单写者、多读者](adapters/reader/README.md);Codex 的同步记录锁不保护语义笔记和索引写入。
- **规模:**活跃集必须装进有界索引。这是个人规模的精选记忆,不是大语料库或自动捕获系统。

## 前人工作与致谢

Andrej Karpathy 的 **LLM Wiki / 知识库**(面向知识百科,Engramory 面向智能体工作记忆)· Claude Code auto-memory · basic-memory · obsidian-second-brain · claude-memory-compiler · Anthropic memory tool · OpenAI Codex memory · [agentmemory](https://github.com/rohitg00/agentmemory) · markdown 记忆社区。底层原语与程序性记忆类别都有前人工作;贡献在于纪律和组合方式。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。

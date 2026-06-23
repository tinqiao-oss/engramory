[English](README.md) | **简体中文**

# Engramory

[![CI](https://github.com/tinqiao-oss/engramory/actions/workflows/test.yml/badge.svg)](https://github.com/tinqiao-oss/engramory/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Python 3.9+](https://img.shields.io/badge/python-3.9%2B-blue.svg)](https://www.python.org/)

**一套有主见、零基础设施的、面向小规模 / 本地 / 文件式智能体记忆的*协议*** —— 一套**强约束的策展纪律 + 一个校验器**(`tools/engramory_doctor.py`),以**常驻规则形式加载**(`CLAUDE.md` / `AGENTS.md` / 宿主的规则文件)。它不是数据库、不是框架、也不是按相关性加载的 skill。记忆就是一个文件夹:一堆小小的、人能直接读的 markdown 文件,加一个每次会话都加载的索引。没有数据库、没有向量、没有服务器——就是你能打开、能读、能改、能 diff 的纯文本文件(真实记忆库本身保持 git-ignore)。

> *Engramory* —— 由 *engram*(记忆在大脑里留下的物理痕迹)+ *memory* 造的词。
> 在这里:**一个文件 = 一条事实**。

> **状态:0.3.2 —— 实验性。** 硬性索引上限(`PreToolUse` hook)对匹配到的直接编辑工具(`Edit|Write|MultiEdit`)确定性拦截、但**不是全局写保护**(Bash/MCP 文件工具/外部编辑器/同步程序绕得过);纪律以**常驻规则**形式加载、靠模型遵守,**尽力而为、不保证每个任务都生效**(见 [SKILL.md](SKILL.md) §8)。假设**单写者/串行写入**。暂时别把它当"强制、可靠、跨 Agent"的记忆层来用。

---

## 它是什么 —— 以及它**不是**什么

Engramory **不是一种新的记忆架构**。"markdown 文件 + 一个常驻上下文的小索引 + 模型自己维护"这套模式,如今已经是智能体记忆的主流形态,而且好几个地方都已经实现了。Engramory 站在这些前人肩上:

- **Claude Code 原生 auto-memory** —— 同样的"markdown + `MEMORY.md` 索引 + 按需打开详情文件";连 `user | feedback | project | reference` 这套类型词都一样(依据 [anthropics/claude-code#58840](https://github.com/anthropics/claude-code/issues/58840) 里的系统提示;**公开文档**只描述了索引 + 详情文件、并未公开这套类型本体)。Engramory 是它的**纪律加强版**。
- **[basic-memory](https://github.com/basicmachines-co/basic-memory)** —— markdown 为真值源、YAML frontmatter 的 `type`、`[[wikilink]]` 图、本地优先。
- **[obsidian-second-brain](https://github.com/eugeniughelbur/obsidian-second-brain)**、**[claude-memory-compiler](https://github.com/coleam00/claude-memory-compiler)**(明确主张"个人规模下,加载一个结构化索引胜过向量检索"),以及一整个 markdown 记忆 skill 家族。

Engramory 贡献的是**有主见的组合 + 纪律**,不是这些底层原语。别去宣称 markdown、frontmatter、wikilink、加载索引、原子笔记、策展卫生是新东西——全是 prior art(前人已做)。

## 真正的差异点

1. **以"角色/用途"为类型,头牌是 `feedback` = 程序性记忆。** 语义 / 情景 / **程序性**的三分法是公认的前人工作(CoALA 分类法;LangMem、mem0 都有命名的 procedural 类型)——Engramory **不**声称这个类别是原创。它做的是:把程序性 `feedback` 当作一个**刻意做小、手写、人类可读**的集合的脊梁,强制带 **Why:**(为什么)/ **How to apply:**(怎么落实),而不是把它自动抽取进向量 / 图数据库。**贡献在于这套打包方式和纪律,不在本体论本身。**

2. **把策展契约做成具体行为**(模型遵守,非硬性闸):写前先查重、能改就别新增、发现错的就删、还有一条负向规则——"git / 项目说明文件 / 代码里已经有的,别再记"。各种综述一致认为**修改/删除/遗忘**是整个领域最没被实现好的操作。Engramory 把它当成脊梁。

3. **一个旨在不悄悄烂掉的有界索引。** 索引每次会话都整份加载,而 Claude Code 只读它的前 200 行 / 25KB(官方文档明确),所以无限膨胀的索引会**悄悄把末尾的记忆丢掉、不再被召回**。Engramory 在 150 行 / 20KB 提醒,逼近 200 行 / 25KB 时先压缩再问你,并附一个硬性的 `PreToolUse` hook 兜底(只拦"变大"的编辑——缩小/压缩的编辑一律放行)。**行数和字节双维度——谁先超谁触发**(一个索引可能行数没超,但因为行太长、字节先爆)。

## 横向对比

| | 存储 | 召回 | 人能读 | 类型本体论 | 策展纪律 | 有界索引 | 基础设施 |
|---|---|---|---|---|---|---|---|
| **Engramory** | md 文件 | 读索引 → 开文件 | ✅ | ✅ 角色式(4类) | ✅ 契约(模型执行) | ✅ 150/200 行+字节 + hook | 无 |
| CC 原生记忆 | md 文件 | 读索引 → 开文件 | ✅ | ✅ 同 4 类 | 部分(自动) | ~200 行窗口* | 无(内置) |
| basic-memory | md + SQLite | 语义/全文检索 | ✅ | ✅ 自由 type | schema + 覆写检查 | ❌(无加载索引) | SQLite + 向量 |
| obsidian-second-brain | md 库 | 索引优先 + 检索 | ✅ | 文件夹分类 | ✅ 对账/lint | 部分 | 无 |
| mem0 / Zep | 向量/图数据库 | 语义 | ❌(DB) | 有类型(偏好/情景/程序; Zep 自定义) | 自动抽取 | 不适用 | 数据库 + 向量 |
| [agentmemory](https://github.com/rohitg00/agentmemory) | SQLite + 向量索引(+可选图) | 混合 BM25+向量(+可选图),RRF | ❌(DB/引擎) | ✅ 4 层生命周期(工作/情景/语义/程序) | 自动(捕获+去重+衰减) | 不适用 | iii 引擎(本地)+可选向量 |

Engramory 的赛道:**极简 + 可执行的角色类型 + 策展纪律,零基础设施。** 它**不**去跟 basic-memory 拼检索、跟 mem0 拼规模、跟 agentmemory 拼自动捕获——那是另一个问题(自动捕获 / 大规模自动摄取),另一个成本档位。agentmemory 是最接近的重型对照:它同样本地优先,但赌的是**自动捕获**(生命周期 hook)+ **混合检索**(BM25 + 向量 + 可选图谱),底层是 SQLite/`iii` 引擎;而 Engramory 赌的是**手工策展** + 一个极小的常驻索引,且**根本不带引擎**。

\* Claude Code 的 [memory 文档](https://docs.claude.com/en/docs/claude-code/memory)明确写着:*"MEMORY.md 的前 200 行、或前 25KB(谁先到算谁),在每次对话开始时加载。"* 其他宿主各异,故该窗口仍可用 hook 环境变量调整。

## 它的位置 —— 以及目标

Engramory 是**一套可移植的记忆*纪律*,不是产品**——不是数据库、不是框架、不是按相关性加载的 skill,也不是只能用在 Claude Code 的插件。它所依赖的底层管道(markdown 索引 + 原子笔记、`user | feedback | project | reference` 四类型、有界加载索引)正越来越多地被宿主**原生**内置——Claude Code 自带的 auto-memory 就已经做到了。所以 Engramory 的价值在于宿主**不**提供的那部分:显式的策展契约(写前查重、发现错就删、git/代码里已有的别记)、带强制 Why/How 的程序性 `feedback` 笔记,以及一条可移植的尺寸上限强制方式。

**目标是让*任何* agent 都能用上同一套纪律——靠骑在真正的跨 agent 轨道上,而不是另造一个标准。** 把 [`rules-snippet.md`](rules-snippet.md) 贴进宿主的常驻规则,纪律就每个任务都生效;再配一个**(规划中的)Engramory MCP server**,任何支持 MCP 的 agent(Claude Code、Cursor、Cline、Codex、Windsurf……)就能共享同一个记忆库、同一套工具,以及一个 **server 端强制的 cap**——让那个唯一的确定性保证从"逐宿主"变成"跨 agent"。对只给你一个扁平规则文件或裸文件存储的宿主,这是实打实的升级;对已经自带结构化记忆的宿主,Engramory 就是叠在上面的一层薄纪律——并且坦白承认这一点。

---

## 安装

> 需要 **Python 3.9+**,用于 hook 与 `tools/` 脚本(多数系统上是 `python3`)。

### Claude Code
1. **把纪律作为常驻规则加载(主路径)**:把 [`rules-snippet.md`](rules-snippet.md) 贴进常驻规则——`~/.claude/CLAUDE.md`(所有项目)或项目 `CLAUDE.md`——让协议每个任务都生效,而不只是 skill 按相关性加载时才生效。
2. **(可选)把完整规范注册成 skill**:把本文件夹复制或软链接到 Claude Code 技能目录、命名 `engramory/`,让 [`SKILL.md`](SKILL.md) 作为详细参考按需加载(路径见 `hooks/INSTALL.md`)。
3. **装硬卡口 hook**:把 `hooks/` 里的 hook 注册进 `settings.json`(片段在 `hooks/settings.snippet.json`)。
4. 把 `<MEMORY_ROOT>` 指向你的记忆目录;若在 git 仓库内,务必 `.gitignore` 掉。

### Codex

用 Codex 初始化助手来接线:它会把纪律写进 `AGENTS.md`,创建记忆模板,可选地把完整协议安装成 Codex skill,并在记忆目录位于项目内时追加 `.gitignore`:

```sh
python tools/engramory_init.py codex --project-root /path/to/project --install-skill
```

默认创建 `<project>/.engramory-memory/`。如果你已有记忆目录,传 `--memory-root`。不要把 Engramory 直接接管 Codex 原生 Memories:Codex Memories 是 Codex 自己管理的生成状态,而 Engramory 是用户可审计的明文文件夹。Codex 细节见 [adapters/codex/README.md](adapters/codex/README.md)。

### OpenClaw

用 OpenClaw 初始化助手(默认指向 workspace `~/.openclaw/workspace`):

```sh
python tools/engramory_init.py openclaw --install-skill
```

它把带标记的 Engramory 块写进 workspace 的 `AGENTS.md`(每次会话自动加载),把协议装到 `.agents/skills/engramory`(OpenClaw 会自动发现),并单独建一个 `.engramory-memory/` 记忆库。OpenClaw 上的索引上限靠规则 + `engramory_check.py`,**不是**确定性 deny hook(那需要写一个 `before_tool_call` 插件)—— 详见 [adapters/openclaw/README.md](adapters/openclaw/README.md)。

### Kiro

Kiro(AWS 的智能体 IDE / CLI)是个上等宿主——有常驻加载的 steering 文件、能自主读写工作区
markdown 的智能体,还有真正的写前 deny hook。目前手动接线(还没有 init 助手):把
[`adapters/kiro/steering-engramory.md`](adapters/kiro/steering-engramory.md) 复制到
`.kiro/steering/engramory.md`(它已是 `inclusion: always`,并用
`#[[file:.engramory-memory/MEMORY.md]]` 把实时索引注入),笔记则放进一个**非 steering** 的
`.engramory-memory/` 目录。

> ⚠️ **别把笔记丢进 `.kiro/steering/`。** 没写 `inclusion` frontmatter 的 steering 文件
> **默认就是 `inclusion: always`**,于是每条笔记都被塞进每次请求、**把上下文干爆**——这是
> Kiro 安装的头号错误。只有索引该进常驻 steering;笔记留在 `.engramory-memory/` 里按需打开。
> 上限暂时靠规则 + `engramory_check.py`(确定性的 Kiro `PreToolUse` hook 可行,但这里还没
> 落地/实测)。完整说明:[adapters/kiro/README.md](adapters/kiro/README.md)。

### 任何其他智能体(Hermes、Cursor、Cline、Windsurf……)
Engramory 与模型无关(DeepSeek、GPT、Llama……),骑在宿主自己的记忆库上。完整接线见 **[PORTING.md](PORTING.md)**;简言之:把 [`rules-snippet.md`](rules-snippet.md) 贴进宿主的**常驻加载**规则里(让纪律常驻生效,而不只是按相关性加载的 skill),若宿主支持 skill 再导入 [`SKILL.md`](SKILL.md),把 `<MEMORY_ROOT>` 指向宿主自己的记忆目录,并按宿主能支持的最强档位接好尺寸上限:PreToolUse hook → 每次写索引后跑 `tools/engramory_check.py` → 模型纪律,再用 `tools/engramory_doctor.py` 做周期兜底。确定性的 cap 需要一个 pre-write 的 *deny* hook:这里只有 Claude Code 的写好并实测过;部分其他宿主也暴露了等效 hook(Hermes;Cursor 不过较新、不太稳),所以 cap 可移植——但每个宿主要各自改一层薄 I/O shim 并自行验证,而 OpenClaw 只能靠 `before_tool_call` 插件拦截、有些宿主则完全没有。各宿主详情见 [PORTING.md](PORTING.md)。没有这类 hook 的宿主(或纯聊天)上,cap 退化为尽力而为的纪律(见 [SKILL.md](SKILL.md) §9)。

把**已有的存量记忆库**首次接入严格 `doctor` 会报一堆机械问题(缺 `created`/`updated`、Why/How 还没用规范标签)——别盲修,见 **[PORTING.md](PORTING.md)** 的「Adopting an existing store」:先 `--no-schema` 过结构、用片段批量补日期、再手写 Why/How。

一个没有文件访问、没有规则机制的纯聊天界面**用不了** Engramory——它需要一个能执行技能/规则、能读写文件的宿主。

## 配置

- **`<MEMORY_ROOT>`** —— 记忆放哪。放在你真的会去看的地方;在仓库里就 `.gitignore` 掉。
- **索引上限** —— 软提醒 / 硬上限默认 150 行 / 200 行,字节 20KB / 25KB;都能用 hook 的环境变量覆盖(见 `hooks/`)。

## 安全与隐私

记忆库是**明文、未加密**的,任何本地进程都能读。`.gitignore` 只是让它不进 git——**不是加密**,也挡不住云同步(Dropbox / iCloud / OneDrive)、系统备份、桌面搜索。若 `<MEMORY_ROOT>` 在被同步 / 备份的文件夹里,内容就会离开你的机器。

- **永远别把密钥的「值」写进记忆**——key、token、密码、cookie、恢复码,只记它「在哪」(如「在密码管理器 / 环境变量 `FOO`」)。IP / 路径 / 序列号当定位符可以;凭据值绝不行。
- 尽量少写部分 PII(手机号、邮箱、地址),优先用指针。

这条纪律是**未强制**的(没有 hook 扫描记忆内容——见 [SKILL.md](SKILL.md) §5/§8),当尽力而为、刻意为之。

## 已知局限

Engramory 是一套**单项目、单写者、个人规模**的协议。它**还没有**:

- **版本 / 迁移** —— 没有 `schema_version`;frontmatter 格式若变化,没有定义好的升级路径。(已有存量库的接入,见 [PORTING.md](PORTING.md) 的「Adopting an existing store」:分诊 recipe + 日期回填片段。)
- **来源 / 可信度** —— 没有 `source`、`confidence`、`last_verified`、过期、`superseded-by` 等字段。召回的记忆是建议性的、且可被攻击者影响(见 [SKILL.md](SKILL.md) §4);记忆内容没有任何鉴权。
- **作用域 / 多项目** —— 没有 `scope` / `project_id`;单一扁平 slug 命名空间,跨项目 / 跨 agent 共用一个库会撞 slug、串项目。一个库级 manifest(协议版本 + 作用域 + 宿主配置)是规划中的第一步——**还没做**。
- **并发** —— 假设单写者 / 串行写入(无锁)。
- **规模** —— 常驻加载的扁平索引把**活跃集**限制在卡上限装得下的量(约 200 条指针)。它是个人 / 精选规模的工具,不是大语料;超过这个量,检索式系统(basic-memory、mem0)才是对的工具。

## 前人工作与致谢
Andrej Karpathy 的 **LLM Wiki / 知识库**(markdown-胜过-RAG 模式,这条路线最有分量的提出者——但注意它针对的是知识*百科*,而 Engramory 针对的是智能体的*工作记忆*:用户是谁、该怎么表现、项目状态)· Claude Code auto-memory · basic-memory · obsidian-second-brain · claude-memory-compiler(本身受 Karpathy 启发)· Anthropic memory tool · OpenAI Codex memory(及其更早的 topics-memory 提案 #19758)· [agentmemory](https://github.com/rohitg00/agentmemory)(一个重型、本地优先的对照项——自动捕获 + SQLite/`iii` 引擎 + 混合 BM25/向量检索;与 Engramory 零基础设施手工策展正好相反的设计取向)· 整个 markdown 记忆社区。

## 许可证
MIT —— 见 [LICENSE](LICENSE)。

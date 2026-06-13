[English](README.md) | **简体中文**

# Engramory

**一套有主见、零基础设施的 AI 智能体长期记忆纪律。** 记忆就是一个文件夹:一堆小小的、人能直接读的 markdown 文件,加一个每次会话都加载的索引。没有数据库、没有向量、没有服务器——就是你能打开、能读、能改、能 diff 的纯文本文件(真实记忆库本身保持 git-ignore)。

> *Engramory* —— 由 *engram*(记忆在大脑里留下的物理痕迹)+ *memory* 造的词。
> 在这里:**一个文件 = 一条事实**。

> **状态:0.1.3 —— 实验性。** 硬性索引上限(`PreToolUse` hook)常驻生效;纪律部分是按相关性加载的 skill,**尽力而为、不保证每个任务都生效**(见 [SKILL.md](SKILL.md) §8)。暂时别把它当"强制、可靠"的记忆层来用。

---

## 它是什么 —— 以及它**不是**什么

Engramory **不是一种新的记忆架构**。"markdown 文件 + 一个常驻上下文的小索引 + 模型自己维护"这套模式,如今已经是智能体记忆的主流形态,而且好几个地方都已经实现了。Engramory 站在这些前人肩上:

- **Claude Code 原生 auto-memory** —— 同样的"markdown + `MEMORY.md` 索引 + 按需打开详情文件",连 `user | feedback | project | reference` 这套类型词都一样。Engramory 是它的**纪律加强版**。
- **[basic-memory](https://github.com/basicmachines-co/basic-memory)** —— markdown 为真值源、YAML frontmatter 的 `type`、`[[wikilink]]` 图、本地优先。
- **[obsidian-second-brain](https://github.com/eugeniughelbur/obsidian-second-brain)**、**[claude-memory-compiler](https://github.com/coleam00/claude-memory-compiler)**(明确主张"个人规模下,加载一个结构化索引胜过向量检索"),以及一整个 markdown 记忆 skill 家族。

Engramory 贡献的是**有主见的组合 + 纪律**,不是这些底层原语。别去宣称 markdown、frontmatter、wikilink、加载索引、原子笔记、策展卫生是新东西——全是 prior art(前人已做)。

## 真正的差异点

1. **以"角色/用途"为类型,头牌是 `feedback` = 程序性记忆。** 大多数记忆系统(mem0、Zep、basic-memory、知识图谱服务器)只存**世界事实**。Engramory 把"智能体该怎么表现"做成一等公民的记忆类型,强制带 **Why:**(为什么)/ **How to apply:**(怎么落实)。这是**最少有人做**的一块。

2. **把策展契约做成具体行为**(模型遵守,非硬性闸):写前先查重、能改就别新增、发现错的就删、还有一条负向规则——"git / 项目说明文件 / 代码里已经有的,别再记"。各种综述一致认为**修改/删除/遗忘**是整个领域最没被实现好的操作。Engramory 把它当成脊梁。

3. **一个旨在不悄悄烂掉的有界索引。** 索引每次会话都整份加载,而 Claude Code 只读它的前 200 行 / 25KB(官方文档明确),所以无限膨胀的索引会**悄悄把末尾的记忆丢掉、不再被召回**。Engramory 在 150 行 / 20KB 提醒,逼近 200 行 / 25KB 时先压缩再问你,并附一个硬性的 `PreToolUse` hook 兜底(只拦"变大"的编辑——缩小/压缩的编辑一律放行)。**行数和字节双维度——谁先超谁触发**(一个索引可能行数没超,但因为行太长、字节先爆)。

## 横向对比

| | 存储 | 召回 | 人能读 | 类型本体论 | 策展纪律 | 有界索引 | 基础设施 |
|---|---|---|---|---|---|---|---|
| **Engramory** | md 文件 | 读索引 → 开文件 | ✅ | ✅ 角色式(4类) | ✅ 契约(模型执行) | ✅ 行+字节双卡 + hook | 无 |
| CC 原生记忆 | md 文件 | 读索引 → 开文件 | ✅ | ✅ 同 4 类 | 部分(自动) | ~200 行窗口* | 无(内置) |
| basic-memory | md + SQLite | 语义/全文检索 | ✅ | ✅ 自由 type | 有卫生、不强制 | ❌(无加载索引) | SQLite + 向量 |
| obsidian-second-brain | md 库 | 索引优先 + 检索 | ✅ | 文件夹分类 | ✅ 对账/lint | 部分 | 无 |
| mem0 / Zep | 向量/图数据库 | 语义 | ❌ 黑盒 | 只存事实 | 自动抽取 | 不适用 | 数据库 + 向量 |

Engramory 的赛道:**极简 + 可执行的角色类型 + 策展纪律,零基础设施。** 它**不**去跟 basic-memory 拼检索、跟 mem0 拼规模——那是另一个问题(大规模自动摄取),另一个成本档位。

\* Claude Code 的 [memory 文档](https://docs.claude.com/en/docs/claude-code/memory)明确写着:*"MEMORY.md 的前 200 行、或前 25KB(谁先到算谁),在每次对话开始时加载。"* 其他宿主各异,故该窗口仍可用 hook 环境变量调整。

---

## 安装

> 需要 **Python 3.8+**(hook 与 `tools/` 脚本用了 f-string;多数系统上是 `python3`)。

### Claude Code
1. 做成个人技能(路径见 `hooks/INSTALL.md`):把本文件夹复制或软链接到 Claude Code 技能目录,命名为 `engramory/`。
2. 把 `hooks/` 里的硬卡口 hook 注册进 `settings.json`(片段在 `hooks/settings.snippet.json`)。
3. 把 `<MEMORY_ROOT>` 指向你的记忆目录;若在 git 仓库内,务必 `.gitignore` 掉。

### 任何其他智能体(Hermes、Cursor、Cline、Codex、Windsurf……)
Engramory 与模型无关(DeepSeek、GPT、Llama……),骑在宿主自己的记忆库上。完整接线见 **[PORTING.md](PORTING.md)**;简言之:把 [`rules-snippet.md`](rules-snippet.md) 贴进宿主的**常驻加载**规则里(让纪律常驻生效,而不只是按相关性加载的 skill),若宿主支持 skill 再导入 [`SKILL.md`](SKILL.md),把 `<MEMORY_ROOT>` 指向宿主自己的记忆目录,并按宿主能支持的最强档位接好尺寸上限:PreToolUse hook → 每次写索引后跑 `tools/engramory_check.py` → 模型纪律,再用 `tools/engramory_doctor.py` 做周期兜底。硬 hook 是 Claude Code 专有的;其他宿主上,上限是尽力而为(见 [SKILL.md](SKILL.md) §9)。

一个没有文件访问、没有规则机制的纯聊天界面**用不了** Engramory——它需要一个能执行技能/规则、能读写文件的宿主。

## 配置

- **`<MEMORY_ROOT>`** —— 记忆放哪。放在你真的会去看的地方;在仓库里就 `.gitignore` 掉。
- **索引上限** —— 软提醒 / 硬上限默认 150 行 / 200 行,字节 20KB / 25KB;都能用 hook 的环境变量覆盖(见 `hooks/`)。

## 安全与隐私

记忆库是**明文、未加密**的,任何本地进程都能读。`.gitignore` 只是让它不进 git——**不是加密**,也挡不住云同步(Dropbox / iCloud / OneDrive)、系统备份、桌面搜索。若 `<MEMORY_ROOT>` 在被同步 / 备份的文件夹里,内容就会离开你的机器。

- **永远别把密钥的「值」写进记忆**——key、token、密码、cookie、恢复码,只记它「在哪」(如「在密码管理器 / 环境变量 `FOO`」)。IP / 路径 / 序列号当定位符可以;凭据值绝不行。
- 尽量少写部分 PII(手机号、邮箱、地址),优先用指针。

这条纪律是**未强制**的(没有 hook 扫描记忆内容——见 [SKILL.md](SKILL.md) §5/§8),当尽力而为、刻意为之。

## 前人工作与致谢
Claude Code auto-memory · basic-memory · obsidian-second-brain · claude-memory-compiler · Anthropic memory tool · OpenAI Codex topics-memory 提案(#19758)· 整个 markdown 记忆 skill 社区。

## 许可证
MIT —— 见 [LICENSE](LICENSE)。

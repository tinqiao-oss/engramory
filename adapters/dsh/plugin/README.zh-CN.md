[English](README.md) | **简体中文**

# dsh-engramory

[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Ftinqiao-oss__engramory.json)](https://unstone.github.io/dsh-xray/registry.html#tinqiao-oss__engramory)

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**策展式、文件式**长期记忆 ——
纯 markdown 笔记,随便什么工具都能打开;跨宿主共享遵循
[一个写入者、多个只读者](../../reader/README.md),索引守卫会在匹配的文件工具写入前检查上限。(记忆库若位于某个项目的 git 仓库内,必须 git-ignore ——
记忆里带着本机独有的细节,见 SKILL.md §1。给记忆库单独开一个*私有仓*则完全可以。)

隶属于 [Engramory](https://github.com/tinqiao-oss/engramory)。

## 已经有 `AGENTS.md` 常驻块了,为什么还要插件

那个常驻块确实承载了纪律,单论召回也够用了。但有两件事它做不到:

**匹配工具的上限由守卫确定性执行。** `ctx.tools.guard()` 提供同步、**单调**的否决:
守卫一旦返回理由,后续监听器就不能再放行。索引的增长受配置上限约束,无需依赖 agent
记得运行校验器。请用 **`dsh-engramory >= 0.2.7`**;
[PORTING.md](../../../PORTING.md) 记录各宿主是否已有守卫实现,
[CHANGELOG.md](../../../CHANGELOG.md) 保存版本历史。

**协议随插件一起到达。** skill 是在运行时通过 dsh 的 skill 注册表注册的 —— 走一个响应式的
`ctx.inject(['skills'], …)` 子上下文,所以没有注册表的 profile 照样拿到上限,而注册表晚一步
挂载的 profile 也照样拿得到 skill。这意味着它**不依赖**把文件放进 dsh 扫描的那五个 skill 根
目录之一 —— 那条路很容易在细微处放错,而一旦放错就是**静默失败**。

## 安装

零依赖 ESM,不需要构建;需要 Node.js 18+,dsh 的插件命令还要求 PATH 中有 `pnpm`。

```sh
dsh plugin --profile <名字> add dsh-engramory
```

确切的兼容版本以 [`package.json`](package.json) 的 `dsh.compatibility.dshReleases` 为准,
由 [`results.json`](../../../tests/dsh_e2e/results.json) 的记录支持。
验证其他版本请看[端到端验证指南](../../../tests/dsh_e2e/README.md)。

这个包自带 `dsh.bundle` manifest 指向它自己的 `cordis.patch.yml`,所以那一行
会被自动插进 profile 的插件树里 —— 不需要手改配置。要改默认值,请在你自己 profile 的 patch
层里**按 id 修改那一行已存在的配置**,**不要**再写一个 `- insert:`(insert 永远是追加,你会得到
两行 engramory,而原来那行的上限依旧在生效):

```yaml
- id: engramory
  config:
    indexName: MEMORY.md
    maxLines: 200
    maxBytes: 25600
```

一次 patch 会**整体替换**目标行的 `config`,所以你想保留的键要逐个列全。

记忆库本身和常驻块,请用 Engramory 仓库里的安装器
(`python tools/engramory_init.py dsh --install-skill`)。本插件负责强制上限、提供协议;
**它不创建记忆库**。

卸载:

```sh
dsh plugin --profile <名字> remove dsh-engramory
```

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `indexName` | `MEMORY.md` | 被当作记忆索引的文件名(不区分大小写;`file_path` 与 `str_replace_editor` 的 `path` 都会检查)—— 看写入时用的文件名,或写入实际落到的那个文件的文件名,所以换了名字的 symlink 也会被拦。空值或非字符串会回退到默认值。 |
| `maxLines` | `200` | 硬性行数上限。非正数或非有限值回退到默认值。 |
| `maxBytes` | `25600` | 硬性 UTF-8 字节上限(25 KB)。 |
| `indexPath` | 未设置 | 要守护的**那一个**索引的绝对路径。不设它时,守卫只按文件名匹配,于是**别的项目里一个无关的 `MEMORY.md` 也会被拦**;设了它就只有这个确切的文件会被守。比较走的是身份而非拼写 —— 看写入实际落到的那个文件,不管它叫什么名字(symlink 与 `..` 都会解析;仅在 Windows 上折叠大小写),而且即使文件尚不存在,它的第一次写入照样受守护。 |
| `registerSkill` | `true` | 设为 `false` 则保留上限、但跳过运行时 skill。 |
| `skill` | 内置 | 用你自己的 markdown 替换 skill 正文。 |

## 守卫到底做了什么

| 调用 | 判决 |
|---|---|
| `write`(或 `str_replace_editor` 的 `create`)且结果在上限内 | 放行 |
| `write`/`create` 会让索引**增长**并越过上限 | **拒绝**,并报出具体数字和该压缩什么 |
| `write`/`create` 让一个已超限的索引**缩小或持平** | 放行 —— 增量压缩(210 → 205 → 198)必须走得通 |
| 带 `old_str`/`new_str` 的 edit:结果可模拟 | 按**结果**判定,增长/缩小规则与整文件写入相同 —— 先算大小再构建,结果长到没法构建的 `replace_all` 按字节与行数的下界判定 |
| 无法模拟的部分写入(如 `insert`)落在已超限的索引上 | **拒绝**,并告诉 agent:缩小的整文件写入是放行的 |
| 无法模拟的部分写入落在健康的索引上 | 放行 |
| `read`、`view`,以及任何未知工具 | 放行 —— 哪怕已超限,召回也绝不能被挡住 |
| 对任何其他文件的写入 | 放行 —— 不关守卫的事 |
| 整文件写入时当前索引缺失/读不到 | 视为**空**(与 Python 版守卫一致)—— 上限内的写入放行,而首次就超限的写入被拒 |
| 部分编辑时索引缺失/读不到 | 放行 —— 守卫绝不能因为一个自己读不了的路径而挡住工作 |
| 用索引名字的 FIFO、设备或目录 | 一律不读,按读不到处理(在那里读会把宿主卡死或撑爆内存,而宿主在主线程上跑守卫) |
| 超过读取上限的索引(`min(16 MiB, max(1 MiB, 4 × maxBytes))`) | 不整份读入:整文件写入按文件系统报告的大小比较字节(缩小一律放行;行数未知,这时不卡行数),edit 无法测量,按读不到的索引处理,放行 |
| 畸形的执行(没有 arguments、路径/内容不是字符串) | 放行 —— 它压根不像一次写入 |

对可测量的结果,只拒绝某个维度既超出上限、又比当前文件增长的写入。行数统计忽略结尾换行,
所以正好卡在上限的索引仍然可写。此判决表由 CI 中的 `node --test` 固定验证。

相对路径优先通过会话的 `workingDirectory` 服务解析,服务不存在时退回进程 cwd。
edit 在统一为 LF 的文本上匹配,计算结果大小时保留文件原有换行,包括 CRLF 的字节数。

## 已知限制

- **无法模拟的部分编辑可能从上限之下直接越界。** 若索引可读且已经超限,则拒绝这种编辑;
  可以用缩小的整文件写入来压缩。文件缺失、不可读和超过读取上限的例外见上表。
  编辑索引后运行 `engramory_check.py`,定期运行 `engramory_doctor.py`。
- **只覆盖已知文件工具:**使用 `file_path` 的 `write`/`edit`、`str_replace`/`insert`,
  以及使用 `path` 的 `str_replace_editor` 修改命令。未知工具放行。
  **Shell 工具、MCP 文件工具和外部编辑器都绕过守卫。**
- dsh 的插件 API 可能变化。本插件使用 `ctx.tools.guard()` 和两个响应式 `ctx.inject()`
  子上下文,分别接入 skill 注册表和会话工作目录;兼容声明需要真实宿主的运行记录,
  不能只凭单元测试。

## 许可

MIT —— 见 [Engramory 仓库](https://github.com/tinqiao-oss/engramory)。

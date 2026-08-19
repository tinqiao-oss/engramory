[English](README.md) | **简体中文**

# dsh-engramory

[![dsh-xray](https://img.shields.io/endpoint?url=https%3A%2F%2Funstone.github.io%2Fdsh-xray%2Fbadge%2Ftinqiao-oss__engramory.json)](https://unstone.github.io/dsh-xray/registry.html#tinqiao-oss__engramory)

<sub>`C2` 是 `manifest.bundle.patch` 给每个可挂载 dsh 插件定的档位(被扫描生态里 74.6% 都在这一档);它是这张卡片上**唯一**的标记 —— 没有 `exec`、没有 `eval`、没有安装脚本、没有外连域名、不读环境变量。</sub>

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**策展式、文件式**长期记忆 ——
纯 markdown 笔记,随便什么工具都能打开;一个记忆库被你用的所有宿主共用;索引上限是一次
**真正的拒绝**,而不是一句请求。(记忆库若位于某个项目的 git 仓库内,必须 git-ignore ——
记忆里带着本机独有的细节,见 SKILL.md §1。给记忆库单独开一个*私有仓*则完全可以。)

隶属于 [Engramory](https://github.com/tinqiao-oss/engramory)。

## 已经有 `AGENTS.md` 常驻块了,为什么还要插件

那个常驻块确实承载了纪律,单论召回也够用了。但有两件事它做不到:

**上限从此是确定性的。** Engramory 把索引控制在 200 行 / 25 KB 以内,是因为索引每次会话
都要加载,超出的部分会**悄无声息地不再被召回**。在多数宿主上,这个限制只是"规则 + 一个
要靠 agent 自己记得去跑的校验器"。而 dsh 暴露了 `ctx.tools.guard()` —— 一个同步的、
**单调**的否决:守卫一旦返回理由,后面任何监听器都无法把它翻回放行。所以在这里,上限是被
**强制执行**的,不是被请求的。请用 **0.2.1 或更高版本**:0.2.0 发布时上游的 profile 安装还
没打通,而且它的 `inject` 声明是这版 Cordis 不接受的写法 —— 装得上,但**永远激活不了**
(issue #8)。在 Claude Code 之外,dsh 是第一个真正把这层垫片写出来的宿主(另有几个宿主
同样暴露了等价的写前接缝,见 PORTING.md,但还没有垫片实现)。

**协议随插件一起到达。** skill 是在运行时通过 dsh 的 skill 注册表注册的 —— 走一个响应式的
`ctx.inject(['skills'], …)` 子上下文,所以没有注册表的 profile 照样拿到上限,而注册表晚一步
挂载的 profile 也照样拿得到 skill。这意味着它**不依赖**把文件放进 dsh 扫描的那五个 skill 根
目录之一 —— 那条路很容易在细微处放错,而一旦放错就是**静默失败**。

## 安装

```sh
dsh plugin --profile <名字> add dsh-engramory
```

装到这里就完了。这个包自带 `dsh.bundle` manifest 指向它自己的 `cordis.patch.yml`,所以那一行
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

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `indexName` | `MEMORY.md` | 被当作记忆索引的文件名(不区分大小写;`file_path` 与 `str_replace_editor` 的 `path` 都会检查)。空值或非字符串会回退到默认值。除此之外不检查任何东西。 |
| `maxLines` | `200` | 硬性行数上限。非正数或非有限值回退到默认值。 |
| `maxBytes` | `25600` | 硬性 UTF-8 字节上限(25 KB)。 |
| `indexPath` | 未设置 | 要守护的**那一个**索引的绝对路径。不设它时,守卫只按文件名匹配,于是**别的项目里一个无关的 `MEMORY.md` 也会被拦**;设了它就只有这个确切的文件会被守。比较走的是身份而非拼写(symlink 与 `..` 都会解析;仅在 Windows 上折叠大小写),而且即使文件尚不存在,它的第一次写入照样受守护。 |
| `registerSkill` | `true` | 设为 `false` 则保留上限、但跳过运行时 skill。 |
| `skill` | 内置 | 用你自己的 markdown 替换 skill 正文。 |

## 守卫到底做了什么

| 调用 | 判决 |
|---|---|
| `write`(或 `str_replace_editor` 的 `create`)且结果在上限内 | 放行 |
| `write`/`create` 会让索引**增长**并越过上限 | **拒绝**,并报出具体数字和该压缩什么 |
| `write`/`create` 让一个已超限的索引**缩小或持平** | 放行 —— 增量压缩(210 → 205 → 198)必须走得通 |
| 带 `old_str`/`new_str` 的 edit:结果可模拟 | 按**结果**判定,增长/缩小规则与整文件写入相同 |
| 无法模拟的部分写入(如 `insert`)落在已超限的索引上 | **拒绝**,并告诉 agent:缩小的整文件写入是放行的 |
| 无法模拟的部分写入落在健康的索引上 | 放行 |
| `read`、`view`,以及任何未知工具 | 放行 —— 哪怕已超限,召回也绝不能被挡住 |
| 对任何其他文件的写入 | 放行 —— 不关守卫的事 |
| 整文件写入时当前索引缺失/读不到 | 视为**空**(与 Python 版守卫一致)—— 上限内的写入放行,而首次就超限的写入被拒 |
| 部分编辑时索引缺失/读不到 | 放行 —— 守卫绝不能因为一个自己读不了的路径而挡住工作 |
| 畸形的执行(没有 arguments、路径/内容不是字符串) | 放行 —— 它压根不像一次写入 |

拒绝规则与 `hooks/engramory_index_guard.py` **完全一致**:只拒绝那种结果既超过上限、
又比当前文件更大的写入。行数统计忽略结尾换行,所以一个正好卡在上限的索引仍然可写。

## 已知限制

- **从上限之下一跃越过上限的、无法模拟的部分写入,抓不住。** `insert` 这类调用并不携带
  写入后的文本。这种越界会由下一次整文件写入、或 `engramory_check.py` 抓到。能保证的是:
  一个**已经超限**的索引不会被继续撑大,而缩小的写入永远放行。
- **工具名单遵循 dsh 文档化的 tool-fs 契约**(`write`/`edit` 用 `file_path`,
  `str_replace_editor` 用 `path`),并且刻意保守:未知工具一律放行。
- **0.2.0 从未激活成功;0.2.1 才是第一个真正跑得起来的版本。** 在 rc.6 预览版那个 bug
  堵住上游所有第三方 profile 安装期间,插件能有的覆盖只有 mock —— 而 0.2.0 的 mock 恰好
  掩盖了两个激活期 bug:一个是旧版 Cordis 的 `{ required, optional }` inject 写法(被解读成
  在等待名字就叫 `required`/`optional` 的服务,于是永远 pending),另一个是裸读未声明的
  `ctx.skills`(在 Cordis 的反射式上下文下会直接抛错)。安装一旦成为可能,**首个真实安装
  当场把两个都暴露了**(issue #8)。0.2.1 修掉了它们,并在一个真跑着的 dsh 0.1.0-rc.7 web
  profile 上端到端验证过(0.2.0 逐字节复现启动失败;0.2.1 能启动并提供服务),也对着 dsh
  内置的 `@deepseek-ai/cordis` 解析器验过(注册表存在、不存在、以及晚挂载三种情况下的激活)。
  测试用的 mock 现在会照着反射式上下文的访问规则来,守卫的判决表则由 `node --test`
  持续覆盖(28 个用例,在 Engramory 的 CI 里跑)。
- dsh 目前是开发者预览版,插件 API 可能变化。本插件刻意只碰 `ctx.tools.guard()` 和一个
  注册 skill 的响应式 `ctx.inject(['skills'], …)` 子上下文,所以要跟着改也很便宜。

## 许可

MIT —— 见 [Engramory 仓库](https://github.com/tinqiao-oss/engramory)。

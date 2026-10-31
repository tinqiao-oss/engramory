# Engramory 品牌素材

标志是双链 `[[ ]]` 中间一个光标。`[[ ]]` 是 markdown 笔记里链接另一条笔记的写法，光标表示正在写下一条记忆。动图里它像一本合在左边的书，往右翻过几页，翻开后在光标处打出 `engramory`；最后一个字母 y 落下的同时光标退场，停在 `[[engramory]]`。

标语：**Agent 通用长期记忆层**（英文 General-purpose long-term memory layer for AI agents）。

## 颜色

| 名称 | 色值 | 用在哪 |
|---|---|---|
| 深蓝 | `#0F1B2D` | 图标底色、深色背景；浅色背景上的括号和文字 |
| 薄荷 | `#6EE7C8` | 深色背景上的括号、文字和光标 |
| 青绿 | `#12A07F` | 浅色背景上的光标 |

## 文件

| 目录 | 内容 | 用途 |
|---|---|---|
| `icon/` | `engramory-icon.svg`，PNG 16–1024，`favicon.ico`（16/32/48） | 应用图标、dsh 插件图标、网站图标 |
| `mark/` | 无底色标志：`on-dark`（薄荷）、`on-light`（深蓝 + 青绿），SVG + 512 PNG | 放在别的背景上 |
| `lockup/` | 横版字标 `[[engramory]]`：`on-dark` / `on-light`，SVG + 1600 宽 PNG | 文档、幻灯片、网页页头 |
| `banner/` | 深蓝底横幅，SVG + 1200 / 2400 宽 PNG | README 页头（打字动图打完字、停住时的那一帧） |
| `social/` | GitHub 社交预览图 1280×640 | 仓库 Settings → Social preview 手动上传 |
| `anim/` | `book`（方形翻书，4.8 秒）、`typing`（横版打字，4.9 秒）、`merged`（翻开后打字，7.7 秒）；GIF 50 帧/秒 + MP4 | README、社交媒体、视频片头 |

社交预览图上的标语和仓库 README 第一句、GitHub About 要保持一致，改一处就三处一起改。

## 用法

- 带字的地方（字标、横幅、预览图）都不带光标；只有不带字的图标和标志保留中间的光标。
- 深色背景用 `on-dark`，浅色背景用 `on-light`。薄荷色放在白底上对比度不够，不要这样用。
- 最小尺寸：图标 16 px；横版字标高度不小于 20 px。
- 四周留白至少一个光标宽。
- 不要拉伸、旋转、换色、加描边或阴影，也不要换字体重排字标。
- 动图（GIF、MP4）和横幅都带深蓝底色（GIF 不支持半透明）；要放在浅色页面上又不要底色，用 `mark/` 或 `lockup/` 里透明底的静图。

## 字体

字标和英文标语用 JetBrains Mono（Bold / Regular），中文标语用思源黑体（Noto Sans SC），都是 SIL Open Font License 1.1。所有文字都已转成曲线，看图的电脑不需要装这些字体。

## 重新生成

两个脚本在 `src/`，共用同一套几何参数（`src/make_anim.py` 开头），改形状、颜色或字号只改那一处；标语在 `src/make_brand.py` 开头。

需要 Chrome（找不到时用环境变量 `CHROME` 指定）、`ffmpeg`，以及 Python 包：

```bash
pip install fonttools pillow websockets
python brand/src/make_brand.py   # 静态：图标、标志、字标、横幅、社交预览图
python brand/src/make_anim.py    # 动图：book / typing / merged（也可只给其中几个名字）
```

字体第一次运行时自动下载到 `src/.fonts/`，渲染用的临时帧放在 `src/.cache/`，两处都不进仓库。

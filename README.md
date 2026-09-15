# BiliDigest · B站收藏夹 AI 分拣台

Chrome 插件。用 AI 快速看懂大量 B 站收藏，决定删、留还是打标签，把有价值的要点摘出来导出。

所有数据只存在你自己的浏览器里，不经过任何第三方服务器。

## 功能

- **两段式 AI 分拣**
  - 标题粗分：一次把几十个标题交给 AI，分成建议删、建议留、待定。
  - 字幕细看：对待定的视频每轮看 5–10 个，给出一句话、3 个要点、判断和建议标签。
- **直接操作 B 站**：按 D 在 B 站取消收藏，按 U 撤销。
- **自定义标签**：不用收藏夹组织内容。标签挂在视频上，视频换收藏夹也不会丢。
- **和 B 站同步**：打开页面时对比 B 站最新收藏列表，提示新增、在 B 站被移除、已失效的视频。
- **摘录篮**：把要点收集到一起，复制为 Markdown 或写入 Obsidian。
- **数据导出**：完整备份（JSON，不含密钥）和表格（CSV，Excel 可直接打开）。
- **AI 调试**：思考开关，标题粗分和字幕细看的输出上限都可以自己调。

## 安装

1. 下载或 `git clone` 本仓库。
2. 打开 `chrome://extensions`，开启"开发者模式"。
3. 点"加载已解压的扩展程序"，选择仓库里的 `extension/` 目录。
4. 如果装过商店版 Bilibili Obsidian Clipper，先把它关掉，否则视频页会出现重复按钮。

## 配置

1. 点插件图标 → 设置 → AI 平台，添加一个 OpenAI 兼容平台，比如 DeepSeek，填入 API Key 和模型名。
2. （可选）要把摘录写进 Obsidian：安装 Obsidian 插件 `Local REST API with MCP`，开启 HTTP 服务，把 API Key 填到插件设置里。

## 使用

点插件图标 → "打开 BiliDigest 分拣台" → 选择收藏夹 → "标题粗分" → "细看这一组"。

| 按键 | 作用 |
|---|---|
| J / K | 下一个 / 上一个 |
| D | 在 B 站取消收藏 |
| S | 保留 |
| T | 打标签 |
| A | 采纳 AI 建议的标签 |
| E | 加入 / 移出摘录篮 |
| X | 选中，用于组成细看的一组 |
| O / Enter | 打开视频 |
| U | 撤销 |
| ? | 快捷键帮助 |

## 开发

- 分拣台页面：`extension/triage/triage.html|css|js`
- 后台接口层：`extension/triage/triage-bg.js`，由 `background.js` 末尾加载
- 后台纯函数自检：`node extension/triage/triage-bg.selftest.js`
- 无插件环境预览页面：用静态服务器打开 `extension/triage/triage.html`，会自动启用 `dev/mock-chrome.js` 里的假数据

## 来源与许可

- 基于 [haixiong1997/Bilibili-Obsidian-Clipper](https://github.com/haixiong1997/Bilibili-Obsidian-Clipper)（MIT）二次开发，目前仍保留原插件的字幕面板、AI 侧边栏、阅读视图等功能。
- 与同名项目 [JackMeds/BiliDigest](https://github.com/JackMeds/BiliDigest)（Python 命令行工具）无关，未使用其代码。
- 许可证：MIT，见 [LICENSE](LICENSE)。

## 免责声明

本工具只在你已登录 B 站、且有访问权限的前提下读取和修改你自己的收藏数据。所有请求都通过你自己的浏览器和 cookie 发出。请遵守 B 站用户协议与相关法律法规，使用后果由使用者自行承担。

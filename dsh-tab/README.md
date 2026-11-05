# dsh-tab

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）会话区加一排书页式会话标签页：一个会话一个标签，切换不刷新页面，可以固定、关闭、归档、拖拽排序，每个标签还会显示它所属的工作区。

Browser-style conversation tabs for DeepSeek Harness (DSH): one tab per conversation, workspace badges, drag reorder, pin / close / archive. Built on official DSH slots, services and theme tokens.

[![npm](https://img.shields.io/npm/v/dsh-tab.svg?color=cb3837)](https://www.npmjs.com/package/dsh-tab)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/imchangchang/dsh-tab/blob/main/LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.2.1--rc.5-4d93f8.svg)](#兼容性)
[![Platform](https://img.shields.io/badge/platform-web%20%7C%20desktop-6b7280.svg)](#兼容性)

npm 包名：**`dsh-tab`**。

![标签栏特写](https://cdn.jsdelivr.net/gh/imchangchang/dsh-tab@v0.2.0/docs/images/bar-closeup.png)

## 功能

- **一个会话一个标签页**：打开、恢复、新建会话时自动入签；点击标签走官方 `uiWorkspace.openSession`，不刷新页面。当前会话的标签和下面的会话页连成一张纸，形成「书页」效果。
- **工作区角标**：每个标签左上角显示所属工作区（颜色由工作区 ID 哈希得到，文字是工作区名，悬停看全名）；固定标签只显示图标时用更小字号。
- **新建会话**：`+` 在最后一个标签右侧；标签多到放不下时标签条自己横向滚动，`+` 始终可见。
- **固定 / 取消固定**：固定的标签排在最左、只显示图标（40px 宽）并带状态点，和普通标签之间有分隔线。
- **拖拽排序**：按住标签左右拖动即可换位，落点画一条强调色竖线；固定标签和普通标签各自在自己的分组内排序，顺序存 `localStorage`，刷新保持。`Esc` 或窗口失焦取消本次拖拽。
- **右键菜单**：关闭标签页 / 关闭右侧 / 关闭其他 / 关闭全部 / 固定（取消固定）/ 归档会话。归档走官方 `uiWorkspace.archiveSession`，会话正在运行或等待回复时先确认「停止并归档」。
- **状态点**：蓝色呼吸点 = 正在运行，黄色 = 等你回复，绿色 = 有新的完成内容。
- **键盘**：标签获得焦点时 `←` / `→` 切换相邻标签并激活；右键菜单里 `Esc` 关闭。
- **过渡**：切换标签时先跑 140ms 的宽度 / 高度过渡，动画结束后再切会话内容——官方切会话会同步重渲染整个会话页（实测一次 60–75ms 长任务），两段并行会把标签动画顶卡。代价是内容切换比点击晚约 150ms。
- **浅色 / 深色**：全部颜色走 `--dsw-alias-*` token，自动跟随主题。

## 截图

下面三张截图全部用模拟数据生成（左侧栏、工作区、会话标题都是虚构的），原始页面在 [`docs/mock/demo.html`](https://github.com/imchangchang/dsh-tab/blob/main/docs/mock/demo.html)，可以本地打开或跑 `npm run docs:mock` 重新生成。

浅色主题：

![浅色主题](https://cdn.jsdelivr.net/gh/imchangchang/dsh-tab@v0.2.0/docs/images/tabs-light.png)

深色主题：

![深色主题](https://cdn.jsdelivr.net/gh/imchangchang/dsh-tab@v0.2.0/docs/images/tabs-dark.png)

右键菜单（固定标签、关闭、归档）：

![右键菜单](https://cdn.jsdelivr.net/gh/imchangchang/dsh-tab@v0.2.0/docs/images/context-menu.png)

## 安装

要求：DSH 桌面版或 Web GUI，0.2.1-rc.5 附近版本（用法见「兼容性」）。

**从 npm 安装（推荐）**：让 Agent 执行

```
plugin_manager install_bundle target=dsh-tab
```

或先本地下载包再安装：

```bash
npm pack dsh-tab          # 或在 npmjs.com/package/dsh-tab 下载 tgz
```

安装后刷新窗口（macOS 上 `Cmd+R`）生效。

**从源码安装**：

```bash
git clone https://github.com/imchangchang/dsh-tab.git
```

然后在 DSH 里把仓库目录作为本地插件安装：设置 → 插件 → 添加插件，选择 `dsh-tab` 目录；或让 Agent 执行 `plugin_manager install_bundle target=<dsh-tab 的绝对路径>`。

插件没有构建步骤，`client.js` 由 DSH 直接加载；安装/升级后在设置里确认依赖版本是刚发布的版本。

## 使用

| 操作 | 方式 |
| --- | --- |
| 切换会话 | 左键点击标签页 |
| 关闭标签页 | 标签页上的 `×` / 鼠标中键 / 右键菜单 |
| 新建会话 | 最后一个标签右侧的 `+` |
| 调整顺序 | 按住标签左右拖拽（同组内） |
| 固定 / 取消固定 | 右键菜单 → 固定标签页 / 取消固定标签页 |
| 关闭一批 | 右键菜单 → 关闭右侧 / 关闭其他 / 关闭全部 |
| 归档会话 | 右键菜单 → 归档会话（运行中会先确认是否停止） |
| 键盘切换 | 标签聚焦时 `←` / `→` |

## 工作原理

插件分两半：

| 部分 | 文件 | 说明 |
| --- | --- | --- |
| 宿主半 | `index.js` | 空 `apply()`，只负责让 DSH 认识这个包 |
| 浏览器半 | `client.js` | 标签栏、右键菜单、拖拽、帧布局样式、`localStorage` 持久化 |

浏览器半用到的官方扩展点：

| 扩展点 | 用途 |
| --- | --- |
| `shell.overlay` 座位 | 标签栏放在会话列顶部，绝对定位、横跨「会话列 + 右侧产物栏」 |
| 帧布局样式 | 把三栏 frame 改成三行：第 1 行 44px 给标签栏，第 2 行会话内容，第 3 行官方 `shell.bottom`。只依赖官方既有标记 `data-shell-bottom` / `data-shell-overlay` / `data-side` |
| `ctx.uiWorkspace.openSession / startSession / archiveSession` | 切换、新建、归档会话 |
| `ctx.sessions.list` | 读当前会话（`retainedBy.mainView > 0`）与会话状态 |
| `useWorkspaces` | 取工作区标题与会话归属，生成角标 |
| `ctx.slots.inject('shell.overlay', …)` | 注册 React 组件，标准 props 直接可用 |
| `ctx.locale.register / bind` | 中英文文案 |
| 主题 token | `--dsw-alias-*`，浅色 / 深色自动跟随 |

标签顺序和固定状态存在浏览器 `localStorage` 的 `dsh.tab.view.v2` 里（`{ tabs: string[], pinned: string[] }`），旧键 `dsh.tab.openSessions.v1` 会自动迁移。

## 兼容性

- 开发和验证环境：DSH 桌面版 **0.2.1-rc.5**（macOS），Web GUI 同版本。
- 帧布局是唯一与官方 DOM 强耦合的部分：如果官方改了 frame 的三行 / 标记结构，标签栏会回退到三栏下方（不会崩溃），需要按新 DOM 更新 `FRAME_CSS`。
- 插件 API 只使用官方文档列出的座位、服务与 token；不读官方 store，不写官方 DOM 内容。

## 数据与隐私

- 标签顺序、固定状态只存在浏览器 `localStorage`，不上传，不发网络请求。
- 不收集会话内容；工作区角标只读官方工作区标题。
- 关闭标签页不等于删除会话；归档会话走官方归档接口，可在官方归档列表中恢复。

## 开发

不需要构建：

```bash
npm run check      # node --check 语法检查
npm run docs:mock  # 从 client.js 的 CSS 生成 docs/mock/demo.html（模拟数据截图页）
npm pack --dry-run # 查看要发布到 npm 的文件
```

本地开发时把仓库目录 link 到 DSH profile 的依赖里（或直接用「安装」里的步骤），改 `client.js` 后 HMR 会应用浏览器半，刷新窗口生效。

目录：

```
client.js             浏览器半：标签栏 / 菜单 / 拖拽 / 帧布局样式 / 持久化
index.js              宿主半（空 apply）
cordis.patch.yml      bundle patch：插入一个 loader 行
locale/zh.json        插件元数据（中文）
locale/en.json        插件元数据（英文）
icon.svg              插件图标
docs/mock/demo.html   模拟数据演示页（截图用）
docs/images/          README 截图
scripts/make-demo.mjs 生成演示页
```

## 已知边界

- 标签宽度跟着标题文字自适应：普通标签最多 180px，激活标签最多 270px（普通标签的 1.5 倍），标题短就正好显示全部文字、不预留空白。
- 工作区角标最多占标签宽度的 1/2，长工作区名会截断（悬停看全名）；固定标签只有 40px 宽，角标固定 38px。
- 拖拽只在同一分组内生效，不能把固定标签拖成普通标签；拖到另一端时不会自动滚标签条。
- 切换标签会先跑标签动画、再切会话内容，内容比点击晚约 150ms；可以用 `client.js` 顶部的 `SELECT_COMMIT_DELAY` 调整或关闭这个延迟。
- 未实现全局快捷键（`⌘T` / `⌘W` 等）；右键菜单不支持方向键导航（标签本身支持 `←` / `→`）。
- 只在 macOS 的 DSH 桌面版和 Chrome 系 Web GUI 上验证过，其他平台尚未测试。

## License

[MIT](https://github.com/imchangchang/dsh-tab/blob/main/LICENSE)

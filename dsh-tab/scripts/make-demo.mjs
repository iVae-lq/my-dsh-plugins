// 生成 README 用的模拟数据截图页面，产物在 docs/mock/demo.html。
// 页面里的工作区、会话标题全部是虚构数据，不读取任何真实会话。
// 数据全部是虚构的，与真实工作区/会话无关。
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const root = process.cwd()
const clientSource = readFileSync(join(root, 'client.js'), 'utf8')
const cssMarker = '    const CSS = `'
const cssStart = clientSource.indexOf(cssMarker)
if (cssStart < 0) throw new Error('plugin CSS not found')
const cssBodyStart = cssStart + cssMarker.length
const cssEnd = clientSource.indexOf('`\n', cssBodyStart)
const pluginCss = clientSource.slice(cssBodyStart, cssEnd)

const TOKENS = {
  '--dsw-alias-bg-base': ['#fff', '#151517'],
  '--dsw-alias-bg-layer-1': ['#fff', '#232324'],
  '--dsw-alias-bg-layer-2': ['#fff', '#2c2c2e'],
  '--dsw-alias-bg-module-platform': ['#f5f6f7', '#353638'],
  '--dsw-alias-border-l1': ['#0000000d', '#ffffff1a'],
  '--dsw-alias-border-l2': ['#0000001a', '#ffffff1f'],
  '--dsw-alias-border-l3': ['#0000001f', '#ffffff26'],
  '--dsw-alias-label-primary': ['#0f1115', '#f9fafb'],
  '--dsw-alias-label-secondary': ['#61666b', '#cfd3d6'],
  '--dsw-alias-label-tertiary': ['#81858c', '#adb2b8'],
  '--dsw-alias-label-dimmed': ['#e1e5ee', '#43454a'],
  '--dsw-alias-interactive-bg-hover': ['#2631480f', '#ffffff14'],
  '--dsw-alias-interactive-bg-hover-danger': ['#ec13130d', '#f25a5a26'],
  '--dsw-alias-state-business-primary': ['#4176e6', '#7aaaff'],
  '--dsw-alias-state-warn-primary': ['#f59e0b', '#f59e0b'],
  '--dsw-alias-state-success-primary': ['#22c55e', '#22c55e'],
  '--dsw-alias-state-error-primary': ['#ec1313', '#f25a5a'],
  '--dsw-radius-sm': ['8px', '8px'],
  '--dsw-radius-md': ['12px', '12px'],
  '--dsw-shadow-lv2': ['0 4px 12px 0 #00000005, 0 2px 8px 0 #0000000a', '0 4px 12px 0 #00000033, 0 2px 8px 0 #00000026'],
  '--dsw-specific-sidebar-fill': ['#f9fafb', '#1b1b1c'],
  '--dsw-font-family': [
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
  ],
}

const tokenCss = (index) =>
  Object.entries(TOKENS)
    .map(([name, values]) => `  ${name}: ${values[index]};`)
    .join('\n')

const hue = (key) => {
  let h = 0
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) % 360
  return h
}
const badgeStyle = (workspaceId) => `background-color:hsl(${hue(workspaceId)} 46% 38%)`

const ICON = {
  chat: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 8c0 2.6-2.3 4.7-5.2 4.7-.6 0-1.2-.1-1.8-.3L3.5 13.2l.7-2c-.9-.8-1.4-2-1.4-3.2C2.8 5.4 5.1 3.3 8 3.3s5.2 2.1 5.2 4.7Z"/></svg>',
  compass:
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.4"/><path d="M9.9 6.1 8.7 8.7 6.1 9.9l1.2-2.6 2.6-1.2Z"/></svg>',
  plus: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3.2v9.6M3.2 8h9.6"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>',
  panel:
    '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.2" y="3.2" width="11.6" height="9.6" rx="2"/><path d="M9.4 3.4v9.2"/></svg>',
  users:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="6" cy="5.4" r="2.3"/><path d="M2.4 13.2c.3-2.2 1.8-3.5 3.6-3.5s3.3 1.3 3.6 3.5"/><circle cx="11.3" cy="5.8" r="1.8"/><path d="M10.4 9.9c1.5.2 2.6 1.4 2.9 3.1"/></svg>',
  shield:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M8 2.4 13 4v3.6c0 3-2 5-5 6-3-1-5-3-5-6V4l5-1.6Z"/></svg>',
  folder:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2.4 4.2c0-.6.4-1 1-1h3l1.4 1.6h4.8c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H3.4c-.6 0-1-.4-1-1V4.2Z"/></svg>',
  clock:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="5.6"/><path d="M8 4.8V8l2.2 1.6"/></svg>',
  spark:
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2.6 9.2 6.4 13 7.6 9.2 8.8 8 12.6 6.8 8.8 3 7.6 6.8 6.4 8 2.6Z"/></svg>',
  send:
    '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 12.6V3.6M4.4 7 8 3.4 11.6 7"/></svg>',
}

const workspaceLabels = {
  'demo-webapp': 'demo',
  'docs-center': '文档',
  'data-lab': '数据',
  'ops-platform': '运维',
}

const tabs = [
  { pinned: true, workspace: 'demo-webapp', title: '新会话', blank: true, signal: 'running' },
  { pinned: true, workspace: 'docs-center', title: '写作规范', blank: false },
  { workspace: 'demo-webapp', title: '设计评审待办整理', blank: false, active: true, signal: 'running' },
  { workspace: 'docs-center', title: '每周周报草稿', blank: false },
  { workspace: 'data-lab', title: '数据清洗脚本', blank: false },
]

const renderTab = (tab) => {
  const attrs = [
    `class="dsh-tab-pagebar__tab"`,
    `role="tab"`,
    `tabindex="${tab.active ? '0' : '-1'}"`,
    `aria-selected="${tab.active ? 'true' : 'false'}"`,
    `data-pinned="${tab.pinned ? 'true' : 'false'}"`,
    `title="${tab.title} · ${workspaceLabels[tab.workspace]}"`,
  ].join(' ')
  const badge = `<span class="dsh-tab-pagebar__badge" style="${badgeStyle(tab.workspace)}" title="工作区：${workspaceLabels[tab.workspace]}">${workspaceLabels[tab.workspace]}</span>`
  const icon = tab.blank ? ICON.compass : ICON.chat
  const dot = tab.signal
    ? `<span class="dsh-tab-pagebar__dot" data-signal="${tab.signal}" role="img" aria-label="运行中" title="运行中"></span>`
    : ''
  const close = tab.pinned ? '' : `<button type="button" class="dsh-tab-pagebar__close" title="关闭标签页" aria-label="关闭标签页">${ICON.close}</button>`
  return `<div ${attrs}>${badge}<span class="dsh-tab-pagebar__icon">${icon}</span><span class="dsh-tab-pagebar__label">${tab.title}</span>${dot}${close}</div>`
}

const pinnedCount = tabs.filter((tab) => tab.pinned).length
const tabHtml = tabs
  .map((tab, index) => {
    const isLastPinned = tab.pinned && index === pinnedCount - 1 && tabs.length > pinnedCount
    return `${renderTab(tab)}${isLastPinned ? '<span class="dsh-tab-pagebar__divider" aria-hidden="true"></span>' : ''}`
  })
  .join('')

const MENU_ITEMS = [
  '关闭标签页',
  '关闭右侧标签页',
  '关闭其他标签页',
  null,
  '关闭全部标签页',
  null,
  '固定标签页',
  null,
  '归档会话',
]
const menuHtml = MENU_ITEMS.map((label) =>
  label === null
    ? '<div class="dsh-tab-menu__sep" role="separator"></div>'
    : `<button type="button" class="dsh-tab-menu__item">${label}</button>`,
).join('')

const sidebarSessions = [
  ['demo-webapp', ['设计评审待办整理', '接口联调问题清单', '标签页交互草稿']],
  ['docs-center', ['每周周报草稿', '写作规范']],
  ['data-lab', ['数据清洗脚本']],
  ['ops-platform', ['发布检查清单']],
]
const sidebarHtml = sidebarSessions
  .map(
    ([workspace, sessions]) => `<div class="mock-ws">${workspaceLabels[workspace]}</div>` +
      sessions.map((title) => `<div class="mock-session"><span>${ICON.chat}</span><span class="mock-session-title">${title}</span></div>`).join(''),
  )
  .join('')

const demoHtml = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-tab 演示截图（模拟数据）</title>
<style>
:root{${tokenCss(0)}}
body[data-ds-dark-theme]{${tokenCss(1)}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;padding:18px;background:linear-gradient(135deg,#eef1f7,#e7ebf4);
  font-family:var(--dsw-font-family);color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}
body[data-ds-dark-theme]{background:linear-gradient(135deg,#0d0f13,#15161c)}
.mock-frame{position:relative;display:flex;height:calc(100vh - 36px);border-radius:18px;overflow:hidden;
  background:var(--dsw-alias-bg-base);box-shadow:0 18px 50px rgba(30,50,90,.14)}
/* 左侧栏 */
.mock-sidebar{width:280px;flex:none;background:var(--dsw-specific-sidebar-fill);
  border-right:.5px solid var(--dsw-alias-border-l3);padding:14px 12px;display:flex;flex-direction:column;gap:2px}
.mock-brand{display:flex;align-items:center;gap:9px;padding:4px 8px 14px;font-size:14px;font-weight:600}
.mock-logo{width:24px;height:24px;border-radius:8px;background:linear-gradient(135deg,#5aa7f2,#3b6fe6);
  display:grid;place-items:center;color:#fff}
.mock-brand small{font-size:10px;font-weight:600;letter-spacing:.08em;padding:2px 5px;border-radius:4px;
  background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-base);opacity:.85}
.mock-newbtn{height:34px;display:flex;align-items:center;justify-content:center;gap:6px;margin-bottom:10px;
  font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md)}
.mock-nav{display:flex;flex-direction:column;gap:2px;padding:2px 0 10px}
.mock-nav-row{height:32px;display:flex;align-items:center;gap:9px;padding:0 8px;border-radius:8px;
  font-size:13px;color:var(--dsw-alias-label-secondary)}
.mock-nav-row.active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mock-section{margin:6px 8px 6px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.mock-ws{margin:10px 8px 4px;font-size:12px;color:var(--dsw-alias-label-tertiary);
  display:flex;align-items:center;gap:6px}
.mock-session{height:30px;display:flex;align-items:center;gap:8px;padding:0 8px;border-radius:8px;
  color:var(--dsw-alias-label-secondary);font-size:13px}
.mock-session.active{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.mock-session svg{flex:none;opacity:.75}
.mock-session-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 主区域 */
.mock-main{position:relative;flex:1;min-width:0;display:flex;flex-direction:column;
  padding-top:44px;background:var(--dsw-alias-bg-base)}
.mock-conv-header{flex:none;padding:10px 28px 0 20px;display:flex;flex-direction:column;gap:10px;
  border-bottom:.5px solid var(--dsw-alias-border-l3)}
.mock-conv-title-row{display:flex;align-items:center;gap:14px;min-height:30px}
.mock-conv-title{font-size:14px;font-weight:500;line-height:20px}
.mock-chips{display:flex;align-items:center;gap:14px;color:var(--dsw-alias-label-tertiary);font-size:13px}
.mock-chip{display:inline-flex;align-items:center;gap:5px}
.mock-header-right{margin-left:auto;display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary)}
.mock-model{border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;padding:3px 7px;display:flex;align-items:center;gap:6px;font-size:12px}
.mock-model-dot{width:16px;height:16px;border-radius:5px;background:linear-gradient(135deg,#5aa7f2,#3b6fe6)}
.mock-views{display:flex;gap:32px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-tertiary)}
.mock-view{padding:0 0 9px;position:relative}
.mock-view.active{color:var(--dsw-alias-state-business-primary)}
.mock-view.active:after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px;
  background:var(--dsw-alias-state-business-primary)}
.mock-body{flex:1;min-height:0;display:flex;flex-direction:column;gap:18px;padding:26px 0 18px;overflow:hidden}
.mock-thread{width:min(760px,calc(100% - 120px));margin:0 auto;display:flex;flex-direction:column;gap:18px;flex:1}
.mock-bubble-user{align-self:flex-end;max-width:82%;background:#eaf1fe;color:#1f2a44;border-radius:14px;
  padding:12px 16px;font-size:14px;line-height:22px}
body[data-ds-dark-theme] .mock-bubble-user{background:#25314a;color:#dbe6ff}
.mock-assistant{display:flex;flex-direction:column;gap:9px;font-size:14px;line-height:22px;
  color:var(--dsw-alias-label-primary)}
.mock-line{height:10px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover)}
.mock-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;
  display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-base)}
.mock-card-title{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500}
.mock-card-title span:first-child{width:22px;height:22px;border-radius:7px;background:#eaf3ff;color:#3b6fe6;
  display:grid;place-items:center}
.mock-card .mock-line{width:68%}
.mock-composer{margin:auto auto 18px;width:min(760px,calc(100% - 120px));border:.5px solid var(--dsw-alias-border-l2);
  border-radius:16px;padding:12px 14px;display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-tertiary);
  font-size:13px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv2)}
.mock-composer-row{display:flex;align-items:center;gap:10px}
.mock-composer-row .spacer{flex:1}
.mock-send{width:30px;height:30px;border-radius:50%;background:var(--dsw-alias-state-business-primary);
  color:#fff;display:grid;place-items:center}
/* 右侧面板 */
.mock-right{width:320px;flex:none;border-left:.5px solid var(--dsw-alias-border-l3);
  background:var(--dsw-alias-bg-base);padding:12px 14px;display:flex;flex-direction:column;gap:14px}
.mock-right-head{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary);font-size:13px}
.mock-right-head .spacer{flex:1}
.mock-right-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;padding:11px 12px;
  display:flex;flex-direction:column;gap:7px}
.mock-right-card .mock-line{width:56%}
.mock-right-card .mock-line.short{width:34%}
.mock-menu-slot{position:absolute;left:0;top:0;right:0;bottom:0;pointer-events:none}
/* 插件样式 */
${pluginCss}
/* 演示页微调 */
.dsh-tab-pagebar{position:absolute;left:0;right:0;top:0;z-index:2}
.dsh-tab-menu{position:absolute;left:112px;top:50px;z-index:5;display:none}
html[data-demo-menu] .dsh-tab-menu{display:block}
body[data-ds-dark-theme]{color-scheme:dark}
</style>
</head>
<body>
<div class="mock-frame">
  <aside class="mock-sidebar">
    <div class="mock-brand">
      <span class="mock-logo">${ICON.spark}</span>
      <span>Demo Harness</span>
      <small>DEMO</small>
    </div>
    <div class="mock-newbtn">${ICON.plus}<span>新会话</span></div>
    <div class="mock-nav">
      <div class="mock-nav-row">${ICON.folder}<span>插件</span></div>
      <div class="mock-nav-row">${ICON.clock}<span>自动化任务</span></div>
      <div class="mock-nav-row active">${ICON.spark}<span>项目</span></div>
    </div>
    <div class="mock-section">工作区</div>
    ${sidebarHtml}
  </aside>
  <main class="mock-main">
    <div class="dsh-tab-pagebar" role="presentation">
      <div class="dsh-tab-pagebar__strip" role="tablist" aria-label="会话标签页">
        ${tabHtml}
      </div>
      <button type="button" class="dsh-tab-pagebar__new" title="新建会话" aria-label="新建会话">${ICON.plus}</button>
    </div>
    <div class="mock-conv-header">
      <div class="mock-conv-title-row">
        <div class="mock-conv-title">设计评审待办整理</div>
        <div class="mock-chips">
          <span class="mock-chip">${ICON.users}智能体团队</span>
          <span class="mock-chip">${ICON.shield}标准模式</span>
        </div>
        <div class="mock-header-right">
          <span class="mock-model"><span class="mock-model-dot"></span>demo-model</span>
          <span>···</span>
          <span>${ICON.panel}</span>
        </div>
      </div>
      <div class="mock-views">
        <span class="mock-view active">对话</span>
        <span class="mock-view">轨迹</span>
        <span class="mock-view">···</span>
      </div>
    </div>
    <div class="mock-body">
      <div class="mock-thread">
        <div class="mock-bubble-user">把上周设计评审的结论整理成一份待办清单，按模块分组，标注负责人。</div>
        <div class="mock-assistant">
          <div>好的，我先按模块拆成三类，下面是要点：</div>
          <div class="mock-line" style="width:92%"></div>
          <div class="mock-line" style="width:76%"></div>
          <div class="mock-card">
            <div class="mock-card-title"><span>${ICON.close.replace('d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"', 'd="M4 8.2 6.8 11 12 4.8"')}</span><span>已整理 3 个模块 · 12 条待办</span></div>
            <div class="mock-line"></div>
            <div class="mock-line short" style="width:42%"></div>
          </div>
        </div>
        <div class="mock-composer">
          <div>发消息或创建任务，/ 调用指令，@ 文件或对话</div>
          <div class="mock-composer-row">
            <span>${ICON.plus}</span>
            <span class="mock-chip">${ICON.shield}工作区内修改</span>
            <span class="spacer"></span>
            <span class="mock-chip"><span style="width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary)"></span>demo-model</span>
            <span class="mock-send">${ICON.send}</span>
          </div>
        </div>
      </div>
    </div>
    <div class="mock-menu-slot">${menuHtml ? `<div class="dsh-tab-menu">${menuHtml}</div>` : ''}</div>
  </main>
  <aside class="mock-right">
    <div class="mock-right-head"><span>${ICON.spark}</span><span>开始</span><span class="spacer"></span><span>${ICON.panel}</span></div>
    <div class="mock-right-card"><div class="mock-card-title"><span>${ICON.folder}</span><span>工作区文件</span></div><div class="mock-line"></div><div class="mock-line short"></div></div>
    <div class="mock-right-card"><div class="mock-card-title"><span>${ICON.clock}</span><span>会话记录</span></div><div class="mock-line"></div><div class="mock-line short"></div></div>
    <div class="mock-right-card"><div class="mock-card-title"><span>${ICON.spark}</span><span>更多工具</span></div><div class="mock-line"></div></div>
  </aside>
</div>
<script>
  const params = new URLSearchParams(location.search)
  if (params.get('theme') === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
  if (params.get('menu') === '1') document.documentElement.setAttribute('data-demo-menu', '1')
</script>
</body>
</html>
`

mkdirSync(join(root, 'docs/mock'), { recursive: true })
writeFileSync(join(root, 'docs/mock/demo.html'), demoHtml)
console.log('wrote docs/mock/demo.html', demoHtml.length, 'bytes')

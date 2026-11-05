/**
 * dsh-tab —— dsh Web GUI 的浏览器式会话标签页（浏览器半）。
 *
 * ## 层级
 * 标签栏是会话区的顶层：位于「会话列 + 右侧产物列」之上，下面才是会话头部、
 * 对话内容和右侧产物栏；切换标签页 = 切换整页会话（右侧产物栏跟随会话）。
 *
 * ## 外观
 * 书页标签：标签栏是一条比页面底色浅一号的「书脊」，选中的标签抬到页面底色、
 * 左右描边、不画底部横线，直接和下面的会话页连成一张纸。标签宽度跟着标题文字
 * 自适应（不留空白），普通标签最多 180px，激活标签最多 270px（1.5 倍），
 * 标题长才展开到上限。固定标签只显示图标。
 *
 * ## 右键菜单
 * 关闭标签页 / 关闭右侧标签页 / 关闭其他标签页 / 关闭全部标签页 /
 * 固定（取消固定）标签页 / 归档会话。归档有任务在跑的会话时先询问，确认后走
 * 官方的「停止并归档」路径。
 *
 * ## 座位与机制（全部官方公开 API）
 * - 标签栏 = `shell.overlay` 座位（官方全局浮层）：标签栏绝对定位在会话区顶部，
 *   横跨「会话列 + 右侧产物列」；帧布局样式把三栏整体下移 44px 让出这一行，
 *   左栏（sidebar）保持整高不动。
 * - 切换会话 = `ctx.uiWorkspace.openSession(id)`（官方侧栏行同一入口）；
 * - 新建对话 = `ctx.uiWorkspace.startSession()`（官方「新会话」入口，复用空白会话）；
 * - 归档会话 = `ctx.uiWorkspace.archiveSession(id, { stopActivity })`（官方归档入口）；
 * - 当前会话 = 官方会话目录里 `retainedBy.mainView > 0` 的那一条（官方 DocumentTitle 同款读法）；
 * - 运行/等待/未读 = 官方 `useSessionStatus` 投影；
 * - 文字 = `ctx.locale.register` + 座位 `locale` 选项注入的 `t`。
 *
 * 最右侧的产物侧栏开关沿用官方会话头部角上的按钮（位于标签栏下一行最右）。
 *
 * 标签页是视图层记录（浏览器本地 localStorage 持久化）：点击标签页切换当前会话，
 * 不并行渲染多个会话（官方 Conversation 一页一条会话）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-tab',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const NS = 'dsh-tab'
    // 标签宽度/高度过渡约 140ms；等它跑完再切会话，避免和官方整页重渲染抢主线程
    const SELECT_COMMIT_DELAY = 150
    const STORAGE_KEY = 'dsh.tab.view.v2'
    const LEGACY_STORAGE_KEY = 'dsh.tab.openSessions.v1'

    // ── 文案（官方 locale 命名空间；en 为必填回退） ──────────────────────────
    const ZH = {
      'tab.list': '会话标签页',
      'tab.new': '新建会话',
      'tab.newSession': '新会话',
      'tab.untitled': '未命名',
      'tab.close': '关闭标签页：{title}',
      'tab.running': '运行中',
      'tab.pending': '等待回复',
      'tab.unread': '有新完成内容',
      'tab.pinned': '已固定',
      'tab.workspace': '工作区：{name}',
      'menu.close': '关闭标签页',
      'menu.closeRight': '关闭右侧标签页',
      'menu.closeOthers': '关闭其他标签页',
      'menu.closeAll': '关闭全部标签页',
      'menu.pin': '固定标签页',
      'menu.unpin': '取消固定标签页',
      'menu.archive': '归档会话',
      'menu.archiveRunning': '这个会话还有任务在运行。归档会先停止它，再归档。',
      'menu.archiveStop': '停止并归档',
      'menu.archiveBusy': '正在归档…',
      'menu.archiveFailed': '归档失败：{message}',
      'menu.retryStop': '停止并重试',
      'menu.cancel': '取消',
    }
    const EN = {
      'tab.list': 'Conversation tabs',
      'tab.new': 'New conversation',
      'tab.newSession': 'New session',
      'tab.untitled': 'Untitled',
      'tab.close': 'Close tab: {title}',
      'tab.running': 'Running',
      'tab.pending': 'Waiting for you',
      'tab.unread': 'New completed response',
      'tab.pinned': 'Pinned',
      'tab.workspace': 'Workspace: {name}',
      'menu.close': 'Close tab',
      'menu.closeRight': 'Close tabs to the right',
      'menu.closeOthers': 'Close other tabs',
      'menu.closeAll': 'Close all tabs',
      'menu.pin': 'Pin tab',
      'menu.unpin': 'Unpin tab',
      'menu.archive': 'Archive conversation',
      'menu.archiveRunning': 'This conversation still has work running. Archiving stops it first.',
      'menu.archiveStop': 'Stop and archive',
      'menu.archiveBusy': 'Archiving…',
      'menu.archiveFailed': 'Archive failed: {message}',
      'menu.retryStop': 'Stop and retry',
      'menu.cancel': 'Cancel',
    }

    // ── 帧布局（把 shell.bottom 那行搬到三栏上方，横跨会话列 + 右栏列） ─────
    // 只依赖官方既有标记：帧上的 data-shell-bottom / data-shell-overlay，
    // 拖拽把手上的 data-side。官方改这些标记时本段失效，标签栏会回落到三栏下方
    // （不会崩溃），此时需要按新版 DOM 更新选择器。
    const FRAME_CSS = `
/* 帧改成三行：第 1 行标签栏（44px 空行，标签栏由 shell.overlay 座位绝对定位填入）、
   第 2 行会话内容、第 3 行官方 shell.bottom（诊断面板等）。 */
div:has(> [data-shell-bottom]):has(> [data-shell-overlay]) {
  grid-template-rows: 44px minmax(0, 1fr) auto !important;
}
/* 右侧产物栏全屏时标签栏隐藏，首行归零，否则全屏面板上方留一条 44px 死区 */
div:has(> [data-shell-bottom])[data-rightbar-fullscreen]:has(> [data-shell-overlay]) {
  grid-template-rows: 0 minmax(0, 1fr) auto !important;
}
/* 左栏贯穿第 1、2 行，保持整高 */
div:has(> [data-shell-bottom]):has(> [data-shell-overlay]) > :nth-child(1) {
  grid-row: 1 / 3 !important;
  grid-column: 1 !important;
}
/* 会话列、右栏列下移到第 2 行 */
div:has(> [data-shell-bottom]):has(> [data-shell-overlay]) > :nth-child(2) {
  grid-row: 2 !important;
  grid-column: 2 !important;
}
div:has(> [data-shell-bottom]):has(> [data-shell-overlay]) > :nth-child(3) {
  grid-row: 2 !important;
  grid-column: 3 !important;
}
/* 官方 shell.bottom 座位回到第 3 行（整宽） */
[data-shell-bottom] {
  grid-row: 3 !important;
  grid-column: 1 / -1 !important;
}
/* 列宽拖拽把手恢复成会话内容整高（第 1、2 行，不盖到第 3 行） */
div:has(> [data-shell-bottom]):has(> [data-shell-overlay]) > [data-side] {
  grid-area: 1 / 1 / 3 / -1 !important;
}
/* Windows 标题栏：圆角原本在会话列左上，现在改由标签栏承载 */
[data-windows-titlebar] div:has(> [data-shell-bottom]) > :nth-child(2) {
  border-top-left-radius: 0 !important;
}
`

    // ── 标签栏外观（书页标签 + 右键菜单） ──────────────────────────────────
    const CSS = `
/* 书脊条：比页面底色浅一号，底部一条细线 */
.dsh-tab-pagebar{position:absolute;top:0;right:0;z-index:2;pointer-events:auto;box-sizing:border-box;
  left:max(var(--dsh-tab-left, 0px), var(--dsh-frame-leading-clearance, 0px));
  display:flex;align-items:center;height:44px;padding:0 16px 0 20px;
  background:var(--dsw-alias-bg-module-platform);
  box-shadow:inset 0 -.5px 0 var(--dsw-alias-border-l2);
  -webkit-app-region:drag;
  --dsh-tab-max-width:180px}
html[data-windows-titlebar] .dsh-tab-pagebar{top:var(--dsh-windows-titlebar-height, 0px);
  border-top-left-radius:var(--dsh-windows-content-radius, 16px);corner-shape:round}
[data-rightbar-fullscreen] .dsh-tab-pagebar{display:none}
.dsh-tab-pagebar__strip{display:flex;align-items:flex-end;flex:0 1 auto;min-width:0;
  height:100%;overflow-x:auto;overflow-y:hidden;scrollbar-width:none;scroll-padding-inline:8px}
.dsh-tab-pagebar__strip::-webkit-scrollbar{display:none}
/* 短标签：书脊上的一张纸签 */
.dsh-tab-pagebar__tab{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:7px;
  flex:0 1 auto;min-width:72px;max-width:var(--dsh-tab-max-width);height:32px;padding:0 6px 0 12px;
  border:.5px solid transparent;border-bottom:none;border-radius:8px 8px 0 0;
  background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:18px;
  cursor:pointer;user-select:none;-webkit-user-select:none;-webkit-app-region:no-drag;touch-action:pan-y;
  animation:dsh-tab-enter .16s ease;
  transition:background-color .12s ease,color .12s ease,height .14s cubic-bezier(.2,.7,.2,1),
    max-width .14s cubic-bezier(.2,.7,.2,1),border-color .12s ease,border-radius .14s ease,box-shadow .12s ease}
.dsh-tab-pagebar__tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
/* 选中标签：抬到页面底色、不画底边线，和下面的会话页连成一张纸；
   可用宽度是普通标签的 1.5 倍（180 → 270），标题短就按实际文字宽度收住、不留空白，
   标题长才展开到 1.5 倍。切换时宽度和高度一起过渡
   （只保留上方圆角，底部直角直接接页面，不再做额外的反圆角装饰） */
.dsh-tab-pagebar__tab[aria-selected=true]{max-width:calc(var(--dsh-tab-max-width) * 1.5);height:38px;
  background:var(--dsw-alias-bg-base);
  border-color:var(--dsw-alias-border-l2);border-radius:10px 10px 0 0;color:var(--dsw-alias-label-primary)}
.dsh-tab-pagebar__tab[aria-selected=true]:hover{background:var(--dsw-alias-bg-base);
  color:var(--dsw-alias-label-primary)}
/* 固定标签：只剩图标、宽度固定 40px；激活时也不展开 */
.dsh-tab-pagebar__tab[data-pinned=true]{width:40px;min-width:40px;max-width:40px;flex:none;padding:0;
  justify-content:center;gap:4px}
.dsh-tab-pagebar__tab[data-pinned=true] .dsh-tab-pagebar__label,
.dsh-tab-pagebar__tab[data-pinned=true] .dsh-tab-pagebar__close{display:none}
.dsh-tab-pagebar__divider{flex:none;align-self:center;width:1px;height:20px;margin:0 6px;
  background:var(--dsw-alias-border-l2)}
.dsh-tab-pagebar__tab:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
/* 拖拽排序：拖动中的标签变淡，落点画一条竖线 */
.dsh-tab-pagebar__tab[data-dragging=true]{opacity:.55;cursor:grabbing}
.dsh-tab-pagebar__tab[data-drop=before]{box-shadow:inset 2px 0 0 var(--dsw-alias-state-business-primary)}
.dsh-tab-pagebar__tab[data-drop=after]{box-shadow:inset -2px 0 0 var(--dsw-alias-state-business-primary)}
/* 左上角小角标：所属工作区（短名，悬停看全名） */
.dsh-tab-pagebar__badge{position:absolute;left:5px;top:-5px;box-sizing:border-box;max-width:50%;height:10px;
  padding:0 3px;border-radius:3px;color:#fff;font-size:8.5px;font-weight:600;line-height:10px;letter-spacing:.01em;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;pointer-events:none;opacity:.96}
/* 激活标签更高，角标随之内收，避免顶到窗口最上沿（两种状态在屏幕上几乎同一高度） */
.dsh-tab-pagebar__tab[aria-selected=true] .dsh-tab-pagebar__badge{top:1px}
.dsh-tab-pagebar__tab[data-pinned=true] .dsh-tab-pagebar__badge{left:2px;max-width:38px;padding:0 1px;font-size:7.5px}
.dsh-tab-pagebar__icon{position:relative;flex:none;width:16px;height:16px;display:grid;place-items:center;
  color:var(--dsw-alias-label-tertiary)}
.dsh-tab-pagebar__tab[aria-selected=true] .dsh-tab-pagebar__icon{color:var(--dsw-alias-label-secondary)}
.dsh-tab-pagebar__label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-tab-pagebar__dot{flex:none;width:6px;height:6px;border-radius:50%}
.dsh-tab-pagebar__dot[data-signal=running]{background:var(--dsw-alias-state-business-primary);
  animation:dsh-tab-pulse 1.6s ease-in-out infinite}
.dsh-tab-pagebar__dot[data-signal=pending]{background:var(--dsw-alias-state-warn-primary)}
.dsh-tab-pagebar__dot[data-signal=unread]{background:var(--dsw-alias-state-success-primary)}
.dsh-tab-pagebar__close{flex:none;width:18px;height:18px;display:grid;place-items:center;padding:0;
  border:none;border-radius:5px;background:transparent;color:inherit;cursor:pointer;-webkit-app-region:no-drag;
  opacity:0;pointer-events:none;transition:opacity .1s ease,background-color .1s ease}
.dsh-tab-pagebar__tab:hover .dsh-tab-pagebar__close,
.dsh-tab-pagebar__tab[aria-selected=true] .dsh-tab-pagebar__close,
.dsh-tab-pagebar__tab:focus-within .dsh-tab-pagebar__close{opacity:1;pointer-events:auto}
.dsh-tab-pagebar__close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-tab-pagebar__close:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-tab-pagebar__new{flex:none;align-self:center;width:30px;height:30px;display:grid;place-items:center;padding:0;
  margin-left:6px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;
  color:var(--dsw-alias-label-secondary);cursor:pointer;-webkit-app-region:no-drag;
  transition:background-color .12s ease,color .12s ease}
.dsh-tab-pagebar__new:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-tab-pagebar__new:focus-visible{outline:1.5px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
/* 右键菜单 */
.dsh-tab-menu{position:fixed;z-index:100;box-sizing:border-box;min-width:188px;max-width:260px;padding:5px;
  border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);
  background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-shadow-lv2);
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;
  -webkit-app-region:no-drag;user-select:none;-webkit-user-select:none}
.dsh-tab-menu__item{display:flex;align-items:center;width:100%;height:30px;padding:0 8px;border:none;border-radius:6px;
  background:transparent;color:inherit;font:inherit;text-align:left;white-space:nowrap;cursor:pointer}
.dsh-tab-menu__item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dsh-tab-menu__item:disabled{color:var(--dsw-alias-label-dimmed);cursor:default;background:transparent}
.dsh-tab-menu__item[data-danger=true]:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);
  color:var(--dsw-alias-state-error-primary)}
.dsh-tab-menu__sep{height:.5px;margin:4px 6px;background:var(--dsw-alias-border-l2)}
.dsh-tab-menu__hint{padding:4px 8px 6px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;
  white-space:normal}
@keyframes dsh-tab-pulse{0%,100%{opacity:1}50%{opacity:.35}}
@keyframes dsh-tab-enter{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.dsh-tab-pagebar__dot[data-signal=running]{animation:none}}
@media (prefers-reduced-motion:reduce){
  .dsh-tab-pagebar__tab,.dsh-tab-pagebar__new,.dsh-tab-pagebar__close{transition:none;animation:none}
}
`

    // ── 图标（16px 线性图标，currentColor 跟随主题） ─────────────────────────
    function svg(children) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        children,
      )
    }
    function IconConversation() {
      return svg(
        h('path', {
          d: 'M13.2 8c0 2.6-2.3 4.7-5.2 4.7-.6 0-1.2-.1-1.8-.3L3.5 13.2l.7-2c-.9-.8-1.4-2-1.4-3.2C2.8 5.4 5.1 3.3 8 3.3s5.2 2.1 5.2 4.7Z',
        }),
      )
    }
    function IconCompass() {
      return svg([
        h('circle', { key: 'c', cx: 8, cy: 8, r: 5.4 }),
        h('path', { key: 'n', d: 'M9.9 6.1 8.7 8.7 6.1 9.9l1.2-2.6 2.6-1.2Z' }),
      ])
    }
    function IconPlus() {
      return svg(h('path', { d: 'M8 3.2v9.6M3.2 8h9.6' }))
    }
    function IconClose() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 12,
          height: 12,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('path', { d: 'M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6' }),
      )
    }

    // ── 持久化（视图态，不进会话日志） ───────────────────────────────────────
    function sanitizeIds(value) {
      if (!Array.isArray(value)) return []
      const seen = new Set()
      const ids = []
      for (const item of value) {
        if (typeof item !== 'string' || item.length === 0 || seen.has(item)) continue
        seen.add(item)
        ids.push(item)
      }
      return ids
    }

    function readStoredState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (raw !== null) {
          const value = JSON.parse(raw)
          if (value !== null && typeof value === 'object') {
            const ids = sanitizeIds(value.tabs)
            const pinned = sanitizeIds(value.pinned).filter((id) => ids.includes(id))
            return { ids, pinned }
          }
        }
        const legacy = localStorage.getItem(LEGACY_STORAGE_KEY)
        if (legacy !== null) return { ids: sanitizeIds(JSON.parse(legacy)), pinned: [] }
      } catch (error) {
        /* 存储不可用 / 内容损坏：从空列表开始，标签页只是视图态 */
      }
      return { ids: [], pinned: [] }
    }

    function createTabStore() {
      const stored = readStoredState()
      let ids = stored.ids
      let pinned = stored.pinned
      const suppressed = new Set()
      let snapshot = Object.freeze({ ids: Object.freeze(ids.slice()), pinned: Object.freeze(pinned.slice()) })
      const listeners = new Set()
      const publish = () => {
        snapshot = Object.freeze({ ids: Object.freeze(ids.slice()), pinned: Object.freeze(pinned.slice()) })
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify({ tabs: ids, pinned }))
          localStorage.removeItem(LEGACY_STORAGE_KEY)
        } catch (error) {
          /* 无痕模式 / 存储禁用：标签页只是视图态，存不进不影响会话数据 */
        }
        for (const listener of [...listeners]) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot() {
          return snapshot
        },
        has(id) {
          return ids.includes(id)
        },
        add(id) {
          if (ids.includes(id)) return
          ids = [...ids, id]
          publish()
        },
        pin(id) {
          if (!ids.includes(id) || pinned.includes(id)) return
          pinned = [...pinned, id]
          publish()
        },
        unpin(id) {
          if (!pinned.includes(id)) return
          pinned = pinned.filter((item) => item !== id)
          publish()
        },
        removeMany(removed) {
          const drop = new Set(removed)
          if (drop.size === 0) return
          ids = ids.filter((item) => !drop.has(item))
          pinned = pinned.filter((item) => !drop.has(item))
          publish()
        },
        /** 固定分组内拖动排序（referenceId 目标标签，place 表示放在它前/后）。 */
        movePinned(id, referenceId, place) {
          if (!pinned.includes(id) || !pinned.includes(referenceId) || id === referenceId) return
          const next = pinned.filter((item) => item !== id)
          const referenceIndex = next.indexOf(referenceId)
          if (referenceIndex < 0) return
          next.splice(place === 'after' ? referenceIndex + 1 : referenceIndex, 0, id)
          pinned = next
          publish()
        },
        /** 未固定分组内拖动排序（显示顺序就是 ids 顺序）。 */
        moveUnpinned(id, referenceId, place) {
          if (!ids.includes(id) || id === referenceId) return
          const next = ids.filter((item) => item !== id)
          const referenceIndex = next.indexOf(referenceId)
          if (referenceIndex < 0) return
          next.splice(place === 'after' ? referenceIndex + 1 : referenceIndex, 0, id)
          ids = next
          publish()
        },
        /** 主动关掉的标签不要再被「当前会话自动入签」立刻加回来。 */
        suppress(id) {
          suppressed.add(id)
        },
        isSuppressed(id) {
          return suppressed.has(id)
        },
        unsuppress(id) {
          suppressed.delete(id)
        },
        pruneSuppressed(keepId) {
          for (const id of suppressed) if (id !== keepId) suppressed.delete(id)
        },
      }
    }

    // ── 官方会话目录里读「当前会话」 ─────────────────────────────────────────
    function currentSessionIdOf(catalog) {
      if (catalog === undefined || catalog === null) return undefined
      const rows = catalog.byId ?? {}
      for (const id of catalog.ids ?? []) {
        const row = rows[id]
        if (row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) return id
      }
      return undefined
    }

    function sessionStatusSignal(status) {
      if (status === undefined || status === null) return undefined
      if (status.pendingInteraction !== undefined && status.pendingInteraction !== null) return 'pending'
      if (status.running === true) return 'running'
      if (status.completionUnread === true) return 'unread'
      return undefined
    }

    /** 路径最后一段（兼容 / 与 \\）。 */
    function basenameOf(path) {
      if (typeof path !== 'string') return ''
      const parts = path.split(/[\\/]/).filter((part) => part.length > 0)
      return parts.length === 0 ? '' : parts[parts.length - 1]
    }

    /** 工作区名 → 角标颜色（固定色相，同一工作区在任何主题下颜色一致）。 */
    function workspaceHue(key) {
      let hash = 0
      for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) % 360
      return hash
    }

    function errorMessageOf(error) {
      if (error === undefined || error === null) return ''
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message.length > 0) return error.message
      return String(error)
    }

    /**
     * 显示顺序：固定标签在最左（按固定顺序），其余按打开顺序。
     * 切换标签不改变顺序；激活标签只是变宽、和下面的会话页连成一张纸。
     */
    function displayTabs(snapshot) {
      const pinnedSet = new Set(snapshot.pinned)
      const pinnedTabs = snapshot.pinned
        .filter((id) => snapshot.ids.includes(id))
        .map((id) => ({ id, pinned: true }))
      const rest = snapshot.ids.filter((id) => !pinnedSet.has(id)).map((id) => ({ id, pinned: false }))
      return [...pinnedTabs, ...rest]
    }

    // ── 单个标签页 ──────────────────────────────────────────────────────────
    function TabItem(props) {
      const { id, title, active, signal, blank, pinned, badge, drop, dragging, t, onSelect, onClose, onMenu, onArrow, onDragStart } = props
      const statusLabel =
        signal === 'running' ? t('tab.running') : signal === 'pending' ? t('tab.pending') : signal === 'unread' ? t('tab.unread') : undefined
      return h(
        'div',
        {
          className: 'dsh-tab-pagebar__tab',
          role: 'tab',
          tabIndex: active ? 0 : -1,
          'aria-selected': active,
          'data-session-id': id,
          'data-pinned': pinned ? 'true' : 'false',
          'data-dragging': dragging ? 'true' : 'false',
          'data-drop': drop === null || drop === undefined ? undefined : drop,
          title: pinned ? `${title} · ${t('tab.pinned')}` : title,
          onClick: () => onSelect(id),
          onPointerDown: (event) => {
            if (event.button !== 0) return
            const target = event.target
            if (target !== null && typeof target.closest === 'function' && target.closest('.dsh-tab-pagebar__close') !== null) return
            onDragStart(event)
          },
          onContextMenu: (event) => onMenu(event, id),
          onAuxClick: (event) => {
            if (event.button === 1) {
              event.preventDefault()
              onClose(id)
            }
          },
          onKeyDown: (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onSelect(id)
              return
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault()
              onArrow(id, 1)
              return
            }
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              onArrow(id, -1)
            }
          },
        },
        badge === null || badge === undefined
          ? null
          : h(
              'span',
              {
                key: 'badge',
                className: 'dsh-tab-pagebar__badge',
                style: { backgroundColor: `hsl(${badge.hue} 46% 38%)` },
                title: t('tab.workspace', { name: badge.label }),
                'aria-hidden': 'true',
              },
              badge.label,
            ),
        h('span', { className: 'dsh-tab-pagebar__icon' }, blank ? h(IconCompass) : h(IconConversation)),
        h('span', { className: 'dsh-tab-pagebar__label' }, title),
        signal !== undefined
          ? h('span', {
              key: 'dot',
              className: 'dsh-tab-pagebar__dot',
              'data-signal': signal,
              role: 'img',
              'aria-label': statusLabel,
              title: statusLabel,
            })
          : null,
        pinned
          ? null
          : h(
              'button',
              {
                type: 'button',
                tabIndex: -1,
                className: 'dsh-tab-pagebar__close',
                title: t('tab.close', { title }),
                'aria-label': t('tab.close', { title }),
                onClick: (event) => {
                  event.stopPropagation()
                  onClose(id)
                },
                onContextMenu: (event) => {
                  event.preventDefault()
                  onMenu(event, id)
                },
                onKeyDown: (event) => {
                  event.stopPropagation()
                },
              },
              h(IconClose),
            ),
      )
    }

    // ── 右键菜单 ────────────────────────────────────────────────────────────
    function TabMenu(props) {
      const { x, y, hint, items, onClose } = props
      const menuRef = useRef(null)
      const [position, setPosition] = useState({ x, y })

      // 打开后按实际尺寸夹到窗口内，避免菜单跑出屏幕
      useLayoutEffect(() => {
        const element = menuRef.current
        if (element === null) return
        const rect = element.getBoundingClientRect()
        const nextX = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
        const nextY = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
        if (nextX !== position.x || nextY !== position.y) setPosition({ x: nextX, y: nextY })
      }, [x, y, hint, items.length])

      useEffect(() => {
        const onPointerDown = (event) => {
          if (menuRef.current !== null && menuRef.current.contains(event.target)) return
          onClose()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
        }
        const onDismiss = () => onClose()
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        window.addEventListener('scroll', onDismiss, true)
        window.addEventListener('resize', onDismiss)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
          window.removeEventListener('scroll', onDismiss, true)
          window.removeEventListener('resize', onDismiss)
        }
      }, [onClose])

      return h(
        'div',
        {
          ref: menuRef,
          className: 'dsh-tab-menu',
          role: 'menu',
          style: { left: `${position.x}px`, top: `${position.y}px` },
          onContextMenu: (event) => event.preventDefault(),
        },
        hint === undefined || hint === null ? null : h('div', { key: 'hint', className: 'dsh-tab-menu__hint' }, hint),
        items.map((item) =>
          item.separator === true
            ? h('div', { key: item.key, className: 'dsh-tab-menu__sep', role: 'separator' })
            : h(
                'button',
                {
                  key: item.key,
                  type: 'button',
                  role: 'menuitem',
                  className: 'dsh-tab-menu__item',
                  disabled: item.disabled === true,
                  'data-danger': item.danger === true ? 'true' : 'false',
                  onClick: () => item.run(),
                },
                item.label,
              ),
        ),
      )
    }

    // ── 标签栏 ──────────────────────────────────────────────────────────────
    function createTabBar(actions) {
      return function TabBar(props) {
        const { useSessions, useSessionStatus, useWorkspaces, t } = props
        const catalog = useSessions((state) => state)
        const statuses = useSessionStatus((state) => state)
        const workspaces = useWorkspaces((state) => state)
        const snapshot = useSyncExternalStore(actions.store.subscribe, actions.store.getSnapshot)
        const [menu, setMenu] = useState(null)

        const rows = catalog?.byId ?? {}
        const archived = useMemo(() => new Set(workspaces?.archivedSessionIds ?? []), [workspaces])
        const activeId = currentSessionIdOf(catalog)

        // 会话 → 所属工作区（角标用）。工作区标题为空时用目录名，再退到 workspaceId。
        const workspaceBadges = useMemo(() => {
          const map = new Map()
          for (const item of workspaces?.items ?? []) {
            const title = typeof item.title === 'string' && item.title.trim().length > 0 ? item.title.trim() : ''
            const label = title || basenameOf(item.path) || (item.workspaceId === undefined ? '' : String(item.workspaceId))
            if (label.length === 0) continue
            const hue = workspaceHue(item.workspaceId === undefined ? label : String(item.workspaceId))
            for (const sessionId of item.sessionIds ?? []) if (!map.has(sessionId)) map.set(sessionId, { label, hue })
          }
          return map
        }, [workspaces])

        // 点标签时先把视觉上的「激活」切过去跑动画，等动画结束再真正切会话。
        // 官方切会话会同步重渲染整个会话页（实测一次约 60–75ms 长任务），
        // 和标签动画同时发生会直接把动画顶卡；拆开之后两段各自流畅。
        const [pendingSelect, setPendingSelect] = useState(null)
        const pendingRef = useRef(null)
        const pendingTimerRef = useRef(null)
        useEffect(() => {
          pendingRef.current = pendingSelect
        }, [pendingSelect])
        const clearPendingSelect = useCallback(() => {
          if (pendingTimerRef.current !== null) {
            clearTimeout(pendingTimerRef.current)
            pendingTimerRef.current = null
          }
          setPendingSelect(null)
        }, [])

        // 当前会话自动入签（官方侧栏点开会话、启动恢复、新建会话都走这里）
        useEffect(() => {
          actions.store.pruneSuppressed(activeId)
          if (activeId === undefined) return
          if (actions.store.isSuppressed(activeId)) return
          if (rows[activeId] === undefined) return
          if (!actions.store.has(activeId)) actions.store.add(activeId)
        }, [activeId, catalog])

        // 会话被删除 / 归档后摘签
        useEffect(() => {
          if (catalog?.phase !== 'ready') return
          const stale = actions.store.getSnapshot().ids.filter((id) => rows[id] === undefined || archived.has(id))
          if (stale.length > 0) actions.store.removeMany(stale)
        }, [catalog, archived])

        const tabs = displayTabs(snapshot).filter((tab) => rows[tab.id] !== undefined && !archived.has(tab.id))
        const pinnedCount = tabs.filter((tab) => tab.pinned).length
        const visualActiveId = pendingSelect === null ? activeId : pendingSelect.id
        const stripRef = useRef(null)
        const barRef = useRef(null)

        const requestSelect = useCallback(
          (id) => {
            if (id === visualActiveId) return
            const reduceMotion =
              typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
            if (reduceMotion) {
              clearPendingSelect()
              actions.select(id)
              return
            }
            if (pendingTimerRef.current !== null) {
              clearTimeout(pendingTimerRef.current)
              pendingTimerRef.current = null
            }
            setPendingSelect({ id, fromId: activeId })
            pendingTimerRef.current = setTimeout(() => {
              pendingTimerRef.current = null
              const pending = pendingRef.current
              if (pending === null || pending.id !== id) return
              if (!actions.store.has(id)) {
                setPendingSelect(null)
                return
              }
              actions.select(id)
              setPendingSelect(null)
            }, SELECT_COMMIT_DELAY)
          },
          [activeId, visualActiveId, actions, clearPendingSelect],
        )

        // ── 拖拽排序 ────────────────────────────────────────────────────────
        const [dragState, setDragState] = useState(null)
        const dragRef = useRef(null)
        const dragCleanupRef = useRef(null)
        const selectGuardRef = useRef(0)
        useEffect(
          () => () => {
            if (dragCleanupRef.current !== null) dragCleanupRef.current()
          },
          [],
        )
        const onTabSelect = useCallback(
          (id) => {
            if (performance.now() < selectGuardRef.current) return
            requestSelect(id)
          },
          [requestSelect],
        )
        const beginDrag = (event, id, pinned) => {
          if (event.button !== 0 || dragCleanupRef.current !== null) return
          const strip = stripRef.current
          if (strip === null) return
          const candidates = tabs
            .filter((tab) => tab.pinned === pinned)
            .map((tab) => {
              const element = strip.querySelector(`[data-session-id="${tab.id}"]`)
              if (element === null) return null
              const rect = element.getBoundingClientRect()
              return { id: tab.id, mid: rect.left + rect.width / 2 }
            })
            .filter((candidate) => candidate !== null)
          if (candidates.length < 2) return
          dragRef.current = { id, pinned, startX: event.clientX, moved: false, candidates, drop: null }
          const stop = () => {
            if (dragCleanupRef.current !== stop) return
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp, true)
            window.removeEventListener('pointercancel', onCancel, true)
            window.removeEventListener('blur', onCancel)
            document.removeEventListener('keydown', onKeyDown, true)
            dragCleanupRef.current = null
          }
          const onCancel = () => {
            stop()
            dragRef.current = null
            setDragState(null)
          }
          const onKeyDown = (keyEvent) => {
            if (keyEvent.key === 'Escape') {
              keyEvent.preventDefault()
              onCancel()
            }
          }
          const onMove = (moveEvent) => {
            const drag = dragRef.current
            if (drag === null) return
            if (!drag.moved) {
              if (Math.abs(moveEvent.clientX - drag.startX) < 5) return
              drag.moved = true
              selectGuardRef.current = performance.now() + 500
            }
            if (moveEvent.cancelable) moveEvent.preventDefault()
            const remaining = drag.candidates.filter((candidate) => candidate.id !== drag.id)
            if (remaining.length === 0) return
            const insertIndex = remaining.findIndex((candidate) => moveEvent.clientX < candidate.mid)
            const reference = insertIndex < 0 ? remaining[remaining.length - 1] : remaining[insertIndex]
            const place = insertIndex < 0 ? 'after' : 'before'
            const previous = drag.drop
            if (previous === null || previous.referenceId !== reference.id || previous.place !== place) {
              drag.drop = { referenceId: reference.id, place }
              setDragState({ id: drag.id, referenceId: reference.id, place })
            }
          }
          const onUp = () => {
            const drag = dragRef.current
            stop()
            dragRef.current = null
            setDragState(null)
            if (drag === null || !drag.moved || drag.drop === null) return
            try {
              if (drag.pinned) actions.store.movePinned(drag.id, drag.drop.referenceId, drag.drop.place)
              else actions.store.moveUnpinned(drag.id, drag.drop.referenceId, drag.drop.place)
            } catch (error) {
              console.error('dsh-tab: reordering tabs failed', error)
            }
          }
          dragCleanupRef.current = stop
          window.addEventListener('pointermove', onMove, { passive: false })
          window.addEventListener('pointerup', onUp, true)
          window.addEventListener('pointercancel', onCancel, true)
          window.addEventListener('blur', onCancel)
          document.addEventListener('keydown', onKeyDown, true)
        }

        // 外部导航（侧栏点会话 / 新建会话 / 关闭后自动落位）打断待切换
        useEffect(() => {
          if (pendingSelect === null) return
          if (activeId === pendingSelect.id) return
          if (activeId !== pendingSelect.fromId) clearPendingSelect()
        }, [activeId, pendingSelect, clearPendingSelect])

        useEffect(
          () => () => {
            if (pendingTimerRef.current !== null) clearTimeout(pendingTimerRef.current)
          },
          [],
        )

        // 当前标签滚入可见范围（只滚标签条自身，不滚页面）；切换标签时平滑滚动，
        // 标签条因侧栏拖动变宽变窄时直接对齐。
        useEffect(() => {
          const strip = stripRef.current
          if (strip === null) return undefined
          const reduceMotion =
            typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
          const revealActive = (smooth) => {
            const active = strip.querySelector('[aria-selected="true"]')
            if (active === null) return
            const left = active.offsetLeft
            const right = left + active.offsetWidth
            let target = strip.scrollLeft
            if (left < strip.scrollLeft) target = Math.max(0, left - 8)
            else if (right > strip.scrollLeft + strip.clientWidth) target = right - strip.clientWidth + 8
            if (Math.abs(target - strip.scrollLeft) < 1) return
            if (!smooth || reduceMotion || typeof strip.scrollTo !== 'function') strip.scrollLeft = target
            else strip.scrollTo({ left: target, behavior: 'smooth' })
          }
          revealActive(true)
          if (typeof ResizeObserver !== 'function') return undefined
          const observer = new ResizeObserver(() => revealActive(false))
          observer.observe(strip)
          return () => observer.disconnect()
        }, [visualActiveId, tabs.length])

        // 标签栏在 shell.overlay 里绝对定位：左边缘跟住左栏宽度（左栏折叠时为 0，
        // 桌面端折叠侧栏时由 CSS 的 clearance 变量继续右移，避开窗口按钮）
        useEffect(() => {
          const bar = barRef.current
          const overlay = bar === null ? null : bar.closest('[data-shell-overlay]')
          const frame = overlay === null ? null : overlay.parentElement
          if (frame === null) return undefined
          let sidebarCol = null
          const resolveSidebarCol = () => {
            const sidebarSlot = document.querySelector('[data-slot="sidebar"]')
            if (sidebarSlot === null) return null
            return [...frame.children].find((el) => el.contains(sidebarSlot)) ?? null
          }
          const sync = () => {
            if (sidebarCol !== null && !sidebarCol.isConnected) sidebarCol = null
            if (sidebarCol === null) {
              sidebarCol = resolveSidebarCol()
              if (sidebarCol !== null && observer !== undefined) observer.observe(sidebarCol)
            }
            const width = sidebarCol === null ? 0 : sidebarCol.getBoundingClientRect().width
            bar.style.setProperty('--dsh-tab-left', `${Math.round(width)}px`)
          }
          let observer
          if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(sync)
            observer.observe(frame)
          }
          sidebarCol = resolveSidebarCol()
          if (sidebarCol !== null && observer !== undefined) observer.observe(sidebarCol)
          sync()
          // 座位可能比 sidebar 晚挂载：补几次重试，避免左缘永远算成 0
          const retryTimers = [100, 500, 1500].map((delay) => setTimeout(sync, delay))
          return () => {
            for (const timer of retryTimers) clearTimeout(timer)
            if (observer !== undefined) observer.disconnect()
          }
        }, [])

        // 菜单指向的标签被关掉 / 归档后自动收起
        useEffect(() => {
          if (menu === null) return
          if (!tabs.some((tab) => tab.id === menu.tabId)) setMenu(null)
        }, [menu, tabs])

        const dismissMenu = useCallback(() => setMenu(null), [])
        const openMenu = useCallback((event, tabId) => {
          event.preventDefault()
          event.stopPropagation()
          setMenu({ x: event.clientX, y: event.clientY, tabId, step: 'list', error: undefined })
        }, [])

        const menuTabIndex = menu === null ? -1 : tabs.findIndex((tab) => tab.id === menu.tabId)
        const menuTab = menuTabIndex < 0 ? undefined : tabs[menuTabIndex]

        const runMenu = (fn) => () => {
          dismissMenu()
          fn()
        }

        const startArchive = (stopActivity) => {
          if (menu === null) return
          const tabId = menu.tabId
          setMenu((current) => (current === null ? current : { ...current, step: 'busy', error: undefined }))
          actions.archive(tabId, stopActivity).then((result) => {
            if (result.ok) {
              setMenu((current) => (current !== null && current.tabId === tabId ? null : current))
              return
            }
            setMenu((current) =>
              current !== null && current.tabId === tabId ? { ...current, step: 'error', error: result.message } : current,
            )
          })
        }

        // 方向键在标签之间移动并激活（自动激活式 tablist）。
        // 切换会话后官方会把焦点交给输入框，所以这里延后一两帧把焦点抢回标签。
        const focusRelative = (id, direction) => {
          if (tabs.length < 2) return
          const index = tabs.findIndex((tab) => tab.id === id)
          if (index < 0) return
          const target = tabs[(index + direction + tabs.length) % tabs.length]
          if (target === undefined) return
          requestSelect(target.id)
          const focusTarget = () => {
            const strip = stripRef.current
            if (strip === null) return
            const element = strip.querySelector(`[data-session-id="${target.id}"]`)
            if (element !== null && typeof element.focus === 'function') element.focus({ preventScroll: true })
          }
          focusTarget()
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
              focusTarget()
              setTimeout(focusTarget, 60)
            })
          }
        }

        let menuHint
        let menuItems = []
        if (menu !== null) {
          if (menu.step === 'busy') {
            menuHint = t('menu.archiveBusy')
          } else if (menu.step === 'error') {
            menuHint = t('menu.archiveFailed', { message: menu.error ?? '' })
            menuItems = [
              { key: 'retry-stop', label: t('menu.retryStop'), danger: true, run: () => startArchive(true) },
              { key: 'cancel', label: t('menu.cancel'), run: dismissMenu },
            ]
          } else if (menu.step === 'archive-confirm') {
            menuHint = t('menu.archiveRunning')
            menuItems = [
              { key: 'archive-stop', label: t('menu.archiveStop'), danger: true, run: () => startArchive(true) },
              { key: 'cancel', label: t('menu.cancel'), run: dismissMenu },
            ]
          } else if (menuTab !== undefined) {
            const rightCount = tabs.length - menuTabIndex - 1
            const otherCount = tabs.filter((tab) => tab.id !== menuTab.id && !tab.pinned).length
            menuItems = [
              { key: 'close', label: t('menu.close'), run: runMenu(() => actions.closeOne(menuTab.id)) },
              {
                key: 'close-right',
                label: t('menu.closeRight'),
                disabled: rightCount === 0,
                run: runMenu(() => actions.closeRight(menuTab.id)),
              },
              {
                key: 'close-others',
                label: t('menu.closeOthers'),
                disabled: otherCount === 0,
                run: runMenu(() => actions.closeOthers(menuTab.id)),
              },
              { key: 'sep-1', separator: true },
              { key: 'close-all', label: t('menu.closeAll'), run: runMenu(() => actions.closeAll()) },
              { key: 'sep-2', separator: true },
              menuTab.pinned
                ? { key: 'unpin', label: t('menu.unpin'), run: runMenu(() => actions.unpin(menuTab.id)) }
                : { key: 'pin', label: t('menu.pin'), run: runMenu(() => actions.pin(menuTab.id)) },
              { key: 'sep-3', separator: true },
              {
                key: 'archive',
                label: t('menu.archive'),
                danger: true,
                run: runMenu(() => {
                  const status = statuses?.get(menuTab.id)
                  const busy =
                    status?.running === true ||
                    (status?.pendingInteraction !== undefined && status?.pendingInteraction !== null)
                  if (busy) setMenu({ x: menu.x, y: menu.y, tabId: menuTab.id, step: 'archive-confirm', error: undefined })
                  else startArchive(false)
                }),
              },
            ]
          }
        }

        return h(
          React.Fragment,
          null,
          h(
            'div',
            {
              ref: barRef,
              className: 'dsh-tab-pagebar',
              'data-dsh-tab-bar': '',
              'data-tabs': String(tabs.length),
              'data-empty': tabs.length === 0 ? 'true' : 'false',
              'data-window-drag': '',
            },
            h('style', { key: 'style' }, CSS),
            h(
              'div',
              {
                key: 'strip',
                ref: stripRef,
                className: 'dsh-tab-pagebar__strip',
                role: 'tablist',
                'aria-label': t('tab.list'),
              },
              tabs.flatMap((tab, index) => {
                const row = rows[tab.id]
                const knownBadge = workspaceBadges.get(tab.id)
                const cwdLabel = basenameOf(row?.cwd)
                const badge = knownBadge ?? (cwdLabel.length === 0 ? null : { label: cwdLabel, hue: workspaceHue(cwdLabel) })
                const node = h(TabItem, {
                  key: tab.id,
                  id: tab.id,
                  active: tab.id === visualActiveId,
                  blank: row?.blank === true,
                  pinned: tab.pinned,
                  badge,
                  dragging: dragState !== null && dragState.id === tab.id,
                  drop: dragState !== null && dragState.referenceId === tab.id ? dragState.place : null,
                  title: row?.blank === true ? t('tab.newSession') : row?.displayTitle || row?.title || t('tab.untitled'),
                  signal: sessionStatusSignal(statuses?.get(tab.id)),
                  t,
                  onSelect: onTabSelect,
                  onClose: actions.closeOne,
                  onMenu: openMenu,
                  onArrow: focusRelative,
                  onDragStart: (event) => beginDrag(event, tab.id, tab.pinned),
                })
                const isLastPinned = tab.pinned && index === pinnedCount - 1 && tabs.length > pinnedCount
                return isLastPinned
                  ? [node, h('span', { key: 'divider', className: 'dsh-tab-pagebar__divider', 'aria-hidden': true })]
                  : [node]
              }),
            ),
            h(
              'button',
              {
                key: 'new',
                type: 'button',
                className: 'dsh-tab-pagebar__new',
                title: t('tab.new'),
                'aria-label': t('tab.new'),
                onClick: actions.create,
              },
              h(IconPlus),
            ),
          ),
          menu === null
            ? null
            : h(TabMenu, {
                key: 'menu',
                x: menu.x,
                y: menu.y,
                hint: menuHint,
                items: menuItems,
                onClose: dismissMenu,
              }),
        )
      }
    }

    // ── 插件入口 ────────────────────────────────────────────────────────────
    return {
      inject: ['slots', 'locale', 'sessions', 'uiWorkspace', 'workspaces'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-tab: dictionaries')

        // 帧布局样式：让 shell.bottom 这行排到三栏上方、横跨会话列 + 右栏列
        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-tab'
          style.dataset.pluginCss = 'dsh-tab/frame.css'
          style.textContent = FRAME_CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'dsh-tab: frame layout')

        const sessions = ctx.sessions
        const uiWorkspace = ctx.uiWorkspace
        const store = createTabStore()

        /** 当前显示顺序（与渲染层同一套过滤规则，供关闭操作计算左右邻位）。 */
        const tabsNow = () => {
          const catalog = sessions.list.getSnapshot()
          const rows = catalog?.byId ?? {}
          const archived = new Set(ctx.workspaces.list.getSnapshot().archivedSessionIds ?? [])
          return displayTabs(store.getSnapshot()).filter((tab) => rows[tab.id] !== undefined && !archived.has(tab.id))
        }

        // 关掉当前标签后 official 「新建会话」会复用空白会话，导航完成时当前会话可能不变，
        // 这种情形下补一次「当前会话入签」，避免标签栏空着。
        const ensureTimers = new Set()
        ctx.effect(
          () => () => {
            for (const timer of ensureTimers) clearTimeout(timer)
            ensureTimers.clear()
          },
          'dsh-tab: settle timers',
        )
        const scheduleEnsureCurrentTab = (closedCurrent) => {
          for (const delay of [500, 1500]) {
            const timer = setTimeout(() => {
              ensureTimers.delete(timer)
              try {
                const current = currentSessionIdOf(sessions.list.getSnapshot())
                if (current === undefined) return
                // 导航还没完成时当前会话仍是刚被关掉的旧会话：不要把它加回来
                if (current === closedCurrent) return
                store.unsuppress(current)
                if (!store.has(current)) store.add(current)
              } catch (error) {
                console.error('dsh-tab: settling current tab failed', error)
              }
            }, delay)
            ensureTimers.add(timer)
          }
        }

        /** 关掉一批标签；当前会话在被关列表里时按 nextId / 首个剩余标签 / 新建会话的次序落位。 */
        const closeIds = (idsToClose, nextId) => {
          if (idsToClose.length === 0) return
          const catalog = sessions.list.getSnapshot()
          const current = currentSessionIdOf(catalog)
          const currentRow = current === undefined ? undefined : catalog?.byId?.[current]
          const allTabs = displayTabs(store.getSnapshot())
          const closingAll = allTabs.every((tab) => idsToClose.includes(tab.id))
          // 全关但当前就是一个空白「新会话」：官方「新建会话」只会把同一个空白会话再打开，
          // 所以直接保留它当新的新会话页，避免标签栏空着或导航竞态把旧标签加回来。
          if (closingAll && current !== undefined && idsToClose.includes(current) && currentRow?.blank === true) {
            const others = idsToClose.filter((id) => id !== current)
            for (const id of others) store.suppress(id)
            store.removeMany(others)
            return
          }
          for (const id of idsToClose) store.suppress(id)
          store.removeMany(idsToClose)
          if (current === undefined || !idsToClose.includes(current)) return
          if (nextId !== undefined && store.has(nextId) && nextId !== current) {
            uiWorkspace.openSession(nextId)
            return
          }
          const remaining = tabsNow()
          if (remaining.length > 0) uiWorkspace.openSession(remaining[0].id)
          else {
            uiWorkspace.startSession()
            scheduleEnsureCurrentTab(current)
          }
        }

        const actions = {
          store,
          select(id) {
            try {
              const current = currentSessionIdOf(sessions.list.getSnapshot())
              if (current === id) return
              uiWorkspace.openSession(id)
            } catch (error) {
              console.error('dsh-tab: switching conversation failed', error)
            }
          },
          closeOne(id) {
            try {
              const tabs = tabsNow()
              const index = tabs.findIndex((tab) => tab.id === id)
              const next = tabs[index + 1]?.id ?? tabs[index - 1]?.id
              closeIds([id], next)
            } catch (error) {
              console.error('dsh-tab: closing tab failed', error)
            }
          },
          closeRight(id) {
            try {
              const tabs = tabsNow()
              const index = tabs.findIndex((tab) => tab.id === id)
              if (index < 0) return
              closeIds(
                tabs.slice(index + 1).map((tab) => tab.id),
                id,
              )
            } catch (error) {
              console.error('dsh-tab: closing tabs to the right failed', error)
            }
          },
          closeOthers(id) {
            try {
              const closing = tabsNow().filter((tab) => tab.id !== id && !tab.pinned).map((tab) => tab.id)
              closeIds(closing, id)
            } catch (error) {
              console.error('dsh-tab: closing other tabs failed', error)
            }
          },
          closeAll() {
            try {
              const all = store.getSnapshot().ids
              closeIds(all, undefined)
            } catch (error) {
              console.error('dsh-tab: closing all tabs failed', error)
            }
          },
          pin(id) {
            store.pin(id)
          },
          unpin(id) {
            store.unpin(id)
          },
          archive(sessionId, stopActivity) {
            return uiWorkspace
              .archiveSession(sessionId, stopActivity === true ? { stopActivity: true } : undefined)
              .then(() => {
                store.suppress(sessionId)
                store.removeMany([sessionId])
                return { ok: true }
              })
              .catch((error) => {
                console.error('dsh-tab: archiving conversation failed', error)
                return { ok: false, message: errorMessageOf(error) }
              })
          },
          create() {
            try {
              uiWorkspace.startSession()
            } catch (error) {
              console.error('dsh-tab: creating conversation failed', error)
            }
          },
        }

        const TabBar = createTabBar(actions)
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'dsh-tab-bar',
              order: -100,
              locale: NS,
            },
            TabBar,
          ),
        )
      },
    }
  },
})

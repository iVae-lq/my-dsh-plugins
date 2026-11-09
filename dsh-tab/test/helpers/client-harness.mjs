import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../../client.js', import.meta.url), 'utf8')

/** vm 上下文里造出来的对象原型不同，断言前先过一遍 JSON。 */
export const plain = (value) => JSON.parse(JSON.stringify(value ?? null))

function walk(tree, visit) {
  if (Array.isArray(tree)) {
    for (const item of tree) walk(item, visit)
    return
  }
  if (tree === null || typeof tree !== 'object') return
  visit(tree)
  walk(tree.props?.children, visit)
}

/**
 * 跑真实的 client.js（不改一行），用一个很小的 hook 宿主渲染标签栏组件。
 * 不渲染子组件（TabItem 等）：它们只是 vnode，测试直接调它们的 props 回调，等价于点击。
 *
 * sessions: 官方会话目录里的行 { id, title?, origin?, parentId?, blank? }，current 是主视图里的会话 id。
 * bindings: 会话 id → 官方绑定里的子会话地址（sessions.binding(id).session.getSnapshot().subagent.address）。
 */
export function mountTabs({
  sessions = [],
  current,
  archivedIds = [],
  projections = {},
  bindings = {},
  storage = {},
  navigate = true,
} = {}) {
  const stored = new Map(Object.entries(storage).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]))
  const localStorageStub = {
    getItem: (key) => (stored.has(key) ? stored.get(key) : null),
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key),
  }

  const rowsById = new Map(sessions.map((row) => [row.id, { ...row }]))
  let currentId = current
  let projectionsBySession = projections
  const listState = () => {
    const byId = {}
    for (const [id, row] of rowsById) byId[id] = { ...row, retainedBy: id === currentId ? { mainView: 1 } : {} }
    return { phase: 'ready', ids: [...rowsById.keys()], byId, projectionsBySession }
  }
  let sessionsState = listState()
  const openCalls = []
  const errors = []
  const warnings = []
  const hosts = []

  // ── 极简 React：只够把标签栏组件渲染出来 ─────────────────────────────
  let activeHost
  const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
  const hook = () => {
    if (!activeHost) throw new Error('Hook called outside render')
    const index = activeHost.cursor++
    return [activeHost, (activeHost.hooks[index] ??= {})]
  }
  const effectHook = (effect, deps) => {
    const [host, slot] = hook()
    if (deps !== undefined && sameDeps(slot.deps, deps)) return
    slot.deps = deps
    host.effects.push(() => {
      slot.cleanup?.()
      slot.cleanup = effect()
    })
  }
  const React = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(initial) {
      const [host, slot] = hook()
      if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial
      return [
        slot.value,
        (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (!Object.is(value, slot.value)) {
            slot.value = value
            host.dirty = true
          }
        },
      ]
    },
    useRef(initial) {
      const [, slot] = hook()
      return (slot.ref ??= { current: initial })
    },
    useMemo(factory, deps) {
      const [, slot] = hook()
      if (!sameDeps(slot.deps, deps)) {
        slot.value = factory()
        slot.deps = deps
      }
      return slot.value
    },
    useCallback(callback, deps) {
      const [, slot] = hook()
      if (!sameDeps(slot.deps, deps)) {
        slot.value = callback
        slot.deps = deps
      }
      return slot.value
    },
    useEffect: effectHook,
    useLayoutEffect: effectHook,
    useSyncExternalStore(subscribe, getSnapshot) {
      const [host, slot] = hook()
      if (slot.subscribe !== subscribe) {
        slot.cleanup?.()
        slot.subscribe = subscribe
        slot.cleanup = subscribe(() => {
          host.dirty = true
        })
      }
      return getSnapshot()
    },
  }

  const mountHost = (component, props) => {
    const instance = {
      hooks: [],
      effects: [],
      cursor: 0,
      dirty: true,
      tree: null,
      props,
      render() {
        this.dirty = false
        this.cursor = 0
        activeHost = this
        try {
          this.tree = component(this.props)
        } finally {
          activeHost = undefined
        }
        for (const effect of this.effects.splice(0)) effect()
        return this.tree
      },
    }
    hosts.push(instance)
    instance.render()
    return instance
  }

  // ── 假的 DOM / 浏览器全局 ───────────────────────────────────────────
  const styleNode = () => ({ dataset: {}, remove() {}, textContent: '' })
  const document = {
    createElement: styleNode,
    head: { appendChild() {} },
    documentElement: { hasAttribute: () => false },
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {},
  }
  const window = {
    // 减少动画：点标签时立即切换，不走 150ms 的动画延时
    matchMedia: () => ({ matches: true }),
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    sessionStorage: { getItem: () => '1', setItem() {} },
  }
  let exports
  window.__ModuleLoader__ = {
    load(bundle) {
      exports = bundle.factory((name) => {
        if (name === 'react') return React
        throw new Error(`unexpected require(${name})`)
      })
    },
  }
  const sandbox = {
    window,
    document,
    localStorage: localStorageStub,
    console: { error: (...args) => errors.push(args.map(String).join(' ')), warn: (...args) => warnings.push(args.map(String).join(' ')), log() {} },
    performance: { now: () => Date.now() },
    // 计时器一律不触发：标签栏的延时逻辑（启动动作、落位补偿）不在这里测
    setTimeout: () => 0,
    clearTimeout() {},
    requestAnimationFrame: undefined,
    fetch: () => Promise.resolve({}),
  }
  runInNewContext(source, sandbox, { filename: 'dsh-tab/client.js' })
  if (exports === undefined) throw new Error('client.js did not register a module')

  // ── 假的 ctx ────────────────────────────────────────────────────────
  const sessionListeners = new Set()
  const publish = () => {
    sessionsState = listState()
    for (const listener of [...sessionListeners]) listener()
  }
  const navigateTo = (target) => {
    openCalls.push(plain(target))
    if (!navigate) return
    const id = typeof target === 'string' ? target : target?.childSessionId
    if (rowsById.has(id)) {
      currentId = id
      publish()
    }
  }

  let TabBar
  const slotInjectors = []
  const ctx = {
    effect(fn) {
      return fn()
    },
    locale: { register: () => () => {} },
    layout: {
      panelInfo: { subscribe: () => () => {}, getSnapshot: () => ({ activePanelId: null }) },
      selectPanel() {},
      toggleSidebar() {},
    },
    slots: {
      entriesOfSlot: () => [],
      inject(name, callback) {
        slotInjectors.push(name)
        const register = callback()
        return register
      },
      register(options, component) {
        if (options.name === 'shell.overlay') TabBar = component
        return () => {}
      },
    },
    sessions: {
      list: { getSnapshot: () => sessionsState },
      binding: (id) =>
        bindings[id] === undefined ? undefined : { session: { getSnapshot: () => ({ subagent: { address: bindings[id] } }) } },
    },
    uiWorkspace: {
      openSession: navigateTo,
      startSession() {},
      archiveSession: () => Promise.resolve(),
    },
    workspaces: {
      list: { getSnapshot: () => ({ archivedSessionIds: archivedIds, items: [] }) },
    },
  }
  exports.apply(ctx)
  if (typeof TabBar !== 'function') throw new Error('tab bar was not registered in shell.overlay')

  const props = {
    useSessions: (selector) => selector(sessionsState),
    useSessionStatus: (selector) => selector(new Map()),
    useWorkspaces: (selector) => selector({ archivedSessionIds: archivedIds, items: [] }),
    t: (key) => key,
  }
  const subscribeSessions = (listener) => {
    sessionListeners.add(listener)
    return () => sessionListeners.delete(listener)
  }
  // 会话目录变化时让标签栏重渲染（真实环境里 useSessions 订阅目录）
  const bar = mountHost(TabBar, props)
  subscribeSessions(() => {
    bar.dirty = true
  })

  const flush = () => {
    for (let guard = 0; guard < 20 && bar.dirty; guard += 1) bar.render()
  }
  flush()

  const tabNodes = () => {
    const found = []
    walk(bar.tree, (node) => {
      const p = node.props
      if (p && typeof p.onSelect === 'function' && typeof p.onClose === 'function' && p.panel !== true) found.push(p)
    })
    return found
  }

  const api = {
    /** 标签栏当前画出来的标签（顺序、激活态）。 */
    tabs: () => tabNodes().map((p) => ({ id: p.id, active: p.active, pinned: p.pinned === true, title: p.title })),
    tabIds: () => tabNodes().map((p) => p.id),
    activeTabIds: () => tabNodes().filter((p) => p.active).map((p) => p.id),
    /** 点标签。 */
    click(id) {
      const tab = tabNodes().find((p) => p.id === id)
      if (!tab) throw new Error(`no tab ${id}; tabs: ${tabNodes().map((p) => p.id).join(',')}`)
      tab.onSelect(id)
      flush()
    },
    /** 点标签上的关闭按钮。 */
    close(id) {
      const tab = tabNodes().find((p) => p.id === id)
      if (!tab) throw new Error(`no tab ${id}`)
      tab.onClose(id)
      flush()
    },
    /** 模拟官方在主视图里切到另一个会话（侧栏点会话、点子智能体卡片、团队成员列表……）。 */
    open(id) {
      currentId = id
      publish()
      flush()
    },
    /** 增删/改会话目录里的行。 */
    setRows(nextRows, nextProjections) {
      rowsById.clear()
      for (const row of nextRows) rowsById.set(row.id, { ...row })
      if (nextProjections !== undefined) projectionsBySession = nextProjections
      publish()
      flush()
    },
    /** uiWorkspace.openSession 收到过的所有目标，按顺序。 */
    openCalls: () => openCalls.slice(),
    clearOpenCalls: () => {
      openCalls.length = 0
    },
    currentId: () => currentId,
    storedTabs: () => {
      const raw = stored.get('dsh.tab.view.v2')
      return raw === undefined ? undefined : JSON.parse(raw)
    },
    errors: () => errors.slice(),
    flush,
  }
  return api
}

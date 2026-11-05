/*!
 * dsh-model-effort-picker — client half.
 *
 * Two things in one plugin:
 *
 * 1. An OpenCode-style model picker that takes over the composer's model seat
 *    (`conversation.input.model`): search, Favorites, Recent, models grouped by provider, and a
 *    flyout beside the highlighted model that lists ITS reasoning efforts — so the model and its
 *    effort are chosen in one step. Click a row = that model with its remembered effort; click an
 *    effort in the flyout = that model with that effort.
 * 2. Per-model effort memory. Every successful selection (from this picker, from `/model`, from
 *    the slider plugin, from anywhere that goes through `ModelDirectory.select`) is remembered,
 *    and a plain switch to another model restores the effort last used with it. DSH itself only
 *    sends the model's own default effort on a model switch and keeps a single global default.
 *
 * Safety: the seat is a normal slot entry. If it ever throws while rendering, the slot system
 * abdicates it and the native selector takes over again; a General-settings switch turns it off.
 *
 * Bundle format: the official client-bundle shape — window.__ModuleLoader__.load({ id, factory }).
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-effort-picker',
  factory(require) {
    'use strict'

    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    // ── constants ─────────────────────────────────────────────────────────────
    const NS = 'model-effort-picker'
    const SLOT = 'conversation.input.model'
    const SETTINGS_SLOT = 'settings.general.item'
    const ROUTE = '/dsh-model-effort-picker'
    const STORAGE_KEY = 'dsh.modelEffortPicker.v1'
    /**
     * A `single` slot renders the entry with the LOWEST priority number (SlotCore sorts ascending
     * and the first live entry wins). The native seat sits at 0 and the slider plugin's fallback at
     * -100, so this must be below both. If this entry ever crashes the slot system abdicates it and
     * the native seat renders again.
     */
    const SEAT_PRIORITY = -1000
    const MAX_KEY = 300
    const MAX_EFFORT = 64
    const MAX_EFFORT_ENTRIES = 500
    const MAX_RECENT = 8
    const SHOWN_RECENT = 5
    const MAX_FAVORITES = 100
    const MENU_WIDTH = 440
    const FLY_WIDTH = 220
    // Pointer tracking is never delayed or smoothed: the highlight and the flyout beside it land on the
    // pointer's row in the same frame as the move (no hover-intent timer, no highlight fade, no flyout
    // glide: any of those shows up as the UI trailing the mouse). Only opening and closing animate, and
    // that never gates input: the menu is interactive from the first frame, and while it fades out it
    // ignores the pointer.
    const LEAVE_MS = 110
    const PERSIST_DEBOUNCE_MS = 400
    // Debounce of the footer info request (a network call, not UI latency): sweeping over rows must not fire one per row.
    const INFO_DELAY_MS = 120

    // ── dictionaries ──────────────────────────────────────────────────────────
    const ZH = {
      'trigger.fallback': '请选择模型',
      'trigger.loading': '正在加载模型…',
      'trigger.aria': '选择模型，当前 {model}',
      'trigger.ariaEffort': '选择模型，当前 {model}，推理强度 {effort}',
      'menu.aria': '模型与推理强度',
      'search.placeholder': '搜索模型',
      'search.clear': '清除搜索',
      'search.empty': '没有匹配的模型。',
      'empty.models': '暂无可用模型',
      'status.loading': '正在刷新模型列表…',
      'group.favorites': '收藏',
      'group.recent': '最近使用',
      'provider.account': 'DeepSeek 账号',
      'effort.default': '默认',
      'effort.aria': '推理强度',
      'favorite.add': '收藏',
      'favorite.remove': '取消收藏',
      'info.context': '{size} 上下文',
      'info.modality.text': '文本',
      'info.modality.image': '图片',
      'error.action': '模型操作失败：{message}',
      'error.sessionInUse': '当前会话已被占用，可能是其他正在运行的 DSH 导致的，请退出其他 DSH 后重试。',
      'warning.groupLoad': '{name} 加载失败：{message}',
      'action.reload': '重新加载',
      'settings.picker.title': '类 OpenCode 模型选择器',
      'settings.picker.hint': '选模型的同时选推理强度：高亮模型后在右侧展开强度菜单（悬停或按 →），Ctrl+F 收藏。关闭后恢复 DSH 原生选择器。',
      'settings.memory.title': '记住每个模型的推理强度',
      'settings.memory.hint': '切换到某个模型时自动使用它上次的强度，对 /model 命令和其他入口同样生效。',
      'settings.quiet.title': '切换模型时不改写配置文件',
      'settings.quiet.hint': 'DSH 每次切换模型或强度都会改写配置里的默认模型，并通知全局重新应用设置，换肤类插件会因此让界面闪一下。开启后改由本插件记住上次的选择，新会话照样沿用；手动修改配置里的默认模型仍然优先。',
    }
    const EN = {
      'trigger.fallback': 'Select model',
      'trigger.loading': 'Loading models…',
      'trigger.aria': 'Select model, current {model}',
      'trigger.ariaEffort': 'Select model, current {model}, reasoning effort {effort}',
      'menu.aria': 'Model and reasoning effort',
      'search.placeholder': 'Search models',
      'search.clear': 'Clear search',
      'search.empty': 'No matching models.',
      'empty.models': 'No models available.',
      'status.loading': 'Refreshing model list…',
      'group.favorites': 'Favorites',
      'group.recent': 'Recent',
      'provider.account': 'DeepSeek Account',
      'effort.default': 'Default',
      'effort.aria': 'Reasoning effort',
      'favorite.add': 'Favorite',
      'favorite.remove': 'Unfavorite',
      'info.context': '{size} context',
      'info.modality.text': 'Text',
      'info.modality.image': 'Image',
      'error.action': 'Model operation failed: {message}',
      'error.sessionInUse': 'This session is already in use, possibly by another running DSH instance. Quit other DSH instances and try again.',
      'warning.groupLoad': '{name} failed to load: {message}',
      'action.reload': 'Reload',
      'settings.picker.title': 'OpenCode-style model picker',
      'settings.picker.hint': 'Pick the model and its reasoning effort in one step: highlight a model and use the flyout on its right (hover or press →); Ctrl+F favorites. Turn off to bring back the native DSH selector.',
      'settings.memory.title': 'Remember reasoning effort per model',
      'settings.memory.hint': 'Switching to a model reuses the effort you last used with it; also applies to the /model command and other entry points.',
      'settings.quiet.title': 'Keep model switches out of the config file',
      'settings.quiet.hint': 'DSH rewrites the default model in the config on every model or effort switch and announces a settings change, which makes skin plugins repaint and the page flicker. When on, this plugin remembers the last choice instead and new sessions still use it; a default model edited in the config by hand still takes precedence.',
    }

    // ── persisted state: pure helpers (the host half applies the same rules) ──
    const keyOf = (provider, model) => provider + '/' + model

    function validKey(key) {
      if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY) return false
      const slash = key.indexOf('/')
      return slash > 0 && slash < key.length - 1
    }

    function validEffort(value) {
      return value === null || (typeof value === 'string' && value.length > 0 && value.length <= MAX_EFFORT)
    }

    function uniqueKeys(list, max) {
      const out = []
      if (!Array.isArray(list)) return out
      for (const key of list) {
        if (out.length >= max) break
        if (validKey(key) && !out.includes(key)) out.push(key)
      }
      return out
    }

    function normalizeState(raw) {
      const src = raw !== null && typeof raw === 'object' ? raw : {}
      const efforts = {}
      let count = 0
      if (src.efforts !== null && typeof src.efforts === 'object' && !Array.isArray(src.efforts)) {
        for (const key of Object.keys(src.efforts)) {
          if (count >= MAX_EFFORT_ENTRIES) break
          if (!validKey(key) || !validEffort(src.efforts[key])) continue
          efforts[key] = src.efforts[key]
          count += 1
        }
      }
      const prefs = src.prefs !== null && typeof src.prefs === 'object' ? src.prefs : {}
      return {
        version: 1,
        efforts,
        recent: uniqueKeys(src.recent, MAX_RECENT),
        favorites: uniqueKeys(src.favorites, MAX_FAVORITES),
        prefs: { picker: prefs.picker !== false, memory: prefs.memory !== false },
      }
    }

    /** Apply a patch onto a normalized state; always returns a fresh object. */
    function mergePatch(state, patch) {
      const src = patch !== null && typeof patch === 'object' ? patch : {}
      const next = {
        version: 1,
        efforts: { ...state.efforts },
        recent: state.recent,
        favorites: state.favorites,
        prefs: { ...state.prefs },
      }
      if (src.efforts !== null && typeof src.efforts === 'object' && !Array.isArray(src.efforts)) {
        for (const key of Object.keys(src.efforts)) {
          if (!validKey(key) || !validEffort(src.efforts[key])) continue
          // Re-insert so the most recently written key is last; the oldest are dropped first.
          delete next.efforts[key]
          next.efforts[key] = src.efforts[key]
        }
        const keys = Object.keys(next.efforts)
        if (keys.length > MAX_EFFORT_ENTRIES) {
          for (const key of keys.slice(0, keys.length - MAX_EFFORT_ENTRIES)) delete next.efforts[key]
        }
      }
      if (Array.isArray(src.recent)) next.recent = uniqueKeys(src.recent, MAX_RECENT)
      if (Array.isArray(src.favorites)) next.favorites = uniqueKeys(src.favorites, MAX_FAVORITES)
      if (src.prefs !== null && typeof src.prefs === 'object') {
        if (typeof src.prefs.picker === 'boolean') next.prefs.picker = src.prefs.picker
        if (typeof src.prefs.memory === 'boolean') next.prefs.memory = src.prefs.memory
      }
      return next
    }

    function isEmptyState(state) {
      return Object.keys(state.efforts).length === 0 && state.recent.length === 0 && state.favorites.length === 0
    }

    /** Host state wins on conflicts; local-only knowledge is kept so nothing is lost on first sync. */
    function mergeStates(server, local) {
      const favorites = uniqueKeys([...server.favorites, ...local.favorites], MAX_FAVORITES)
      return {
        version: 1,
        efforts: { ...local.efforts, ...server.efforts },
        recent: server.recent.length > 0 ? server.recent : local.recent,
        favorites,
        prefs: { ...server.prefs },
      }
    }

    /** The patch that turns `base` into `target`, or null when they already agree. */
    function diffToPatch(base, target) {
      const patch = {}
      const efforts = {}
      for (const key of Object.keys(target.efforts)) {
        if (base.efforts[key] !== target.efforts[key]) efforts[key] = target.efforts[key]
      }
      if (Object.keys(efforts).length > 0) patch.efforts = efforts
      if (JSON.stringify(base.recent) !== JSON.stringify(target.recent)) patch.recent = target.recent
      if (JSON.stringify(base.favorites) !== JSON.stringify(target.favorites)) patch.favorites = target.favorites
      if (base.prefs.picker !== target.prefs.picker || base.prefs.memory !== target.prefs.memory) patch.prefs = { ...target.prefs }
      return Object.keys(patch).length > 0 ? patch : null
    }

    function readJson(text) {
      if (typeof text !== 'string') return undefined
      try {
        return JSON.parse(text)
      } catch (error) {
        return undefined
      }
    }

    // ── memory store ──────────────────────────────────────────────────────────
    /**
     * Reactive store over the persisted state. Every change is written to local storage at once
     * (fast cold start) and sent to the host half after a short debounce (survives the desktop
     * app's per-launch port change, which gives the web page a fresh localStorage each time).
     */
    function createMemoryStore(options) {
      const storage = options.storage
      const remote = options.remote
      const debounceMs = options.debounceMs === undefined ? PERSIST_DEBOUNCE_MS : options.debounceMs
      let state = normalizeState(readJson(storage.get()))
      const listeners = new Set()
      let pending = null
      let timer = null
      let inflight = null
      let hydrated = false
      let disposed = false

      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('dsh-model-effort-picker: listener failed', error)
          }
        }
      }

      const persistLocal = () => storage.set(JSON.stringify(state))

      const addPending = (part) => {
        const next = pending === null ? {} : pending
        if (part.efforts !== undefined) next.efforts = { ...(next.efforts || {}), ...part.efforts }
        if (part.recent !== undefined) next.recent = part.recent
        if (part.favorites !== undefined) next.favorites = part.favorites
        if (part.prefs !== undefined) next.prefs = { ...(next.prefs || {}), ...part.prefs }
        pending = next
      }

      const schedule = (delay) => {
        // After dispose nothing may re-arm: the plugin is gone and must not keep calling the host.
        if (remote === undefined || remote === null || timer !== null || disposed) return
        timer = setTimeout(() => {
          timer = null
          void flush()
        }, delay === undefined ? debounceMs : delay)
      }

      async function flush() {
        if (remote === undefined || remote === null || pending === null) return
        if (inflight !== null) {
          try {
            await inflight
          } catch (error) {
            /* the failing sender re-queues its own batch */
          }
          if (pending === null) return
        }
        const batch = pending
        pending = null
        inflight = remote.patch(batch)
        try {
          await inflight
        } catch (error) {
          // Keep newer local values over the failed batch, then retry later.
          const newer = pending
          pending = null
          addPending(batch)
          if (newer !== null) addPending(newer)
          schedule(10000)
        } finally {
          inflight = null
        }
      }

      const commit = (next, part) => {
        state = next
        persistLocal()
        addPending(part)
        schedule()
        emit()
      }

      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => state,
        /** What the host knows replaces our guesses; our unsent edits are re-applied on top. */
        async hydrate() {
          if (remote === undefined || remote === null || hydrated) return
          let server = null
          try {
            server = await remote.load()
          } catch (error) {
            return
          }
          if (server === null) return
          hydrated = true
          let merged = isEmptyState(server) ? state : mergeStates(server, state)
          if (pending !== null) merged = mergePatch(merged, pending)
          const extra = diffToPatch(server, merged)
          state = merged
          persistLocal()
          if (extra !== null) {
            addPending(extra)
            schedule()
          }
          emit()
        },
        flush,
        setEffort(key, value) {
          if (!validKey(key) || !validEffort(value) || state.efforts[key] === value) return
          const part = { efforts: { [key]: value } }
          commit(mergePatch(state, part), part)
        },
        /** Remember a model's effort only when nothing is known about it yet. */
        seed(key, value) {
          if (!validKey(key) || !validEffort(value)) return
          if (state.efforts[key] === undefined) this.setEffort(key, value)
          if (!state.recent.includes(key) && state.recent.length === 0) this.touchRecent(key)
        },
        touchRecent(key) {
          if (!validKey(key)) return
          const recent = [key, ...state.recent.filter((entry) => entry !== key)].slice(0, MAX_RECENT)
          if (JSON.stringify(recent) === JSON.stringify(state.recent)) return
          const part = { recent }
          commit(mergePatch(state, part), part)
        },
        toggleFavorite(key) {
          if (!validKey(key)) return false
          const has = state.favorites.includes(key)
          const favorites = has ? state.favorites.filter((entry) => entry !== key) : [...state.favorites, key].slice(0, MAX_FAVORITES)
          const part = { favorites }
          commit(mergePatch(state, part), part)
          return !has
        },
        setPref(name, value) {
          if ((name !== 'picker' && name !== 'memory') || typeof value !== 'boolean' || state.prefs[name] === value) return
          const part = { prefs: { [name]: value } }
          commit(mergePatch(state, part), part)
        },
        /** One call per successful selection: remember the effort and bump the model in Recent. */
        recordSelection(selection) {
          const key = keyOf(selection.provider, selection.model)
          this.setEffort(key, selection.reasoningEffort === undefined ? null : selection.reasoningEffort)
          this.touchRecent(key)
        },
        /** Send what is still queued once, then stop timers for good. */
        dispose() {
          if (timer !== null) clearTimeout(timer)
          timer = null
          disposed = true
          void flush()
        },
      }
    }

    function createStorage() {
      return {
        get() {
          try {
            return window.localStorage.getItem(STORAGE_KEY)
          } catch (error) {
            return null
          }
        },
        set(value) {
          try {
            window.localStorage.setItem(STORAGE_KEY, value)
          } catch (error) {
            /* storage disabled: the host copy still persists */
          }
        },
      }
    }

    function createRemote() {
      async function post(path, body) {
        const text = JSON.stringify(body)
        const response = await window.fetch(ROUTE + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: text,
          cache: 'no-store',
          keepalive: text.length < 60000,
        })
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      }
      return {
        async load() {
          const result = await post('/state', {})
          return result !== null && typeof result === 'object' && result.ok === true ? normalizeState(result.state) : null
        },
        async patch(patch) {
          const result = await post('/state', { patch })
          return result !== null && typeof result === 'object' && result.ok === true ? normalizeState(result.state) : null
        },
        async info(provider, model) {
          const result = await post('/info', { provider, model })
          return result !== null && typeof result === 'object' && result.ok === true ? result.info || null : null
        },
        /** Host-only switches: `{ quiet }`, or null when the host half does not answer. */
        async options(patch) {
          const result = await post('/options', patch === undefined ? {} : { patch })
          const value = result !== null && typeof result === 'object' && result.ok === true ? result.options : null
          return value !== null && typeof value === 'object' && typeof value.quiet === 'boolean' ? { quiet: value.quiet } : null
        },
      }
    }

    /**
     * The host-only `quiet` switch: keep the default model out of the profile config. It lives on the
     * host, so the page reads it once and writes through the route; what is shown follows the answer.
     * Unknown (not loaded yet, or no host half) counts as the default, on.
     */
    function createOptionsStore(remote) {
      let state = { quiet: true, known: false }
      const listeners = new Set()
      const set = (next) => {
        if (next.quiet === state.quiet && next.known === state.known) return
        state = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.error('dsh-model-effort-picker: listener failed', error)
          }
        }
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        getSnapshot: () => state,
        async load() {
          if (remote === undefined || remote === null) return
          try {
            const options = await remote.options()
            if (options !== null) set({ quiet: options.quiet, known: true })
          } catch (error) {
            /* no host half: keep the default */
          }
        },
        async setQuiet(value) {
          if (typeof value !== 'boolean') return
          const previous = state
          set({ quiet: value, known: true }) // optimistic; the host's answer settles it
          try {
            const options = remote === undefined || remote === null ? null : await remote.options({ quiet: value })
            set(options === null ? previous : { quiet: options.quiet, known: true })
          } catch (error) {
            set(previous)
          }
        },
      }
    }

    /** Present the options store with the `{ prefs }` shape the settings rows read. */
    function optionsAsPrefs(options) {
      let source
      let view
      return {
        subscribe: options.subscribe,
        getSnapshot() {
          const current = options.getSnapshot()
          if (current !== source) {
            source = current
            view = { prefs: { quiet: current.quiet } }
          }
          return view
        },
        setPref(name, value) {
          if (name === 'quiet') void options.setQuiet(value)
        },
      }
    }

    // ── catalog helpers ───────────────────────────────────────────────────────
    function orderProviders(groups) {
      const rank = (group) => (group.id === 'deepseek-account' ? 0 : group.id === 'deepseek-official' ? 1 : 2)
      return groups.slice().sort((left, right) => rank(left) - rank(right))
    }

    function findModel(groups, provider, modelId) {
      for (const group of groups) {
        if (group.id !== provider) continue
        for (const model of group.models || []) if (model.id === modelId) return model
      }
      return undefined
    }

    const effortList = (model) =>
      model !== undefined && model !== null && model.reasoning !== undefined && Array.isArray(model.reasoning.efforts) ? model.reasoning.efforts : []

    /** Display names for provider ids; anything unlisted is title-cased word by word. */
    const KNOWN_PROVIDER_NAMES = {
      anthropic: 'Anthropic', openai: 'OpenAI', xai: 'xAI', google: 'Google', gemini: 'Gemini', deepseek: 'DeepSeek',
      openrouter: 'OpenRouter', mistral: 'Mistral', groq: 'Groq', zai: 'Z.AI', moonshot: 'Moonshot', kimi: 'Kimi',
      qwen: 'Qwen', ollama: 'Ollama', cerebras: 'Cerebras', bedrock: 'Amazon Bedrock', azure: 'Azure OpenAI',
      'github-copilot': 'GitHub Copilot', 'lm-studio': 'LM Studio',
    }

    /**
     * The name a provider group is shown under. The DeepSeek account group uses the native wording. A name the
     * user configured (`displayName`) is kept as is; only the bare id, which is what DSH shows by default, is
     * prettified, so `anthropic` reads `Anthropic` as it does in other pickers.
     */
    function providerLabel(group, t) {
      if (group.id === 'deepseek-account') return t('provider.account')
      const name = String(group.name === undefined || group.name === null ? group.id : group.name)
      if (name !== group.id || !/^[a-z0-9][a-z0-9._-]*$/.test(name)) return name
      if (Object.prototype.hasOwnProperty.call(KNOWN_PROVIDER_NAMES, name)) return KNOWN_PROVIDER_NAMES[name]
      return name.split(/[-_]/).filter(Boolean).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
    }

    function rowsOf(groups, labelOf) {
      const rows = []
      for (const group of groups) {
        for (const model of group.models || []) {
          rows.push({ key: keyOf(group.id, model.id), provider: { id: group.id, name: labelOf(group) }, model, groupId: group.id })
        }
      }
      return rows
    }

    /**
     * Rank one token against one field: prefix (0) < start of a later word (1) < inside a word (2)
     * < scattered letters (3+). Equal ranks keep the catalog order, so results stay predictable.
     */
    function tokenScore(token, text) {
      if (text.startsWith(token)) return 0
      let at = text.indexOf(token)
      if (at >= 0) {
        while (at >= 0) {
          if (at === 0 || !/[a-z0-9]/.test(text.charAt(at - 1))) return 1
          at = text.indexOf(token, at + 1)
        }
        return 2
      }
      let from = 0
      let last = -1
      let gaps = 0
      for (const ch of token) {
        const found = text.indexOf(ch, from)
        if (found < 0) return -1
        if (last >= 0) gaps += found - last - 1
        last = found
        from = found + 1
      }
      return 3 + gaps / 100
    }

    /** Lower is better, -1 = no match. Every whitespace-separated token must match somewhere. */
    function matchScore(query, row) {
      const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
      if (tokens.length === 0) return 0
      const fields = [
        [String(row.model.name || '').toLowerCase(), 0],
        [String(row.model.id || '').toLowerCase(), 0.5],
        [String(row.provider.name || '').toLowerCase(), 1.5],
        [String(row.provider.id || '').toLowerCase(), 1.6],
      ]
      let total = 0
      for (const token of tokens) {
        let best = -1
        for (const [text, weight] of fields) {
          const score = tokenScore(token, text)
          if (score >= 0 && (best < 0 || score + weight < best)) best = score + weight
        }
        if (best < 0) return -1
        total += best
      }
      return total
    }

    /**
     * What the list shows. Without a query: Favorites, Recent, then the remaining models by
     * provider (a model appears once). With a query: matches grouped by provider, best first.
     * `flat` is the keyboard order; every row carries its index in it.
     */
    function buildSections(input) {
      const { groups, favorites, recent, query } = input
      const labelOf = typeof input.labelOf === 'function' ? input.labelOf : (group) => group.name
      const all = rowsOf(groups, labelOf)
      const byKey = new Map(all.map((row) => [row.key, row]))
      const text = query.trim()
      const sections = []
      if (text !== '') {
        for (const group of groups) {
          const matches = []
          for (const row of all) {
            if (row.groupId !== group.id) continue
            const score = matchScore(text, row)
            if (score >= 0) matches.push({ row, score })
          }
          matches.sort((left, right) => left.score - right.score)
          if (matches.length > 0) sections.push({ id: 'g:' + group.id, title: labelOf(group), rows: matches.map((match) => match.row) })
        }
      } else {
        const used = new Set()
        const take = (keys, limit) => {
          const rows = []
          for (const key of keys) {
            const row = byKey.get(key)
            if (row === undefined || used.has(key)) continue
            used.add(key)
            rows.push(row)
            if (rows.length >= limit) break
          }
          return rows
        }
        const favoriteRows = take(favorites, MAX_FAVORITES)
        if (favoriteRows.length > 0) sections.push({ id: 'favorites', titleKey: 'group.favorites', showProvider: true, rows: favoriteRows })
        const recentRows = take(recent, SHOWN_RECENT)
        if (recentRows.length > 0) sections.push({ id: 'recent', titleKey: 'group.recent', showProvider: true, rows: recentRows })
        for (const group of groups) {
          const rows = all.filter((row) => row.groupId === group.id && !used.has(row.key))
          if (rows.length > 0) sections.push({ id: 'g:' + group.id, title: labelOf(group), rows })
        }
      }
      const flat = []
      const indexed = sections.map((section) => ({
        ...section,
        rows: section.rows.map((row) => {
          const item = { ...row, index: flat.length }
          flat.push(item)
          return item
        }),
      }))
      return { sections: indexed, flat }
    }

    const sameModel = (current, provider, model) => current !== null && current !== undefined && current.provider === provider && current.model === model

    /** The effort DSH would run a model with right now: the explicit one, else the model default. */
    const effectiveEffort = (current, model) =>
      current !== null && current !== undefined && current.reasoningEffort !== undefined ? current.reasoningEffort : model !== undefined && model.reasoning !== undefined ? model.reasoning.defaultEffort : undefined

    /**
     * The effort a plain click on this model would select: the current effort for the current
     * model; otherwise the remembered one when still offered; otherwise the model default.
     */
    function plannedEffort(input) {
      const { current, mem, row, memoryOn } = input
      const levels = effortList(row.model)
      if (levels.length === 0) return undefined
      if (sameModel(current, row.provider.id, row.model.id)) return effectiveEffort(current, row.model)
      if (memoryOn) {
        const stored = mem.efforts[row.key]
        if (typeof stored === 'string' && levels.some((level) => level.id === stored)) return stored
      }
      return row.model.reasoning.defaultEffort
    }

    function formatContext(tokens, localeTag) {
      try {
        return new Intl.NumberFormat(localeTag || undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)
      } catch (error) {
        return String(tokens)
      }
    }

    // ── making every selection path remember ──────────────────────────────────
    const PATCH_MARK = Symbol.for('dsh-model-effort-picker.patched')
    /** Selections built by this picker with a deliberate effort; the wrapper must not rewrite them. */
    const EXPLICIT = new WeakSet()

    /**
     * Plain model switches (the native list, `/model`, ...) carry no effort or just the model
     * default. Replace that with the remembered effort — never for a same-model change and never
     * when the caller picked a non-default effort on purpose.
     */
    function applyMemory(directory, selection, memory) {
      const mem = memory.getSnapshot()
      if (!mem.prefs.memory || EXPLICIT.has(selection)) return selection
      const snap = directory.store.getSnapshot()
      if (sameModel(snap.current, selection.provider, selection.model)) return selection
      const model = findModel(snap.groups || [], selection.provider, selection.model)
      const levels = effortList(model)
      if (levels.length === 0) return selection
      const automatic = selection.reasoningEffort === undefined || selection.reasoningEffort === model.reasoning.defaultEffort
      if (!automatic) return selection
      const stored = mem.efforts[keyOf(selection.provider, selection.model)]
      if (typeof stored !== 'string' || stored === selection.reasoningEffort || !levels.some((level) => level.id === stored)) return selection
      return { provider: selection.provider, model: selection.model, reasoningEffort: stored }
    }

    /**
     * @param hooks.afterSelect called after every successful selection (the model directory has already
     *   accepted it); failures inside are logged and never reach the caller.
     */
    function createDirectoryPatcher(memory, hooks = {}) {
      const patched = new Set()

      const seedFrom = (directory) => {
        try {
          const snap = directory.store.getSnapshot()
          if (snap.status === 'ready' && snap.pending === null && snap.current !== null && snap.current !== undefined) {
            memory.seed(keyOf(snap.current.provider, snap.current.model), snap.current.reasoningEffort === undefined ? null : snap.current.reasoningEffort)
          }
        } catch (error) {
          /* seeding is best effort */
        }
      }

      function patch(directory) {
        if (directory === null || directory === undefined || typeof directory.select !== 'function' || directory[PATCH_MARK] !== undefined) return directory
        const original = directory.select
        const hadOwn = Object.prototype.hasOwnProperty.call(directory, 'select')
        const store = directory.store
        const unsubscribe = store !== undefined && store !== null && typeof store.subscribe === 'function' ? store.subscribe(() => seedFrom(directory)) : null
        const wrapper = function patchedSelect(selection) {
          let effective = selection
          try {
            effective = applyMemory(directory, selection, memory)
          } catch (error) {
            console.warn('dsh-model-effort-picker: effort memory skipped', error)
          }
          return Promise.resolve(original.call(directory, effective)).then((result) => {
            if (result !== null && result !== undefined && result.ok === true) {
              try {
                memory.recordSelection(effective)
              } catch (error) {
                console.warn('dsh-model-effort-picker: recording selection failed', error)
              }
              try {
                if (typeof hooks.afterSelect === 'function') hooks.afterSelect(effective)
              } catch (error) {
                console.warn('dsh-model-effort-picker: after-select hook failed', error)
              }
            }
            return result
          })
        }
        directory.select = wrapper
        directory[PATCH_MARK] = { original, hadOwn, wrapper, unsubscribe }
        patched.add(directory)
        seedFrom(directory)
        return directory
      }

      function restoreAll() {
        for (const directory of patched) {
          const mark = directory[PATCH_MARK]
          if (mark === undefined) continue
          if (directory.select === mark.wrapper) {
            if (mark.hadOwn) directory.select = mark.original
            else delete directory.select
          }
          if (mark.unsubscribe !== null) mark.unsubscribe()
          delete directory[PATCH_MARK]
        }
        patched.clear()
      }

      /** Directories that existed before this plugin loaded. */
      function patchExisting(resolver) {
        try {
          const live = resolver.live
          const values = live !== undefined && live.directories !== undefined ? live.directories.values : undefined
          if (values === undefined || values === null) return
          for (const directory of values) patch(directory)
        } catch (error) {
          /* internal shape changed: directories are still patched when their seat mounts */
        }
      }

      return { patch, restoreAll, patchExisting }
    }

    // ── icons ─────────────────────────────────────────────────────────────────
    function svg(children, props) {
      const size = props !== undefined && props.size !== undefined ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: 'false',
          className: props !== undefined ? props.className : undefined,
        },
        children,
      )
    }
    const IconChevronDown = (props) => svg(h('path', { d: 'M4 6.25 8 10.25l4-4' }), props)
    const IconChevronRight = (props) => svg(h('path', { d: 'm6.25 4 4 4-4 4' }), props)
    const IconCheck = (props) => svg(h('path', { d: 'm3.5 8.5 3 3 6-6.5' }), props)
    const IconClose = (props) => svg(h('path', { d: 'm4.5 4.5 7 7m0-7-7 7' }), props)
    const IconSearch = (props) => svg([h('circle', { key: 'c', cx: 7, cy: 7, r: 4.25 }), h('path', { key: 'p', d: 'm10.25 10.25 3.25 3.25' })], props)
    const IconModel = (props) => svg([h('path', { key: 'a', d: 'M8 1.75 13.5 4.9v6.2L8 14.25 2.5 11.1V4.9z' }), h('path', { key: 'b', d: 'M2.75 5 8 8.1 13.25 5M8 8.1v6' })], props)
    const IconStar = (props) =>
      svg(h('path', { d: 'M8 1.9l1.85 3.9 4.25.55-3.15 2.95.8 4.2L8 11.35 4.25 13.5l.8-4.2L1.9 6.35l4.25-.55z', fill: props !== undefined && props.filled ? 'currentColor' : 'none' }), props)

    // ── styles ────────────────────────────────────────────────────────────────
    const CSS = `
.mep-root{min-width:0;position:relative}
.mep-trigger{display:flex;align-items:center;gap:4px;min-width:0;max-width:min(360px,45cqw);height:28px;padding:0 4px 0 8px;border:none;outline:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:400;line-height:20px;cursor:pointer}
.mep-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mep-trigger:focus-visible:not([data-selection-focus]){box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}
.mep-trigger:disabled{color:var(--dsw-alias-label-dimmed);cursor:default}
.mep-trigger-icon{display:var(--dsh-composer-model-icon-display,none);flex:none}
.mep-trigger-label,.mep-trigger-effort{display:var(--dsh-composer-model-text-display,block);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mep-trigger-effort{color:var(--dsw-alias-label-caption);flex-shrink:1000}
.mep-chevron{flex:none;color:var(--dsw-alias-label-caption);transition:transform .15s cubic-bezier(.25,0,.5,1)}
.mep-chevron[data-open]{transform:rotate(180deg)}
.mep-spin{flex:none;width:12px;height:12px;margin:0 2px;box-sizing:border-box;border:2px solid var(--dsw-alias-border-l2,rgba(121,126,145,.3));border-top-color:var(--dsw-alias-label-secondary,#686c75);border-radius:50%;animation:mep-spin .7s linear infinite}
@keyframes mep-spin{to{transform:rotate(360deg)}}
@keyframes mep-menu-in{from{opacity:0;transform:scaleY(.95)}to{opacity:1;transform:scaleY(1)}}
@keyframes mep-menu-out{from{opacity:1;transform:scaleY(1)}to{opacity:0;transform:scaleY(.95)}}
@keyframes mep-fly-in{from{opacity:0;transform:translateX(-4px)}to{opacity:1;transform:translateX(0)}}
@keyframes mep-fly-out{from{opacity:1;transform:translateX(0)}to{opacity:0;transform:translateX(-4px)}}
@keyframes mep-fade-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){.mep-spin{animation-duration:2s}.mep-chevron{transition:none}}
.mep-menu,.mep-flyout{position:fixed;z-index:1100;box-sizing:border-box;display:flex;flex-direction:column;border:0;border-radius:var(--dsw-radius-lg,12px);color:var(--dsw-alias-label-primary,#15171b);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3,#fff));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));backdrop-filter:var(--dsw-menu-backdrop-filter,blur(40px) saturate(150%));--dsw-elevation-stroke-color:var(--dsw-alias-border-l1,rgba(121,126,145,.2));box-shadow:var(--dsw-elevation-prominent,0 14px 42px rgba(18,24,42,.18),0 3px 10px rgba(18,24,42,.08));overflow:hidden;font-size:13px;line-height:18px;-webkit-user-select:none;user-select:none;transition:none}
body[data-ds-dark-theme] .mep-menu,body[data-ds-dark-theme] .mep-flyout{color:var(--dsw-alias-label-primary,#f2f4f8);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-3,#202126));box-shadow:var(--dsw-elevation-prominent,0 18px 46px rgba(0,0,0,.48),0 3px 12px rgba(0,0,0,.32))}
.mep-menu{padding:6px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);transform-origin:bottom right;animation:mep-menu-in .15s cubic-bezier(.25,0,.5,1)}
.mep-menu[data-side=bottom]{transform-origin:top right}
.mep-flyout{z-index:1101;width:${FLY_WIDTH}px;padding:6px;transform-origin:left top;animation:mep-fly-in .15s cubic-bezier(.25,0,.5,1)}
.mep-menu[data-leaving]{pointer-events:none;animation:mep-menu-out ${LEAVE_MS}ms cubic-bezier(.25,0,.5,1) forwards}
.mep-flyout[data-leaving]{pointer-events:none;animation:mep-fly-out ${LEAVE_MS}ms cubic-bezier(.25,0,.5,1) forwards}
@media (prefers-reduced-motion:reduce){.mep-menu,.mep-flyout,.mep-menu[data-leaving],.mep-flyout[data-leaving]{animation:none}}
.mep-search{display:flex;align-items:center;gap:8px;flex:none;padding:6px 8px 8px;color:var(--dsw-alias-label-tertiary,#9296a0)}
.mep-search-input{flex:1;min-width:0;padding:0;border:0;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#15171b);font:inherit;font-size:14px;line-height:20px;-webkit-user-select:text;user-select:text}
.mep-search-input::placeholder{color:var(--dsw-alias-label-caption,#9296a0)}
.mep-search-clear{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary,#686c75);cursor:pointer}
.mep-search-clear:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mep-strip{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin:0 0 4px;padding:6px 8px;border-radius:var(--dsw-radius-md,8px);font-size:11px;line-height:16px;background:var(--dsw-alias-interactive-bg-hover-danger,rgba(220,55,70,.08));color:var(--dsw-alias-state-error-primary,#c83e4d)}
.mep-strip[data-kind=warning]{background:var(--dsw-alias-bg-module-platform,rgba(213,148,44,.1));color:var(--dsw-alias-state-warn-label,#b7791f)}
.mep-strip button{flex:none;padding:0;border:0;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
.mep-list{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding:0 2px 2px}
.mep-group{padding:10px 10px 4px;color:var(--dsw-alias-label-tertiary,#9296a0);font-size:12px;line-height:16px}
.mep-row{display:flex;align-items:center;gap:8px;box-sizing:border-box;min-height:32px;padding:0 10px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;color:inherit;transition:none}
.mep-row[data-active]{background:var(--dsw-alias-interactive-bg-hover)}
.mep-check{display:grid;place-items:center;flex:0 0 16px;width:16px;color:var(--dsw-alias-label-primary,#15171b)}
.mep-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.mep-provider{flex:none;color:var(--dsw-alias-label-tertiary,#9296a0);font-size:12px}
.mep-row-right{display:flex;align-items:center;gap:2px;flex:none;margin-left:auto;padding-left:12px;color:var(--dsw-alias-label-secondary,#686c75);font-size:12px}
.mep-empty{padding:14px 10px;color:var(--dsw-alias-label-tertiary,#9296a0);font-size:12px;text-align:center}
.mep-fitem{display:flex;align-items:center;justify-content:space-between;gap:8px;box-sizing:border-box;min-height:30px;padding:0 10px;border-radius:var(--dsw-radius-md,8px);cursor:pointer;transition:none}
.mep-fitem[data-active]{background:var(--dsw-alias-interactive-bg-hover)}
.mep-fsep{flex:none;height:1px;margin:6px 4px;background:var(--dsw-alias-border-l2,rgba(121,126,145,.18))}
.mep-kbd{display:inline-flex;gap:4px;flex:none}
.mep-kbd span{display:inline-block;padding:0 5px;border-radius:4px;background:var(--dsw-alias-fill-tertiary,rgba(120,125,140,.14));color:var(--dsw-alias-label-secondary,#686c75);font-size:10px;line-height:16px;font-weight:600;letter-spacing:.02em}
.mep-finfo{flex:none;padding:4px 10px 6px;color:var(--dsw-alias-label-tertiary,#9296a0);font-size:11px;line-height:16px}
.mep-finfo>div{animation:mep-fade-in .18s ease-out}
@media (prefers-reduced-motion:reduce){.mep-finfo>div{animation:none}}
.mep-setting{display:flex;flex-direction:column;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(121,126,145,.18))}
.mep-setting-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 0;min-height:44px}
.mep-setting-text{min-width:0;display:flex;flex-direction:column;gap:2px}
.mep-setting-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.mep-setting-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}
.mep-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;cursor:pointer;background:var(--dsw-alias-border-l3,rgba(121,126,145,.35))}
.mep-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary,var(--dsw-alias-state-business-primary,#356ae6))}
.mep-switch-knob{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-label-primary-foreground,#fff);transition:transform .12s ease}
.mep-switch[aria-checked=false] .mep-switch-knob{background:var(--dsw-alias-switch-thumb,#fff)}
.mep-switch[aria-checked=true] .mep-switch-knob{transform:translateX(16px)}
.mep-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
@media (prefers-reduced-motion:reduce){.mep-switch-knob{transition:none}}
`

    // ── the picker ────────────────────────────────────────────────────────────
    /** Fetched footer info per model key; shared across renders, null = unavailable. */
    const infoCache = new Map()

    const wrapIndex = (index, length) => (length === 0 ? 0 : ((index % length) + length) % length)

    const prefersReducedMotion = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    function Picker(props) {
      const { locked, available, directory, load, t, sessionId, controller, memory, localeTag, fetchInfo } = props

      const subscribeDirectory = useCallback((listener) => directory.subscribe(listener), [directory])
      const readDirectory = useCallback(() => directory.getSnapshot(), [directory])
      const state = useSyncExternalStore(subscribeDirectory, readDirectory)
      const mem = useSyncExternalStore(memory.subscribe, memory.getSnapshot)

      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      // The highlight follows the model, not a list position: toggling a favorite or a refreshed
      // catalog reorders the rows, and the highlight must stay on the same model.
      const [hiKey, setHiKey] = useState(null)
      const [zone, setZone] = useState('list')
      // Whether the keyboard (not the pointer) moved focus into the flyout: only then does Escape
      // step back to the list first; with the pointer resting on the flyout Escape closes the menu.
      const [flyByKeyboard, setFlyByKeyboard] = useState(false)
      const [fi, setFi] = useState(0)
      const [pos, setPos] = useState(null)
      const [flyPos, setFlyPos] = useState(null)
      const [selectError, setSelectError] = useState(null)
      const [infoTick, setInfoTick] = useState(0)
      // Bumped on list scroll: the flyout is re-measured after every commit, so a re-render keeps it
      // glued to its row (a same-value setState would bail out and never re-measure).
      const [, setScrollTick] = useState(0)

      const rootRef = useRef(null)
      const triggerRef = useRef(null)
      const menuRef = useRef(null)
      const flyRef = useRef(null)
      const inputRef = useRef(null)
      const rowRefs = useRef([])
      const lastMouse = useRef({ x: -1, y: -1 })
      // Who is in charge of the highlight. After a real pointer move or a wheel turn it is the pointer
      // (the row under it takes the highlight, also when the list scrolls beneath a resting pointer);
      // after any key it is the keyboard (the browser's "pointer was re-tested" mouse moves that follow
      // a scroll or re-layout must not take the highlight back from the keys).
      const inputMode = useRef('keyboard')
      // Where the highlight last came from. Only keyboard / programmatic changes scroll the list to
      // reveal it; a pointer already sits on that row, and scrolling under it makes the row run away.
      const hiSource = useRef('keyboard')
      // Closing keeps the menu mounted for LEAVE_MS so it can fade out; `leaving` marks that window.
      const [leaving, setLeaving] = useState(false)
      const leaveTimer = useRef(null)
      const uid = React.useId()

      const groups = useMemo(() => orderProviders(state.groups || []), [state.groups])
      const current = state.current === undefined ? null : state.current
      const currentKey = current === null ? null : keyOf(current.provider, current.model)
      const currentModel = current === null ? undefined : findModel(groups, current.provider, current.model)
      const memoryOn = mem.prefs.memory

      const built = useMemo(
        () => buildSections({ groups, favorites: mem.favorites, recent: mem.recent, query, labelOf: (group) => providerLabel(group, t) }),
        [groups, mem.favorites, mem.recent, query, t],
      )
      const flat = built.flat
      const hiIndex = hiKey === null ? -1 : flat.findIndex((row) => row.key === hiKey)
      const hiSafe = flat.length === 0 ? -1 : hiIndex >= 0 ? hiIndex : 0
      const hrow = hiSafe < 0 ? undefined : flat[hiSafe]
      const hmodel = hrow === undefined ? undefined : hrow.model
      const levels = effortList(hmodel)
      const hIsCurrent = hrow !== undefined && hrow.key === currentKey
      const checkedEffort =
        hrow === undefined ? undefined : hIsCurrent ? effectiveEffort(current, hmodel) : plannedEffort({ current, mem, row: hrow, memoryOn })
      const hFavorite = hrow !== undefined && mem.favorites.includes(hrow.key)

      const flyItems = useMemo(() => {
        const items = []
        if (hmodel !== undefined && levels.length > 0) {
          if (hmodel.reasoning.defaultEffort === undefined) items.push({ kind: 'effort', id: null, label: t('effort.default') })
          for (const level of levels) items.push({ kind: 'effort', id: level.id, label: level.name })
        }
        items.push({ kind: 'favorite' })
        return items
        // `t` is rebound on locale changes; levels/model identity covers the rest.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [hmodel, t])

      const busy = state.pending !== null && state.pending !== undefined ? true : state.status === 'selecting'
      const info = hrow === undefined ? undefined : infoCache.get(hrow.key)

      const cancelLeave = () => {
        if (leaveTimer.current !== null) {
          clearTimeout(leaveTimer.current)
          leaveTimer.current = null
        }
        setLeaving(false)
      }

      const closeMenu = useCallback((restoreFocus) => {
        setOpen(false)
        setZone('list')
        if (leaveTimer.current !== null) clearTimeout(leaveTimer.current)
        const unmount = () => {
          leaveTimer.current = null
          setLeaving(false)
          setPos(null)
          setFlyPos(null)
        }
        if (prefersReducedMotion()) unmount()
        else {
          setLeaving(true)
          leaveTimer.current = setTimeout(unmount, LEAVE_MS + 20)
        }
        if (restoreFocus) {
          setTimeout(() => {
            if (triggerRef.current !== null) triggerRef.current.focus()
          }, 0)
        }
      }, [])

      const openMenu = () => {
        cancelLeave()
        // The menu appears under no pointer: the current model is revealed, and the pointer takes over on its first real move.
        inputMode.current = 'keyboard'
        hiSource.current = 'keyboard'
        setQuery('')
        setZone('list')
        setFi(0)
        setSelectError(null)
        setHiKey(currentKey)
        setOpen(true)
        if (typeof load === 'function') load()
      }

      const toggleFavorite = (key) => {
        // The row moves to/from the favorites section: follow it into view.
        hiSource.current = 'keyboard'
        if (key !== undefined) memory.toggleFavorite(key)
      }

      /** `effort`: undefined = what a plain click would use; null = provider default; string = that level. */
      const choose = async (row, effort) => {
        if (busy || row === undefined) return
        const want = effort === undefined ? plannedEffort({ current, mem, row, memoryOn }) : effort === null ? undefined : effort
        // Compare effective efforts: "no explicit effort" and "the model default" are the same run.
        const unchanged = sameModel(current, row.provider.id, row.model.id) && effectiveEffort(current, row.model) === want
        if (unchanged) {
          closeMenu(true)
          return
        }
        const selection = { provider: row.provider.id, model: row.model.id }
        if (want !== undefined) selection.reasoningEffort = want
        EXPLICIT.add(selection)
        setSelectError(null)
        let result
        try {
          result = await controller.select(selection)
        } catch (error) {
          result = { ok: false, error: { code: 'client/error', message: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) } }
        }
        if (result !== null && result !== undefined && result.ok === false) {
          setSelectError(result.error)
          return
        }
        memory.recordSelection(selection)
        closeMenu(true)
      }

      const enterFlyout = () => {
        const checkedIndex = flyItems.findIndex((item) => item.kind === 'effort' && item.id === (checkedEffort === undefined ? null : checkedEffort))
        setFi(checkedIndex < 0 ? 0 : checkedIndex)
        setFlyByKeyboard(true)
        setZone('flyout')
      }

      const activateFlyItem = (index) => {
        const item = flyItems[index]
        if (item === undefined || hrow === undefined) return
        if (item.kind === 'favorite') toggleFavorite(hrow.key)
        else void choose(hrow, item.id)
      }

      const hoverRow = (row, event) => {
        const last = lastMouse.current
        const moved = event.clientX !== last.x || event.clientY !== last.y
        // A "move" without movement is the browser re-testing the pointer after a scroll or re-layout.
        // It follows the pointer while the pointer is in charge, but must not take the highlight back
        // from the keyboard.
        if (!moved && inputMode.current !== 'pointer') return
        lastMouse.current = { x: event.clientX, y: event.clientY }
        if (moved) inputMode.current = 'pointer'
        if (zone === 'flyout') setZone('list')
        if (hrow !== undefined && row.key === hrow.key) return
        hiSource.current = 'pointer'
        setHiKey(row.key)
      }

      /** The list moved under a resting pointer (wheel / touchpad): the row now under it takes the highlight. */
      const followPointer = () => {
        const point = lastMouse.current
        if (inputMode.current !== 'pointer' || point.x < 0) return
        const element = document.elementFromPoint(point.x, point.y)
        const node = element !== null && typeof element.closest === 'function' ? element.closest('.mep-row') : null
        if (node === null) return
        const index = rowRefs.current.indexOf(node)
        const row = index < 0 ? undefined : flat[index]
        if (row === undefined || (hrow !== undefined && row.key === hrow.key)) return
        hiSource.current = 'pointer'
        setHiKey(row.key)
      }

      const onKeyDown = (event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return
        inputMode.current = 'keyboard'
        hiSource.current = 'keyboard'
        const key = event.key
        const consume = () => {
          event.preventDefault()
          event.stopPropagation()
        }
        if (key === 'Escape') {
          consume()
          if (zone === 'flyout' && flyByKeyboard) setZone('list')
          else closeMenu(true)
          return
        }
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && (key === 'f' || key === 'F')) {
          consume()
          if (hrow !== undefined) toggleFavorite(hrow.key)
          return
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
          consume()
          const delta = key === 'ArrowDown' ? 1 : -1
          if (zone === 'flyout') setFi((index) => wrapIndex(index + delta, flyItems.length))
          else if (flat.length > 0) setHiKey(flat[wrapIndex(Math.max(hiSafe, 0) + delta, flat.length)].key)
          return
        }
        if (key === 'ArrowRight') {
          const input = inputRef.current
          if (zone === 'list' && hrow !== undefined && input !== null && input.selectionStart === input.value.length && input.selectionEnd === input.value.length) {
            consume()
            enterFlyout()
          }
          return
        }
        if (key === 'ArrowLeft') {
          if (zone === 'flyout') {
            consume()
            setZone('list')
          }
          return
        }
        if (key === 'Enter') {
          consume()
          if (zone === 'flyout') activateFlyItem(fi)
          else if (hrow !== undefined) void choose(hrow, undefined)
          return
        }
        if (key === 'Tab') {
          consume()
          if (zone === 'list' && hrow !== undefined) enterFlyout()
          else setZone('list')
        }
      }

      // Close when the click lands outside the trigger, the menu and the flyout.
      useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const target = event.target
          if (rootRef.current !== null && rootRef.current.contains(target)) return
          if (menuRef.current !== null && menuRef.current.contains(target)) return
          if (flyRef.current !== null && flyRef.current.contains(target)) return
          closeMenu(false)
        }
        document.addEventListener('mousedown', onDown, true)
        return () => document.removeEventListener('mousedown', onDown, true)
      }, [open, closeMenu])

      useEffect(() => {
        if (open && locked) closeMenu(false)
      }, [open, locked, closeMenu])

      useEffect(
        () => () => {
          if (leaveTimer.current !== null) clearTimeout(leaveTimer.current)
        },
        [],
      )

      // The menu stays mounted while it fades out.
      const present = open || leaving

      // Anchor the menu to the trigger. Bottom-anchored when opening upward so a shrinking list never jumps.
      useLayoutEffect(() => {
        if (!open) return undefined
        const place = (event) => {
          if (event !== undefined && event.target !== undefined && event.target !== window && event.target !== document) {
            const node = event.target
            if (menuRef.current !== null && node instanceof Node && menuRef.current.contains(node)) return
            if (flyRef.current !== null && node instanceof Node && flyRef.current.contains(node)) return
          }
          const trigger = triggerRef.current
          if (trigger === null) return
          const rect = trigger.getBoundingClientRect()
          const viewportWidth = document.documentElement.clientWidth
          const viewportHeight = window.innerHeight
          const margin = 12
          const width = Math.min(MENU_WIDTH, viewportWidth - margin * 2)
          const above = rect.top - 8 - margin
          const below = viewportHeight - rect.bottom - 8 - margin
          const downward = above < 300 && below > above
          const right = Math.min(Math.max(viewportWidth - rect.right, margin), Math.max(margin, viewportWidth - width - margin))
          const next = downward
            ? { width, right, top: rect.bottom + 8, maxHeight: Math.max(220, Math.min(560, below)) }
            : { width, right, bottom: viewportHeight - rect.top + 8, maxHeight: Math.max(220, Math.min(560, above)) }
          setPos((previous) =>
            previous !== null && previous.width === next.width && previous.right === next.right && previous.top === next.top && previous.bottom === next.bottom && previous.maxHeight === next.maxHeight
              ? previous
              : next,
          )
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open])

      useLayoutEffect(() => {
        if (open && pos !== null && inputRef.current !== null) inputRef.current.focus()
      }, [open, pos !== null])

      // Keep a keyboard / programmatic highlight visible. A pointer highlight is never scrolled to: the
      // pointer is already on that row, and moving the list under it makes the row run away.
      useLayoutEffect(() => {
        if (!open || pos === null || hiSource.current === 'pointer') return
        const row = rowRefs.current[hiSafe]
        if (row !== undefined && row !== null && typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
      }, [open, pos !== null, hiSafe, query])

      // Park the flyout beside the highlighted row; re-measured after every render (it bails out when unchanged).
      useLayoutEffect(() => {
        if (!present || pos === null || hrow === undefined) {
          if (flyPos !== null) setFlyPos(null)
          return
        }
        const menu = menuRef.current
        const row = rowRefs.current[hiSafe]
        const fly = flyRef.current
        if (menu === null || row === undefined || row === null || fly === null) return
        const menuRect = menu.getBoundingClientRect()
        const rowRect = row.getBoundingClientRect()
        // The menu fades in/out with a scaleY about the edge next to its trigger. Undo it, so the
        // flyout is parked against the real layout and not against a frame of the animation.
        const scale = menu.offsetHeight > 0 && menuRect.height > 0 ? menuRect.height / menu.offsetHeight : 1
        const originY = pos.bottom !== undefined ? menuRect.bottom : menuRect.top
        const unscale = (y) => (Math.abs(scale - 1) < 0.0005 ? y : originY + (y - originY) / scale)
        const menuTop = unscale(menuRect.top)
        const menuBottom = unscale(menuRect.bottom)
        const viewportWidth = document.documentElement.clientWidth
        const viewportHeight = window.innerHeight
        const margin = 12
        const height = fly.offsetHeight
        let left = menuRect.right + 3
        if (left + FLY_WIDTH > viewportWidth - margin) left = Math.max(margin, menuRect.left - FLY_WIDTH - 3)
        let top = unscale(rowRect.top) - 6
        top = Math.min(top, Math.min(menuBottom, viewportHeight - margin) - height)
        top = Math.max(top, Math.max(menuTop, margin))
        // Sub-pixel tolerance: measuring mid-animation adds float noise, and an exact compare could
        // re-render forever on it.
        setFlyPos((previous) => (previous !== null && Math.abs(previous.left - left) < 0.5 && Math.abs(previous.top - top) < 0.5 ? previous : { left, top }))
      })

      // Footer info (context window, modalities) for the highlighted model, after a short dwell.
      const infoKey = open && hrow !== undefined ? hrow.key : null
      const infoProvider = hrow === undefined ? '' : hrow.provider.id
      const infoModel = hrow === undefined ? '' : hrow.model.id
      useEffect(() => {
        if (infoKey === null || infoCache.has(infoKey) || typeof fetchInfo !== 'function') return undefined
        let cancelled = false
        const timer = setTimeout(() => {
          fetchInfo(infoProvider, infoModel).then(
            (value) => {
              infoCache.set(infoKey, value === undefined ? null : value)
              if (!cancelled) setInfoTick((tick) => tick + 1)
            },
            () => {
              infoCache.set(infoKey, null)
              if (!cancelled) setInfoTick((tick) => tick + 1)
            },
          )
        }, INFO_DELAY_MS)
        return () => {
          cancelled = true
          clearTimeout(timer)
        }
      }, [infoKey, infoProvider, infoModel, fetchInfo])

      if (!available) return null

      // trigger text
      const loadingCatalog = current === null && state.status === 'loading'
      const modelName = currentModel !== undefined ? currentModel.name : loadingCatalog ? t('trigger.loading') : t('trigger.fallback')
      let effortLabel
      if (currentModel !== undefined && effortList(currentModel).length > 0) {
        const id = effectiveEffort(current, currentModel)
        const found = id === undefined ? undefined : effortList(currentModel).find((level) => level.id === id)
        effortLabel = id === undefined ? t('effort.default') : found !== undefined ? found.name : id
      } else if (currentModel !== undefined) {
        effortLabel = state.retainedEffort
      }
      const triggerTitle = effortLabel === undefined ? modelName : modelName + ' · ' + effortLabel
      const triggerAria = currentModel === undefined ? modelName : effortLabel === undefined ? t('trigger.aria', { model: modelName }) : t('trigger.ariaEffort', { model: modelName, effort: effortLabel })

      const menuStyle = pos === null ? undefined : { width: pos.width, right: pos.right, top: pos.top, bottom: pos.bottom, maxHeight: pos.maxHeight }
      const activeId = zone === 'flyout' ? uid + '-fly-' + fi : hiSafe >= 0 ? uid + '-row-' + hiSafe : undefined
      const errorMessage =
        selectError !== null
          ? selectError.code === 'session/writer-held'
            ? t('error.sessionInUse')
            : t('error.action', { message: selectError.code + ': ' + selectError.message })
          : state.error !== null && state.error !== undefined && state.status === 'error'
            ? t('error.action', { message: state.error })
            : null

      const renderRow = (row, section) => {
        const isCurrent = row.key === currentKey
        const active = row.index === hiSafe
        const showEffort = (active || isCurrent) && effortList(row.model).length > 0
        let rightLabel
        if (showEffort) {
          const id = isCurrent ? effectiveEffort(current, row.model) : plannedEffort({ current, mem, row, memoryOn })
          const found = id === undefined ? undefined : effortList(row.model).find((level) => level.id === id)
          rightLabel = id === undefined ? t('effort.default') : found !== undefined ? found.name : id
        }
        return h(
          'div',
          {
            key: section.id + '|' + row.key,
            id: uid + '-row-' + row.index,
            ref: (node) => {
              rowRefs.current[row.index] = node
            },
            role: 'option',
            'aria-selected': isCurrent,
            className: 'mep-row',
            'data-active': active ? '' : undefined,
            title: row.model.name,
            onMouseMove: (event) => hoverRow(row, event),
            onClick: () => {
              void choose(row, undefined)
            },
          },
          h('span', { className: 'mep-check' }, isCurrent ? h(IconCheck, { size: 14 }) : null),
          h('span', { className: 'mep-name', 'data-provider-id': row.provider.id, 'data-model-id': row.model.id }, row.model.name),
          section.showProvider ? h('span', { className: 'mep-provider' }, row.provider.name) : null,
          showEffort
            ? h('span', { className: 'mep-row-right' }, h('span', null, rightLabel), active ? h(IconChevronRight, { size: 12 }) : null)
            : null,
        )
      }

      const renderFlyout = () => {
        if (hrow === undefined) return null
        const effortItems = flyItems.filter((item) => item.kind === 'effort')
        const providerName = hrow.provider.name
        const contextText =
          info !== undefined && info !== null && typeof info.contextWindow === 'number' && info.contextWindow > 0
            ? t('info.context', { size: formatContext(info.contextWindow, localeTag) })
            : null
        const modalityText =
          info !== undefined && info !== null && Array.isArray(info.inputModalities) && info.inputModalities.length > 0
            ? info.inputModalities.map((name) => (name === 'text' || name === 'image' ? t('info.modality.' + name) : String(name))).join(' · ')
            : null
        return h(
          'div',
          {
            ref: flyRef,
            className: 'mep-flyout',
            role: 'menu',
            'aria-label': t('effort.aria'),
            'data-leaving': leaving && !open ? '' : undefined,
            style: flyPos === null ? { left: 0, top: 0, visibility: 'hidden' } : { left: flyPos.left, top: flyPos.top },
            onKeyDown,
            // Keep keyboard focus in the search box when a flyout row is clicked (Favorite keeps the menu open).
            onMouseDown: (event) => event.preventDefault(),
          },
          effortItems.map((item, index) => {
            const checked = item.id === (checkedEffort === undefined ? null : checkedEffort)
            const active = zone === 'flyout' && fi === index
            return h(
              'div',
              {
                key: 'effort:' + String(item.id),
                id: uid + '-fly-' + index,
                role: 'menuitemradio',
                'aria-checked': checked,
                className: 'mep-fitem',
                'data-active': active ? '' : undefined,
                onMouseMove: () => {
                  if (flyByKeyboard) setFlyByKeyboard(false)
                  if (zone !== 'flyout') setZone('flyout')
                  if (fi !== index) setFi(index)
                },
                onClick: () => {
                  void choose(hrow, item.id)
                },
              },
              h('span', null, item.label),
              checked ? h(IconCheck, { size: 14 }) : null,
            )
          }),
          effortItems.length > 0 ? h('div', { key: 'sep1', className: 'mep-fsep' }) : null,
          h(
            'div',
            {
              key: 'favorite',
              id: uid + '-fly-' + effortItems.length,
              role: 'menuitem',
              className: 'mep-fitem',
              'data-active': zone === 'flyout' && fi === effortItems.length ? '' : undefined,
              onMouseMove: () => {
                if (flyByKeyboard) setFlyByKeyboard(false)
                if (zone !== 'flyout') setZone('flyout')
                if (fi !== effortItems.length) setFi(effortItems.length)
              },
              onClick: () => toggleFavorite(hrow.key),
            },
            h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, h(IconStar, { size: 13, filled: hFavorite }), hFavorite ? t('favorite.remove') : t('favorite.add')),
            h('span', { className: 'mep-kbd', 'aria-hidden': true }, h('span', null, 'CTRL'), h('span', null, 'F')),
          ),
          h('div', { key: 'sep2', className: 'mep-fsep' }),
          h(
            'div',
            { key: 'info', className: 'mep-finfo', 'data-info-tick': infoTick },
            h('div', null, contextText === null ? providerName : providerName + ' · ' + contextText),
            modalityText === null ? null : h('div', null, modalityText),
          ),
        )
      }

      const menu =
        present && pos !== null
          ? ReactDOM.createPortal(
              h(
                Fragment,
                null,
                h(
                  'div',
                  {
                    ref: menuRef,
                    className: 'mep-menu',
                    'data-side': pos.bottom !== undefined ? 'top' : 'bottom',
                    'data-leaving': leaving && !open ? '' : undefined,
                    role: 'group',
                    'aria-label': t('menu.aria'),
                    'aria-busy': busy || state.status === 'loading',
                    style: menuStyle,
                    onKeyDown,
                    onMouseDown: (event) => {
                      if (!(event.target instanceof HTMLInputElement)) event.preventDefault()
                    },
                  },
                  h(
                    'div',
                    { className: 'mep-search' },
                    h(IconSearch, { size: 16 }),
                    h('input', {
                      ref: inputRef,
                      type: 'text',
                      className: 'mep-search-input',
                      role: 'combobox',
                      'aria-expanded': true,
                      'aria-autocomplete': 'list',
                      'aria-controls': uid + '-list',
                      'aria-activedescendant': activeId,
                      'aria-label': t('search.placeholder'),
                      placeholder: t('search.placeholder'),
                      spellCheck: false,
                      autoComplete: 'off',
                      value: query,
                      onChange: (event) => {
                        setQuery(event.target.value)
                        setHiKey(null) // best match first
                        setZone('list')
                      },
                    }),
                    state.status === 'loading' ? h('span', { className: 'mep-spin', title: t('status.loading'), role: 'status' }) : null,
                    query !== ''
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'mep-search-clear',
                            'aria-label': t('search.clear'),
                            onClick: () => {
                              setQuery('')
                              setHiKey(currentKey)
                              if (inputRef.current !== null) inputRef.current.focus()
                            },
                          },
                          h(IconClose, { size: 12 }),
                        )
                      : null,
                  ),
                  errorMessage !== null
                    ? h(
                        'div',
                        { className: 'mep-strip', role: 'alert' },
                        h('span', null, errorMessage),
                        h('button', { type: 'button', onClick: () => (typeof load === 'function' ? load() : undefined) }, t('action.reload')),
                      )
                    : null,
                  (state.failures || []).map((failure) =>
                    h(
                      'div',
                      { key: 'failure:' + failure.id, className: 'mep-strip', 'data-kind': 'warning' },
                      h('span', null, t('warning.groupLoad', { name: failure.name || failure.id, message: failure.message })),
                      h('button', { type: 'button', onClick: () => (typeof load === 'function' ? load() : undefined) }, t('action.reload')),
                    ),
                  ),
                  h(
                    'div',
                    {
                      id: uid + '-list',
                      className: 'mep-list scrollable',
                      role: 'listbox',
                      'aria-label': t('menu.aria'),
                      onWheel: (event) => {
                        // Turning the wheel over the list hands the highlight back to the pointer.
                        inputMode.current = 'pointer'
                        lastMouse.current = { x: event.clientX, y: event.clientY }
                      },
                      onScroll: () => {
                        setScrollTick((tick) => (tick + 1) % 1000000)
                        followPointer()
                      },
                    },
                    built.sections.map((section) =>
                      h(
                        Fragment,
                        { key: section.id },
                        h('div', { className: 'mep-group' }, section.titleKey !== undefined ? t(section.titleKey) : section.title),
                        section.rows.map((row) => renderRow(row, section)),
                      ),
                    ),
                    flat.length === 0 ? h('div', { className: 'mep-empty', role: 'status' }, t(groups.length === 0 || query.trim() === '' ? 'empty.models' : 'search.empty')) : null,
                  ),
                ),
                renderFlyout(),
              ),
              document.body,
            )
          : null

      return h(
        'div',
        {
          ref: rootRef,
          className: 'mep-root',
          'data-model-effort-picker': '',
          onMouseDown: (event) => {
            if (event.target instanceof Element && event.target.closest('button') !== null) event.preventDefault()
          },
        },
        h(
          'button',
          {
            ref: triggerRef,
            type: 'button',
            className: 'mep-trigger',
            'aria-label': triggerAria,
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            'aria-busy': busy,
            title: triggerTitle,
            disabled: locked,
            onClick: () => {
              if (open) closeMenu(true)
              else openMenu()
            },
          },
          h(IconModel, { size: 16, className: 'mep-trigger-icon' }),
          h('span', { className: 'mep-trigger-label' }, currentModel !== undefined ? h('span', { 'data-provider-id': current.provider, 'data-model-id': current.model }, modelName) : modelName),
          effortLabel === undefined ? null : h('span', { className: 'mep-trigger-effort' }, effortLabel),
          busy ? h('span', { className: 'mep-spin', role: 'status' }) : h(IconChevronDown, { size: 14, className: 'mep-chevron', 'data-open': open ? '' : undefined }),
        ),
        menu,
      )
    }

    // ── settings rows ─────────────────────────────────────────────────────────
    const identityT = (key) => key

    function createSettingRow(memory, prefKey, titleKey, hintKey) {
      function PrefRow(props) {
        const t = props !== undefined && props !== null && typeof props.t === 'function' ? props.t : identityT
        const mem = useSyncExternalStore(memory.subscribe, memory.getSnapshot)
        const on = mem.prefs[prefKey] !== false
        return h(
          'div',
          { className: 'mep-setting' },
          h(
            'div',
            { className: 'mep-setting-row' },
            h('div', { className: 'mep-setting-text' }, h('span', { className: 'mep-setting-title' }, t(titleKey)), h('span', { className: 'mep-setting-hint' }, t(hintKey))),
            h(
              'button',
              {
                type: 'button',
                role: 'switch',
                className: 'mep-switch',
                'aria-checked': on,
                'aria-label': t(titleKey),
                onClick: () => memory.setPref(prefKey, !on),
              },
              h('span', { className: 'mep-switch-knob' }),
            ),
          ),
        )
      }
      return PrefRow
    }

    // ── plugin entry ──────────────────────────────────────────────────────────
    return {
      // `directoryFor` runs against the CALLER's context and reads `remote.session` there, so a plugin that
      // calls it must declare the same services the resolver itself injects (sessions, remote, remote.session).
      inject: ['slots', 'sessions', 'modelDirectories', 'locale', 'remote', 'remote.session'],
      apply(ctx) {
        const modelDirectories = ctx.get('modelDirectories')
        const sessions = ctx.get('sessions')
        if (modelDirectories === undefined || modelDirectories === null || sessions === undefined || sessions === null) return

        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'model-effort-picker: dictionaries')

        ctx.effect(() => {
          const style = document.createElement('style')
          style.dataset.plugin = 'dsh-model-effort-picker'
          style.dataset.pluginCss = 'dsh-model-effort-picker/picker.css'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'model-effort-picker: styles')

        const remote = createRemote()
        const memory = createMemoryStore({ storage: createStorage(), remote })
        const options = createOptionsStore(remote)

        // With the default model kept out of the config document DSH no longer announces that the default
        // changed, so the catalog this page cached (it carries the default shown for blank sessions) is
        // refreshed by hand. With the option off DSH's own settings event does it.
        const refreshCatalog = () => {
          if (!options.getSnapshot().quiet) return
          try {
            const catalog = modelDirectories.catalog
            if (catalog !== undefined && catalog !== null && typeof catalog.refresh === 'function') catalog.refresh()
          } catch (error) {
            /* internal shape changed: a blank session may show the previous default until the next reload */
          }
        }
        const patcher = createDirectoryPatcher(memory, { afterSelect: refreshCatalog })

        ctx.effect(() => {
          void memory.hydrate()
          void options.load()
          const onHide = () => {
            void memory.flush()
          }
          window.addEventListener('pagehide', onHide)
          const onVisibility = () => {
            if (document.visibilityState === 'hidden') onHide()
          }
          document.addEventListener('visibilitychange', onVisibility)
          return () => {
            window.removeEventListener('pagehide', onHide)
            document.removeEventListener('visibilitychange', onVisibility)
            memory.dispose()
          }
        }, 'model-effort-picker: memory sync')

        // Every selection path remembers, even ones that never mount this plugin's seat.
        ctx.effect(() => {
          patcher.patchExisting(modelDirectories)
          return () => patcher.restoreAll()
        }, 'model-effort-picker: remember selections')

        const getLocaleTag = () => {
          try {
            const locale = ctx.get('locale')
            const active = locale !== undefined && locale !== null && typeof locale.getLocale === 'function' ? locale.getLocale().active : undefined
            if (typeof active === 'string') return active === 'zh' ? 'zh-CN' : active
          } catch (error) {
            /* fall through to the browser locale */
          }
          return typeof navigator !== 'undefined' ? navigator.language : undefined
        }

        const injected = new Map()
        const inject = (sessionId) => {
          const controller = modelDirectories.directoryFor(sessionId)
          patcher.patch(controller)
          const available = sessions.subagentAddress(sessionId) === undefined
          const cached = injected.get(controller)
          if (cached !== undefined && cached.available === available) return cached
          const value = {
            sessionId,
            available,
            controller,
            memory,
            directory: controller.store,
            load: () => {
              if (available) controller.load().then(() => undefined, () => undefined)
            },
            get localeTag() {
              return getLocaleTag()
            },
            fetchInfo: (provider, model) => remote.info(provider, model),
          }
          injected.set(controller, value)
          return value
        }

        ctx.slots.inject(SLOT, () => {
          let dispose
          const sync = () => {
            const want = memory.getSnapshot().prefs.picker !== false
            if (want && dispose === undefined) {
              dispose = ctx.slots.register({ name: SLOT, priority: SEAT_PRIORITY, locale: NS, inject }, Picker)
            } else if (!want && dispose !== undefined) {
              dispose()
              dispose = undefined
            }
          }
          sync()
          const unsubscribe = memory.subscribe(sync)
          return () => {
            unsubscribe()
            if (dispose !== undefined) dispose()
            dispose = undefined
          }
        })

        const rows = [
          { id: 'model-effort-picker-enabled', order: 41, prefKey: 'picker', title: 'settings.picker.title', hint: 'settings.picker.hint' },
          { id: 'model-effort-picker-memory', order: 42, prefKey: 'memory', title: 'settings.memory.title', hint: 'settings.memory.hint' },
          { id: 'model-effort-picker-quiet', order: 43, prefKey: 'quiet', title: 'settings.quiet.title', hint: 'settings.quiet.hint', store: optionsAsPrefs(options) },
        ]
        for (const row of rows) {
          const Row = createSettingRow(row.store === undefined ? memory : row.store, row.prefKey, row.title, row.hint)
          ctx.slots.inject(SETTINGS_SLOT, () => ctx.slots.register({ name: SETTINGS_SLOT, id: row.id, order: row.order, locale: NS }, Row))
        }
      },
      __test: {
        NS,
        SLOT,
        SEAT_PRIORITY,
        ROUTE,
        STORAGE_KEY,
        CSS,
        ZH,
        EN,
        Picker,
        EXPLICIT,
        PATCH_MARK,
        keyOf,
        validKey,
        normalizeState,
        mergePatch,
        mergeStates,
        diffToPatch,
        isEmptyState,
        createMemoryStore,
        createOptionsStore,
        optionsAsPrefs,
        createDirectoryPatcher,
        applyMemory,
        buildSections,
        providerLabel,
        KNOWN_PROVIDER_NAMES,
        matchScore,
        plannedEffort,
        effectiveEffort,
        orderProviders,
        findModel,
        formatContext,
        createSettingRow,
        infoCache,
      },
    }
  },
})

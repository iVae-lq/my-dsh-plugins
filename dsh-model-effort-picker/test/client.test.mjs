// Offline tests for the client half of dsh-model-effort-picker: pure state helpers, the memory
// store, the picker's list/search model, the ModelDirectory.select patch, and `apply` wiring with a
// fake context. Rendering is covered separately in a real browser. Run: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/* ── load the client bundle the way the module loader would ─────────────── */
let factory = null
globalThis.window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory } } }
new Function(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))()
assert.equal(typeof factory, 'function', 'client registered a factory')

const ReactStub = {
  createElement: () => null,
  Fragment: Symbol.for('react.fragment'),
  useCallback: () => undefined,
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
  useMemo: () => undefined,
  useRef: () => undefined,
  useState: () => undefined,
  useSyncExternalStore: () => undefined,
}
const client = factory((id) => {
  if (id === 'react') return ReactStub
  if (id === 'react-dom') return {}
  throw new Error('unexpected require: ' + id)
})
const T = client.__test

/* ── fixtures ────────────────────────────────────────────────────────────── */
const efforts = (...ids) => ids.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }))
const SONNET = { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', reasoning: { efforts: efforts('low', 'medium', 'high', 'xhigh', 'max'), defaultEffort: 'medium' } }
const OPUS = { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', reasoning: { efforts: efforts('low', 'medium', 'high'), defaultEffort: 'medium' } }
const GPT = { id: 'gpt-5.5', name: 'GPT-5.5', reasoning: { efforts: efforts('low', 'medium', 'high'), defaultEffort: 'medium' } }
const GROK = { id: 'grok-4.7', name: 'Grok 4.7' } // no reasoning metadata
const NODEFAULT = { id: 'odd', name: 'Odd Model', reasoning: { efforts: efforts('low', 'high') } } // no default effort
const GROUPS = [
  { id: 'anthropic', name: 'Anthropic', models: [SONNET, OPUS] },
  { id: 'openai', name: 'OpenAI', models: [GPT, NODEFAULT] },
  { id: 'xai', name: 'xAI', models: [GROK] },
]
const emptyMem = () => T.normalizeState({})

/* ── state: normalize / merge ────────────────────────────────────────────── */
test('validKey: provider/model, model ids may contain slashes', () => {
  assert.equal(T.validKey('anthropic/claude-sonnet-5-5'), true)
  assert.equal(T.validKey('openrouter/anthropic/claude-3'), true)
  for (const bad of ['', '/x', 'x/', 'nosep', 5, null, undefined, 'a/'.padEnd(301, 'b')]) assert.equal(T.validKey(bad), false, String(bad))
  assert.equal(T.keyOf('a', 'b/c'), 'a/b/c')
})

test('normalizeState: garbage in, safe defaults out', () => {
  for (const garbage of [undefined, null, 5, 'x', [], { efforts: 5, favorites: {}, prefs: null }]) {
    assert.deepEqual(T.normalizeState(garbage), { version: 1, efforts: {}, favorites: [], prefs: { picker: true, memory: true } })
  }
})

test('normalizeState: a leftover `recent` list from an older version is ignored, not carried', () => {
  const state = T.normalizeState({ efforts: { 'a/b': 'high' }, recent: ['a/b', 'c/d'], favorites: ['a/b'] })
  assert.deepEqual(Object.keys(state).sort(), ['efforts', 'favorites', 'prefs', 'version'])
  assert.deepEqual(state.favorites, ['a/b'])
  assert.equal(T.mergePatch(state, { recent: ['x/y'] }).recent, undefined, 'a stale patch cannot bring it back')
})

test('normalizeState: validates, dedupes and caps', () => {
  const state = T.normalizeState({
    efforts: { 'a/b': 'high', 'a/c': null, bad: 'low', 'a/d': 5, 'a/e': '', 'a/f': 'x'.repeat(65) },
    favorites: ['a/1', 'a/1', 'bad', 'a/2', ...Array.from({ length: 150 }, (_, i) => 'p/f' + i)],
    prefs: { picker: false, memory: 'no' },
  })
  assert.deepEqual(state.efforts, { 'a/b': 'high', 'a/c': null })
  assert.equal(state.favorites.length, 100)
  assert.deepEqual(state.favorites.slice(0, 2), ['a/1', 'a/2'], 'first-seen order, duplicates and bad keys dropped')
  assert.deepEqual(state.prefs, { picker: false, memory: true }, 'only a real boolean false disables')
})

test('normalizeState: at most 500 effort entries', () => {
  const efforts500 = Object.fromEntries(Array.from({ length: 600 }, (_, i) => ['p/m' + i, 'high']))
  assert.equal(Object.keys(T.normalizeState({ efforts: efforts500 }).efforts).length, 500)
})

test('mergePatch: efforts merge, nulls kept, lists replaced, prefs partial, input untouched', () => {
  const base = T.normalizeState({ efforts: { 'a/b': 'low' }, favorites: ['a/b'] })
  const frozen = JSON.stringify(base)
  const next = T.mergePatch(base, { efforts: { 'a/b': null, 'c/d': 'max', bad: 'x' }, prefs: { memory: false, junk: 1 } })
  assert.equal(JSON.stringify(base), frozen)
  assert.deepEqual(next.efforts, { 'a/b': null, 'c/d': 'max' })
  assert.deepEqual(next.favorites, ['a/b'], 'absent list is kept')
  assert.deepEqual(T.mergePatch(base, { favorites: ['c/d', 'c/d', 'bad'] }).favorites, ['c/d'], 'a present list replaces, normalized')
  assert.deepEqual(next.prefs, { picker: true, memory: false })
  assert.deepEqual(T.mergePatch(base, undefined), base)
})

test('mergePatch: the oldest effort entries are evicted past 500', () => {
  let state = emptyMem()
  state = T.mergePatch(state, { efforts: Object.fromEntries(Array.from({ length: 500 }, (_, i) => ['p/m' + i, 'low'])) })
  state = T.mergePatch(state, { efforts: { 'p/new': 'high' } })
  const keys = Object.keys(state.efforts)
  assert.equal(keys.length, 500)
  assert.equal(keys.includes('p/m0'), false, 'oldest dropped')
  assert.equal(state.efforts['p/new'], 'high')
})

test('mergeStates / diffToPatch / isEmptyState', () => {
  const server = T.normalizeState({ efforts: { 'a/b': 'high' }, favorites: ['a/b'], prefs: { picker: false } })
  const local = T.normalizeState({ efforts: { 'a/b': 'low', 'c/d': 'max' }, favorites: ['c/d'] })
  const merged = T.mergeStates(server, local)
  assert.deepEqual(merged.efforts, { 'a/b': 'high', 'c/d': 'max' }, 'server wins conflicts, local-only is kept')
  assert.deepEqual(merged.favorites, ['a/b', 'c/d'])
  assert.equal(merged.prefs.picker, false)
  assert.equal(T.diffToPatch(merged, merged), null)
  assert.deepEqual(T.diffToPatch(server, merged).efforts, { 'c/d': 'max' })
  assert.equal(T.isEmptyState(emptyMem()), true)
  assert.equal(T.isEmptyState(server), false)
})

/* ── memory store ────────────────────────────────────────────────────────── */
function fakeStorage(initial) {
  let value = initial === undefined ? null : initial
  return { writes: 0, get: () => value, set(next) { value = next; this.writes += 1 }, peek: () => value }
}
function fakeRemote({ server = emptyMem(), failTimes = 0 } = {}) {
  const calls = []
  let failures = failTimes
  let current = server
  return {
    calls,
    async load() { return current },
    async patch(patch) {
      calls.push(patch)
      if (failures > 0) { failures -= 1; throw new Error('offline') }
      current = T.mergePatch(current, patch)
      return current
    },
    server: () => current,
  }
}
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

test('store: writes local storage at once, batches remote patches', async () => {
  const storage = fakeStorage()
  const remote = fakeRemote()
  const store = T.createMemoryStore({ storage, remote, debounceMs: 5 })
  store.setEffort('a/b', 'high')
  store.setEffort('c/d', 'low')
  store.toggleFavorite('a/b')
  assert.equal(JSON.parse(storage.peek()).efforts['a/b'], 'high', 'persisted locally before any network')
  assert.equal(remote.calls.length, 0)
  await tick(30)
  assert.equal(remote.calls.length, 1, 'one batched call')
  assert.deepEqual(remote.calls[0].efforts, { 'a/b': 'high', 'c/d': 'low' })
  assert.deepEqual(remote.calls[0].favorites, ['a/b'])
  assert.equal('recent' in remote.calls[0], false, 'nothing about a recent list is ever sent')
  store.dispose()
})

test('store: no-op writes do not emit or hit storage', () => {
  const storage = fakeStorage()
  const store = T.createMemoryStore({ storage, remote: null })
  let emitted = 0
  store.subscribe(() => { emitted += 1 })
  store.setEffort('a/b', 'high')
  const writes = storage.writes
  store.setEffort('a/b', 'high')
  store.setPref('picker', true)
  store.setEffort('bad', 'high')
  store.setEffort('a/b', '')
  assert.equal(storage.writes, writes, 'nothing was written')
  assert.equal(emitted, 1, 'only the first real change emitted')
  store.dispose()
})

test('store: recordSelection remembers effort (null for none)', () => {
  const store = T.createMemoryStore({ storage: fakeStorage(), remote: null })
  store.recordSelection({ provider: 'a', model: 'b', reasoningEffort: 'high' })
  store.recordSelection({ provider: 'c', model: 'd' })
  store.recordSelection({ provider: 'a', model: 'b', reasoningEffort: 'low' })
  const s = store.getSnapshot()
  assert.deepEqual(s.efforts, { 'a/b': 'low', 'c/d': null })
  assert.equal('recent' in s, false)
  store.dispose()
})

test('store: favorites toggle and prefs', () => {
  const store = T.createMemoryStore({ storage: fakeStorage(), remote: null })
  assert.equal(store.toggleFavorite('a/b'), true)
  assert.equal(store.toggleFavorite('c/d'), true)
  assert.equal(store.toggleFavorite('a/b'), false)
  assert.deepEqual(store.getSnapshot().favorites, ['c/d'])
  assert.equal(store.toggleFavorite('bad'), false)
  store.setPref('memory', false)
  store.setPref('nonsense', false)
  assert.deepEqual(store.getSnapshot().prefs, { picker: true, memory: false })
  store.dispose()
})

test('store: seed only fills what is unknown', () => {
  const store = T.createMemoryStore({ storage: fakeStorage(), remote: null })
  store.seed('a/b', 'max')
  store.seed('a/b', 'low')
  assert.equal(store.getSnapshot().efforts['a/b'], 'max')
  store.seed('c/d', null)
  assert.deepEqual(store.getSnapshot().efforts, { 'a/b': 'max', 'c/d': null })
  store.dispose()
})

test('store: starts from local storage and tolerates corrupt content', () => {
  const good = fakeStorage(JSON.stringify({ efforts: { 'a/b': 'high' } }))
  assert.equal(T.createMemoryStore({ storage: good, remote: null }).getSnapshot().efforts['a/b'], 'high')
  for (const raw of ['{not json', '[]', '"x"', 'null']) {
    assert.deepEqual(T.createMemoryStore({ storage: fakeStorage(raw), remote: null }).getSnapshot().efforts, {})
  }
})

test('store.hydrate: host state wins, local-only knowledge is pushed back', async () => {
  const storage = fakeStorage(JSON.stringify({ efforts: { 'a/b': 'low', 'c/d': 'max' }, favorites: ['c/d'] }))
  const remote = fakeRemote({ server: T.normalizeState({ efforts: { 'a/b': 'high' } }) })
  const store = T.createMemoryStore({ storage, remote, debounceMs: 5 })
  await store.hydrate()
  const s = store.getSnapshot()
  assert.deepEqual(s.efforts, { 'a/b': 'high', 'c/d': 'max' })
  assert.deepEqual(s.favorites, ['c/d'])
  await tick(30)
  assert.deepEqual(remote.server().efforts, { 'a/b': 'high', 'c/d': 'max' }, 'host learned the local-only entry')
  assert.deepEqual(JSON.parse(storage.peek()).efforts, { 'a/b': 'high', 'c/d': 'max' })
  store.dispose()
})

test('store.hydrate: first run with an empty host adopts local state; edits made before it resolves survive', async () => {
  const storage = fakeStorage(JSON.stringify({ efforts: { 'a/b': 'low' } }))
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const remote = fakeRemote({ server: T.normalizeState({ efforts: { 'x/y': 'high' } }) })
  const slowLoad = remote.load
  remote.load = async () => { await gate; return slowLoad() }
  const store = T.createMemoryStore({ storage, remote, debounceMs: 5 })
  const hydrating = store.hydrate()
  store.setEffort('a/b', 'max') // user acts while the host answer is in flight
  release()
  await hydrating
  assert.equal(store.getSnapshot().efforts['a/b'], 'max', 'newer local edit is not clobbered')
  assert.equal(store.getSnapshot().efforts['x/y'], 'high')
  await tick(30)
  assert.equal(remote.server().efforts['a/b'], 'max')
  store.dispose()
})

test('store: a failed send is retried with the newer values on top, never dropped', async () => {
  const remote = fakeRemote({ failTimes: 1 })
  const store = T.createMemoryStore({ storage: fakeStorage(), remote, debounceMs: 1 })
  store.setEffort('a/b', 'low')
  await tick(15)
  assert.equal(remote.calls.length, 1, 'first attempt failed')
  store.setEffort('a/b', 'high') // newer value arrives before the retry
  await store.flush()
  assert.equal(remote.server().efforts['a/b'], 'high')
  store.dispose()
})

test('store.dispose: no timers or sends after dispose', async () => {
  const remote = fakeRemote({ failTimes: 5 })
  const store = T.createMemoryStore({ storage: fakeStorage(), remote, debounceMs: 1 })
  store.setEffort('a/b', 'low')
  await tick(10)
  const callsBefore = remote.calls.length
  store.dispose()
  await tick(30)
  store.setEffort('a/b', 'high')
  await tick(30)
  assert.ok(remote.calls.length <= callsBefore + 1, 'at most the single final flush')
})

/* ── catalog helpers ─────────────────────────────────────────────────────── */
test('orderProviders keeps the account/official providers first', () => {
  const ordered = T.orderProviders([{ id: 'x' }, { id: 'deepseek-official' }, { id: 'y' }, { id: 'deepseek-account' }])
  assert.deepEqual(ordered.map((g) => g.id), ['deepseek-account', 'deepseek-official', 'x', 'y'])
})

test('matchScore: prefix < substring < subsequence; every token must match', () => {
  const row = (name, id = name, provider = 'Anthropic') => ({ model: { name, id }, provider: { name: provider } })
  const prefix = T.matchScore('claude', row('Claude Sonnet 5.5'))
  const inside = T.matchScore('sonnet', row('Claude Sonnet 5.5'))
  const subseq = T.matchScore('csn', row('Claude Sonnet 5.5'))
  assert.ok(prefix >= 0 && prefix < inside && inside < subseq, `${prefix} < ${inside} < ${subseq}`)
  assert.equal(T.matchScore('zzz', row('Claude Sonnet 5.5')), -1)
  assert.ok(T.matchScore('sonnet 5', row('Claude Sonnet 5.5')) >= 0)
  assert.equal(T.matchScore('sonnet gpt', row('Claude Sonnet 5.5')), -1, 'all tokens must match')
  assert.equal(T.matchScore('', row('x')), 0)
  assert.ok(T.matchScore('anthro', row('Claude Sonnet 5.5')) >= 0, 'provider name is searchable')
})

test('buildSections: favorites first, then providers; no duplicates; flat order matches', () => {
  const { sections, flat } = T.buildSections({
    groups: GROUPS,
    favorites: ['openai/gpt-5.5', 'ghost/none', 'openai/gpt-5.5', 'xai/grok-4.7'],
    query: '',
  })
  assert.deepEqual(sections.map((s) => s.id), ['favorites', 'g:anthropic', 'g:openai'])
  assert.deepEqual(sections[0].rows.map((r) => r.key), ['openai/gpt-5.5', 'xai/grok-4.7'], 'unknown and repeated favorites are skipped')
  assert.deepEqual(sections[1].rows.map((r) => r.key), ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5'], 'favorites are not repeated under their provider')
  assert.deepEqual(sections[2].rows.map((r) => r.key), ['openai/odd'])
  assert.deepEqual(flat.map((r) => r.index), flat.map((_, i) => i))
  assert.equal(new Set(flat.map((r) => r.key)).size, flat.length)
  assert.equal(sections[0].showProvider, true, 'a favorite row names its provider')
  assert.ok(sections.slice(1).every((s) => s.showProvider !== true))
})

test('buildSections: there is no "recent" section, whatever a caller passes; an empty catalog gives nothing', () => {
  const many = { id: 'p', name: 'P', models: Array.from({ length: 9 }, (_, i) => ({ id: 'm' + i, name: 'M' + i })) }
  const built = T.buildSections({ groups: [many], favorites: [], recent: many.models.map((m) => 'p/' + m.id), query: '' })
  assert.deepEqual(built.sections.map((s) => s.id), ['g:p'])
  assert.equal(built.flat.length, 9)
  assert.ok(!('group.recent' in T.ZH) && !('group.recent' in T.EN), 'no dictionary entry is left over')
  assert.deepEqual(T.buildSections({ groups: [], favorites: [], query: '' }), { sections: [], flat: [] })
})

test('buildSections: a query lists matches grouped by provider, best first', () => {
  const built = T.buildSections({ groups: GROUPS, favorites: ['openai/gpt-5.5'], query: '5.5' })
  assert.deepEqual(built.sections.map((s) => s.id), ['g:anthropic', 'g:openai'], 'favorites are not special while searching')
  assert.deepEqual(built.flat.map((r) => r.key), ['anthropic/claude-sonnet-5-5', 'anthropic/claude-opus-5-5', 'openai/gpt-5.5'])
  assert.deepEqual(T.buildSections({ groups: GROUPS, favorites: [], query: 'zzzz' }).flat, [])
})

test('plannedEffort: current model keeps its effort, others use memory only when still offered', () => {
  const row = (model, group) => ({ key: group + '/' + model.id, provider: { id: group, name: group }, model })
  const mem = T.normalizeState({ efforts: { 'anthropic/claude-opus-5-5': 'high', 'openai/gpt-5.5': 'max', 'anthropic/claude-sonnet-5-5': null } })
  const current = { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'xhigh' }
  const plan = (r, memoryOn = true) => T.plannedEffort({ current, mem, row: r, memoryOn })
  assert.equal(plan(row(SONNET, 'anthropic')), 'xhigh', 'current model: current effort')
  assert.equal(plan(row(OPUS, 'anthropic')), 'high', 'remembered')
  assert.equal(plan(row(OPUS, 'anthropic'), false), 'medium', 'memory off: model default')
  assert.equal(plan(row(GPT, 'openai')), 'medium', 'remembered max is not offered by gpt: default')
  assert.equal(plan(row(GROK, 'xai')), undefined, 'model without reasoning')
  assert.equal(plan(row(NODEFAULT, 'openai')), undefined, 'no default effort: provider default')
  assert.equal(T.effectiveEffort({ provider: 'a', model: 'b' }, SONNET), 'medium')
  assert.equal(T.effectiveEffort(null, SONNET), 'medium')
  assert.equal(T.effectiveEffort({ reasoningEffort: 'low' }, SONNET), 'low')
})

test('providerLabel: the bare id is prettified, a configured name is respected, the account group is localized', () => {
  const t = (key) => ({ 'provider.account': 'DeepSeek 账号' })[key] ?? key
  const label = (id, name = id) => T.providerLabel({ id, name }, t)
  assert.equal(label('anthropic'), 'Anthropic')
  assert.equal(label('openai'), 'OpenAI')
  assert.equal(label('xai'), 'xAI')
  assert.equal(label('github-copilot'), 'GitHub Copilot')
  assert.equal(label('my-own_provider'), 'My Own Provider', 'unknown ids are title-cased word by word')
  assert.equal(label('anthropic', 'Acme Claude Gateway'), 'Acme Claude Gateway', 'a name the user configured wins')
  assert.equal(label('anthropic', 'anthropic-eu'), 'anthropic-eu', 'only a name that IS the id is replaced')
  assert.equal(label('Weird Id'), 'Weird Id', 'ids that are not plain lowercase tokens are left alone')
  assert.equal(label('deepseek-account', 'whatever'), 'DeepSeek 账号')
  assert.equal(T.providerLabel({ id: 'groq' }, t), 'Groq', 'a missing name falls back to the id')
  assert.equal(label('constructor'), 'Constructor', 'prototype members are not treated as known names')
  assert.equal(label('__proto__'), '__proto__')
  assert.deepEqual(Object.keys(T.ZH).filter((key) => key === 'provider.account'), ['provider.account'])
})

test('buildSections: titles and provider names come from labelOf, and the raw provider id is still searchable', () => {
  const groups = [{ id: 'anthropic', name: 'anthropic', models: [{ id: 'm1', name: 'Alpha' }] }, { id: 'openai', name: 'openai', models: [{ id: 'm2', name: 'Beta' }] }]
  const labelOf = (group) => ({ anthropic: 'Anthropic', openai: 'OpenAI' })[group.id]
  const plain = T.buildSections({ groups, favorites: ['openai/m2'], query: '', labelOf })
  assert.deepEqual(plain.sections.map((s) => s.title ?? s.titleKey), ['group.favorites', 'Anthropic'])
  assert.equal(plain.sections[0].rows[0].provider.name, 'OpenAI', 'favorites rows show the pretty provider')
  const byId = T.buildSections({ groups, favorites: [], query: 'anthropic', labelOf: (group) => 'Acme ' + group.id })
  assert.deepEqual(byId.flat.map((r) => r.key), ['anthropic/m1'], 'the raw id still matches when the label differs')
  const byLabel = T.buildSections({ groups, favorites: [], query: 'acme ope', labelOf: (group) => 'Acme ' + group.id })
  assert.deepEqual(byLabel.flat.map((r) => r.key), ['openai/m2'], 'and so does the label')
  assert.deepEqual(T.buildSections({ groups, favorites: [], query: '' }).sections.map((s) => s.title), ['anthropic', 'openai'], 'without labelOf the catalog names are used')
})

test('formatContext falls back to the raw number', () => {
  assert.match(T.formatContext(1_000_000, 'en'), /1/)
  assert.equal(typeof T.formatContext(128000, 'not a locale!!'), 'string')
})

/* ── patching ModelDirectory.select ──────────────────────────────────────── */
function fakeDirectory(current, groups = GROUPS) {
  const listeners = new Set()
  let snap = { current, groups, failures: [], status: 'ready', pending: null, error: null }
  const directory = {
    calls: [],
    result: { ok: true, value: undefined },
    store: {
      getSnapshot: () => snap,
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    },
    async select(selection) {
      directory.calls.push(selection)
      if (directory.result.ok) snap = { ...snap, current: { ...selection } }
      for (const fn of [...listeners]) fn()
      return directory.result
    },
    setCurrent(next) { snap = { ...snap, current: next }; for (const fn of [...listeners]) fn() },
  }
  return directory
}

test('patch: a plain switch gets the remembered effort; same-model and explicit picks are untouched', async () => {
  const memory = T.createMemoryStore({ storage: fakeStorage(JSON.stringify({ efforts: { 'anthropic/claude-opus-5-5': 'high', 'anthropic/claude-sonnet-5-5': 'xhigh' } })), remote: null })
  const patcher = T.createDirectoryPatcher(memory)
  const dir = fakeDirectory({ provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'xhigh' })
  patcher.patch(dir)
  assert.notEqual(dir[T.PATCH_MARK], undefined)

  // native list click: model only
  await dir.select({ provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.deepEqual(dir.calls.at(-1), { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'high' })

  // /model command: model + the model's default effort -> still treated as automatic
  await dir.select({ provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' })
  assert.equal(dir.calls.at(-1).reasoningEffort, 'xhigh')

  // slider: same model, explicit effort -> untouched
  await dir.select({ provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'low' })
  assert.equal(dir.calls.at(-1).reasoningEffort, 'low')

  // a deliberate non-default choice on another model is never rewritten
  await dir.select({ provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'low' })
  assert.equal(dir.calls.at(-1).reasoningEffort, 'low')

  // picker-built selections are marked explicit
  const explicit = { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' }
  T.EXPLICIT.add(explicit)
  await dir.select(explicit)
  assert.equal(dir.calls.at(-1).reasoningEffort, 'medium')
  memory.dispose()
})

test('patch: afterSelect runs after successful selections only, and cannot break the caller', async (t) => {
  const warnings = []
  t.mock.method(console, 'warn', (message) => { warnings.push(String(message)) })
  const memory = T.createMemoryStore({ storage: fakeStorage(), remote: null })
  const seen = []
  const patcher = T.createDirectoryPatcher(memory, { afterSelect: (selection) => { seen.push(selection); throw new Error('hook failed') } })
  const dir = fakeDirectory({ provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' })
  patcher.patch(dir)
  dir.result = { ok: false, error: { code: 'x', message: 'nope' } }
  assert.equal((await dir.select({ provider: 'openai', model: 'gpt-5.5' })).ok, false)
  assert.deepEqual(seen, [], 'not after a failure')
  dir.result = { ok: true, value: undefined }
  const result = await dir.select({ provider: 'openai', model: 'gpt-5.5', reasoningEffort: 'high' })
  assert.equal(result.ok, true, 'the caller still gets the result')
  assert.deepEqual(seen, [{ provider: 'openai', model: 'gpt-5.5', reasoningEffort: 'high' }])
  assert.ok(warnings.some((w) => /after-select hook failed/.test(w)))
  memory.dispose()
})

test('patch: records only successful selections; failures are returned untouched', async () => {
  const memory = T.createMemoryStore({ storage: fakeStorage(), remote: null })
  const patcher = T.createDirectoryPatcher(memory)
  const dir = fakeDirectory({ provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'medium' })
  patcher.patch(dir)
  dir.result = { ok: false, error: { code: 'x', message: 'nope' } }
  const failed = await dir.select({ provider: 'openai', model: 'gpt-5.5', reasoningEffort: 'high' })
  assert.equal(failed.ok, false)
  assert.equal(memory.getSnapshot().efforts['openai/gpt-5.5'], undefined)
  dir.result = { ok: true, value: undefined }
  await dir.select({ provider: 'openai', model: 'gpt-5.5', reasoningEffort: 'high' })
  assert.equal(memory.getSnapshot().efforts['openai/gpt-5.5'], 'high')
  memory.dispose()
})

test('patch: memory switch off disables the rewrite but still records', async () => {
  const memory = T.createMemoryStore({ storage: fakeStorage(JSON.stringify({ efforts: { 'anthropic/claude-opus-5-5': 'high' }, prefs: { memory: false } })), remote: null })
  const patcher = T.createDirectoryPatcher(memory)
  const dir = fakeDirectory({ provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'xhigh' })
  patcher.patch(dir)
  await dir.select({ provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.deepEqual(dir.calls.at(-1), { provider: 'anthropic', model: 'claude-opus-5-5' })
  memory.dispose()
})

test('patch: a remembered effort the model no longer offers is ignored', async () => {
  const memory = T.createMemoryStore({ storage: fakeStorage(JSON.stringify({ efforts: { 'openai/gpt-5.5': 'max' } })), remote: null })
  const patcher = T.createDirectoryPatcher(memory)
  const dir = fakeDirectory({ provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'xhigh' })
  patcher.patch(dir)
  await dir.select({ provider: 'openai', model: 'gpt-5.5' })
  assert.deepEqual(dir.calls.at(-1), { provider: 'openai', model: 'gpt-5.5' })
  memory.dispose()
})

test('patch: idempotent, seeds the current model, restores on unload', async () => {
  const memory = T.createMemoryStore({ storage: fakeStorage(), remote: null })
  const patcher = T.createDirectoryPatcher(memory)
  const dir = fakeDirectory({ provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'max' })
  const original = dir.select
  patcher.patch(dir)
  const wrapper = dir.select
  patcher.patch(dir)
  assert.equal(dir.select, wrapper, 'second patch is a no-op')
  assert.equal(memory.getSnapshot().efforts['anthropic/claude-sonnet-5-5'], 'max', 'current selection is seeded')
  patcher.restoreAll()
  assert.equal(dir.select, original)
  assert.equal(dir[T.PATCH_MARK], undefined)
  patcher.patch(null)
  patcher.patch({})
  memory.dispose()
})

test('patch: class-style directories get their prototype method back (own property removed)', () => {
  class Directory {
    constructor() { this.store = fakeDirectory(null).store }
    async select() { return { ok: true, value: undefined } }
  }
  const memory = T.createMemoryStore({ storage: fakeStorage(), remote: null })
  const patcher = T.createDirectoryPatcher(memory)
  const dir = new Directory()
  patcher.patch(dir)
  assert.equal(Object.prototype.hasOwnProperty.call(dir, 'select'), true)
  patcher.restoreAll()
  assert.equal(Object.prototype.hasOwnProperty.call(dir, 'select'), false)
  assert.equal(dir.select, Directory.prototype.select)
  memory.dispose()
})

test('patchExisting tolerates a resolver without the internal shape', () => {
  const memory = T.createMemoryStore({ storage: fakeStorage(), remote: null })
  const patcher = T.createDirectoryPatcher(memory)
  patcher.patchExisting({})
  patcher.patchExisting({ live: { directories: { values: null } } })
  const dir = fakeDirectory(null)
  patcher.patchExisting({ live: { directories: { values: new Set([dir]) } } })
  assert.notEqual(dir[T.PATCH_MARK], undefined)
  patcher.restoreAll()
  memory.dispose()
})

/* ── host-only options ───────────────────────────────────────────────────── */
test('options store: quiet defaults to on and unknown until the host answers', async () => {
  const store = T.createOptionsStore({ options: async () => ({ quiet: false }) })
  assert.deepEqual(store.getSnapshot(), { quiet: true, known: false })
  await store.load()
  assert.deepEqual(store.getSnapshot(), { quiet: false, known: true })
  const silent = T.createOptionsStore(null)
  await silent.load()
  await silent.setQuiet(false)
  assert.deepEqual(silent.getSnapshot(), { quiet: true, known: false }, 'nobody confirmed the change, so the switch must not claim it took effect')
})

test('options store: a host that cannot be reached keeps the default and never throws', async () => {
  const store = T.createOptionsStore({ options: async () => { throw new Error('offline') } })
  await store.load()
  assert.deepEqual(store.getSnapshot(), { quiet: true, known: false })
  const nonsense = T.createOptionsStore({ options: async () => null })
  await nonsense.load()
  assert.deepEqual(nonsense.getSnapshot(), { quiet: true, known: false })
})

test('options store: setQuiet is optimistic, settles on the host answer and rolls back on failure', async () => {
  const seen = []
  let answer = { quiet: false }
  const store = T.createOptionsStore({ options: async (patch) => { seen.push(patch); if (answer === 'fail') throw new Error('nope'); return answer } })
  const states = []
  store.subscribe(() => states.push(store.getSnapshot().quiet))
  const pending = store.setQuiet(false)
  assert.equal(store.getSnapshot().quiet, false, 'optimistic')
  await pending
  assert.deepEqual(seen, [{ quiet: false }])
  assert.deepEqual(store.getSnapshot(), { quiet: false, known: true })
  answer = 'fail'
  await store.setQuiet(true)
  assert.equal(store.getSnapshot().quiet, false, 'a failed write rolls back')
  answer = { quiet: true }
  await store.setQuiet(true)
  assert.equal(store.getSnapshot().quiet, true)
  await store.setQuiet('yes')
  await store.setQuiet(undefined)
  assert.equal(store.getSnapshot().quiet, true, 'non-booleans are ignored')
  assert.ok(states.length >= 3)
})

test('options store: a throwing listener does not break the others', async (t) => {
  t.mock.method(console, 'error', () => {})
  const store = T.createOptionsStore(null)
  let called = 0
  store.subscribe(() => { throw new Error('bad listener') })
  store.subscribe(() => { called += 1 })
  await store.setQuiet(false)
  assert.equal(called >= 1, true)
})

test('optionsAsPrefs: the settings row shape, with a snapshot that is stable between changes', async () => {
  const store = T.createOptionsStore({ options: async (patch) => ({ quiet: patch === undefined ? true : patch.quiet }) })
  const prefs = T.optionsAsPrefs(store)
  const first = prefs.getSnapshot()
  assert.deepEqual(first, { prefs: { quiet: true } })
  assert.equal(prefs.getSnapshot(), first, 'same reference while nothing changed (useSyncExternalStore requirement)')
  prefs.setPref('other', false)
  prefs.setPref('quiet', false)
  await tick(5)
  assert.deepEqual(prefs.getSnapshot(), { prefs: { quiet: false } })
  assert.notEqual(prefs.getSnapshot(), first)
})

/* ── apply wiring ────────────────────────────────────────────────────────── */
function fakeContext({ directory, subagent = false, quiet } = {}) {
  const effects = []
  const registrations = []
  const injections = []
  const dictionaries = []
  const styleNodes = []
  const listeners = []
  globalThis.document = {
    head: { appendChild: (node) => styleNodes.push(node) },
    createElement: () => ({ dataset: {}, remove() { this.removed = true }, textContent: '' }),
    addEventListener: (type) => listeners.push(['document', type]),
    removeEventListener: () => undefined,
    visibilityState: 'visible',
  }
  globalThis.window.addEventListener = (type) => listeners.push(['window', type])
  globalThis.window.removeEventListener = () => undefined
  globalThis.window.localStorage = { getItem: () => null, setItem: () => undefined }
  globalThis.window.fetch = async (url) => ({ ok: true, json: async () => (String(url).endsWith('/options') && quiet !== undefined ? { ok: true, options: { quiet } } : { ok: true, state: {} }) })
  const resolver = {
    live: { directories: { values: directory === undefined ? [] : [directory] } },
    directoryFor: () => directory,
    catalog: { refreshCalls: 0, refresh() { this.refreshCalls += 1 } },
  }
  const ctx = {
    get: (name) => ({ modelDirectories: resolver, sessions: { subagentAddress: () => (subagent ? { id: 'x' } : undefined) }, locale: ctx.locale }[name]),
    effect(fn) { const dispose = fn(); effects.push(dispose); return () => dispose?.() },
    locale: { register: (ns, dict) => { dictionaries.push([ns, dict]); return () => undefined }, getLocale: () => ({ active: 'zh' }) },
    slots: {
      inject(key, callback) { const dispose = callback(); injections.push({ key, dispose }); return () => dispose?.() },
      register(options, component) {
        const entry = { options, component, disposed: false }
        registrations.push(entry)
        return () => { entry.disposed = true }
      },
    },
  }
  return { ctx, registrations, injections, dictionaries, styleNodes, listeners, effects, resolver }
}

test('exports the loader contract', () => {
  // `remote` / `remote.session` are required because ModelDirectoryResolver.directoryFor reads them on the caller's ctx.
  assert.deepEqual(client.inject, ['slots', 'sessions', 'modelDirectories', 'locale', 'remote', 'remote.session'])
  assert.equal(typeof client.apply, 'function')
  assert.equal(T.SLOT, 'conversation.input.model')
  assert.ok(T.SEAT_PRIORITY < 0, 'a single slot renders the LOWEST priority number; the native seat is 0, so this must be negative')
})

test('motion: the pointer is tracked without delay or smoothing; only open/close animate, never blocking input', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(!/HOVER_INTENT|hoverTimer|clearHover/.test(source), 'no hover-intent timer: the highlight follows the pointer event itself')
  assert.ok(!/data-glide|prevFlyPos|SCROLL_QUIET/.test(source), 'no flyout glide: it trails the pointer')
  const css = T.CSS
  for (const name of ['mep-menu-in', 'mep-menu-out', 'mep-fly-in', 'mep-fly-out']) assert.match(css, new RegExp('@keyframes ' + name + '\\{'), name)
  // a leaving menu ignores the pointer, so the fade-out can never swallow a click meant for what is underneath
  assert.match(css, /\.mep-menu\[data-leaving\]\{pointer-events:none/)
  assert.match(css, /\.mep-flyout\[data-leaving\]\{pointer-events:none/)
  // rows and flyout items carry an explicit `transition:none` (so a global / skin rule cannot add one): a
  // fading highlight leaves a ghost on the row the pointer just left, a glide makes the flyout trail it
  for (const selector of ['\\.mep-row', '\\.mep-fitem']) {
    const base = css.match(new RegExp('(?:^|\\n)' + selector + '\\{([^}]*)\\}'))
    assert.ok(base, selector + ' base rule found')
    assert.match(base[1], /(?:^|;)transition:none(?:;|$)/, selector + ' pins transition:none')
    const active = css.match(new RegExp('(?:^|\\n)' + selector + '\\[data-active\\]\\{([^}]*)\\}'))
    assert.ok(active && !/transition/.test(active[1]), selector + ' active rule found and does not re-enable one')
  }
  assert.match(css, /\.mep-menu,\.mep-flyout\{[^}]*;transition:none\}/, 'menu and flyout pin transition:none (their position is never animated)')
  assert.ok(!/transition:\s*(?:top|left|all)/.test(css.replace(/\.mep-chevron[^}]*\}/, '')), 'nothing transitions position')
  // reduced motion switches the open/close animation off
  const reduced = css.split('@media (prefers-reduced-motion:reduce)').slice(1).join('\n')
  assert.match(reduced, /\.mep-menu\[data-leaving\],\.mep-flyout\[data-leaving\]\{animation:none\}/)
})

test('size: a compact portrait menu (340 wide, 300..480 tall) with a 184 wide flyout, sized from the content', () => {
  assert.equal(T.MENU_WIDTH, 340, 'a typical row needs ~300px, the widest realistic one ~360px (the name ellipsizes)')
  assert.equal(T.MENU_MAX_HEIGHT, 480)
  assert.equal(T.FLY_WIDTH, 184, 'its widest row ("Unfavorite" + CTRL F) needs ~160px plus 12px of padding')
  // the shape stays portrait and pleasant at both ends of the height range, and the flyout stays slimmer than the menu
  assert.ok(T.MENU_WIDTH / T.MENU_MAX_HEIGHT >= 0.62 && T.MENU_WIDTH / T.MENU_MAX_HEIGHT <= 0.8, 'ratio at full height')
  assert.ok(T.MENU_MIN_HEIGHT >= 290, 'a short result list must still hold the tallest usual flyout (290px)')
  assert.ok(T.MENU_MIN_HEIGHT < T.MENU_MAX_HEIGHT)
  assert.ok(T.FLY_WIDTH < T.MENU_WIDTH * 0.6)
  assert.match(T.CSS, new RegExp('\\.mep-flyout\\{[^}]*width:' + T.FLY_WIDTH + 'px'), 'the stylesheet uses the same flyout width')
  // one line each in the flyout footer, so its height does not change from model to model
  assert.match(T.CSS, /\.mep-finfo>div\{[^}]*white-space:nowrap/)
  assert.match(T.CSS, /\.mep-finfo>div\{[^}]*text-overflow:ellipsis/)
})

test('apply: registers the seat below the native priority, the settings rows, dictionaries and styles', () => {
  const dir = fakeDirectory({ provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'max' })
  const f = fakeContext({ directory: dir })
  client.apply(f.ctx)
  const seat = f.registrations.find((r) => r.options.name === 'conversation.input.model')
  assert.ok(seat, 'seat registered')
  assert.ok(seat.options.priority < 0)
  assert.equal(seat.options.locale, T.NS)
  assert.equal(typeof seat.options.inject, 'function')
  assert.equal(seat.component, T.Picker)
  const rows = f.registrations.filter((r) => r.options.name === 'settings.general.item')
  assert.deepEqual(rows.map((r) => r.options.id).sort(), ['model-effort-picker-enabled', 'model-effort-picker-memory', 'model-effort-picker-quiet'])
  assert.ok(rows.every((r) => r.options.locale === T.NS && typeof r.options.order === 'number'))
  assert.equal(f.dictionaries[0][0], T.NS)
  assert.deepEqual(Object.keys(f.dictionaries[0][1]).sort(), ['en', 'zh'])
  assert.deepEqual(Object.keys(T.ZH).sort(), Object.keys(T.EN).sort(), 'dictionaries have the same keys')
  assert.equal(f.styleNodes.length, 1)
  assert.notEqual(dir[T.PATCH_MARK], undefined, 'existing directories are patched on load')
})

test('apply: the seat inject returns the picker props and patches that session directory', () => {
  const dir = fakeDirectory({ provider: 'anthropic', model: 'claude-sonnet-5-5' })
  const f = fakeContext({ directory: dir })
  client.apply(f.ctx)
  const seat = f.registrations.find((r) => r.options.name === 'conversation.input.model')
  const props = seat.options.inject('session-1')
  assert.equal(props.available, true)
  assert.equal(props.controller, dir)
  assert.equal(props.directory, dir.store)
  assert.equal(typeof props.load, 'function')
  assert.equal(typeof props.fetchInfo, 'function')
  assert.equal(typeof props.memory.getSnapshot, 'function')
  assert.equal(props.localeTag, 'zh-CN')
  const sub = fakeContext({ directory: fakeDirectory(null), subagent: true })
  client.apply(sub.ctx)
  const subProps = sub.registrations.find((r) => r.options.name === 'conversation.input.model').options.inject('child')
  assert.equal(subProps.available, false, 'addressed subagent sessions expose no picker')
})

test('apply: turning the picker preference off removes the seat so the native one returns', () => {
  const f = fakeContext({ directory: fakeDirectory(null) })
  client.apply(f.ctx)
  const seat = f.registrations.find((r) => r.options.name === 'conversation.input.model')
  assert.equal(seat.disposed, false)
  const row = f.registrations.find((r) => r.options.id === 'model-effort-picker-enabled')
  assert.ok(row)
  // flip the preference through the same store the settings row uses
  const props = seat.options.inject('s')
  props.memory.setPref('picker', false)
  assert.equal(seat.disposed, true, 'seat disposed')
  props.memory.setPref('picker', true)
  const reseated = f.registrations.filter((r) => r.options.name === 'conversation.input.model')
  assert.equal(reseated.length, 2)
  assert.equal(reseated[1].disposed, false)
  assert.ok(reseated[1].options.priority < 0)
})

test('apply: a successful switch refreshes the catalog cache while the default model is kept out of the config', async () => {
  const dir = fakeDirectory({ provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'max' })
  const f = fakeContext({ directory: dir })
  client.apply(f.ctx)
  await tick(5)
  assert.equal(f.resolver.catalog.refreshCalls, 0)
  await dir.select({ provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.equal(f.resolver.catalog.refreshCalls, 1, 'blank sessions must see the new default')
  dir.result = { ok: false, error: { code: 'x', message: 'nope' } }
  await dir.select({ provider: 'openai', model: 'gpt-5.5' })
  assert.equal(f.resolver.catalog.refreshCalls, 1, 'not after a failed switch')
})

test('apply: with the option off DSH announces the change itself, so nothing is refreshed by hand', async () => {
  const dir = fakeDirectory({ provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'max' })
  const f = fakeContext({ directory: dir, quiet: false })
  client.apply(f.ctx)
  await tick(10)
  await dir.select({ provider: 'anthropic', model: 'claude-opus-5-5' })
  assert.equal(f.resolver.catalog.refreshCalls, 0)
})

test('apply: a resolver without a catalog is tolerated', async () => {
  const dir = fakeDirectory({ provider: 'anthropic', model: 'claude-sonnet-5-5' })
  const f = fakeContext({ directory: dir })
  delete f.resolver.catalog
  client.apply(f.ctx)
  assert.equal((await dir.select({ provider: 'anthropic', model: 'claude-opus-5-5' })).ok, true)
})

test('apply: unloading restores patched directories and unregisters', () => {
  const dir = fakeDirectory({ provider: 'anthropic', model: 'claude-sonnet-5-5' })
  const original = dir.select
  const f = fakeContext({ directory: dir })
  client.apply(f.ctx)
  assert.notEqual(dir.select, original)
  for (const dispose of f.effects) dispose?.()
  for (const injection of f.injections) injection.dispose?.()
  assert.equal(dir.select, original, 'select restored')
  assert.equal(f.registrations.filter((r) => r.options.name === 'conversation.input.model').every((r) => r.disposed), true)
})

test('apply: does nothing when required services are missing', () => {
  const f = fakeContext({ directory: fakeDirectory(null) })
  f.ctx.get = () => undefined
  client.apply(f.ctx)
  assert.equal(f.registrations.length, 0)
})

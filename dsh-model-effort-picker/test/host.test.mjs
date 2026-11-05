// Offline tests for dsh-model-effort-picker's host half: the pure state functions, the persistent
// store (real temp dirs plus fault-injecting fs fakes), and the route handler driven with fake
// req/res objects, once more behind a real node:http server. Run: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import * as realFs from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import {
  ROUTE, apply, createHandler, createStateStore, inject, mergePatch, normalizeState, resolveDshHome
} from '../index.js'

const { mkdtemp, readFile, readdir, rm, writeFile } = realFs

const STATE_URL = `${ROUTE}/state`
const INFO_URL = `${ROUTE}/info`
const DEFAULT_STATE = { version: 1, efforts: {}, recent: [], favorites: [], prefs: { picker: true, memory: true } }
const UNAVAILABLE = { ok: false, error: 'unavailable' }

/** What the llm service returns for a model (shape of dsh-llm's normalizeModelInfo): far more than we expose. */
const LLM_INFO = {
  provider: 'anthropic',
  id: 'claude-opus-4',
  name: 'Claude Opus 4',
  inputModalities: ['text', 'image'],
  context: { contextWindow: 200000 },
  defaultMaxTokens: 32000,
  reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
  systemPromptUpdate: 'in-history',
  toolUpdate: 'addition-only'
}

/* ── helpers ──────────────────────────────────────────────────────────── */

/** Freeze recursively: any write to it throws in strict mode, which is how purity is proven. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mep-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** Swallow console.warn for one test (restored when it ends) and expose what was logged. */
function captureWarnings(t) {
  const mocked = t.mock.method(console, 'warn', () => {})
  return () => mocked.mock.calls.map((call) => String(call.arguments[0]))
}

const fsError = (code, message = code) => Object.assign(new Error(message), { code })

/** `node:fs/promises` that records every call and delegates to the real one unless overridden. */
function fakeFs(overrides = {}) {
  const calls = []
  const fs = {}
  for (const name of ['readFile', 'writeFile', 'mkdir', 'rename', 'rm']) {
    fs[name] = async (...args) => {
      calls.push({ name, args })
      return (overrides[name] ?? realFs[name])(...args)
    }
  }
  return { fs, calls }
}

async function waitFor(check, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) assert.fail('timed out waiting for a condition')
    await delay(10)
  }
}

const validKey = (key) => {
  const slash = typeof key === 'string' ? key.indexOf('/') : -1
  return slash > 0 && slash < key.length - 1 && key.length <= 300
}

/** An independent statement of the State invariants, so the implementation is not checked against itself. */
function assertValidState(state) {
  assert.deepEqual(Object.keys(state).sort(), ['efforts', 'favorites', 'prefs', 'recent', 'version'])
  assert.equal(state.version, 1)
  const entries = Object.entries(state.efforts)
  assert.ok(entries.length <= 500, 'efforts cap')
  for (const [key, value] of entries) {
    assert.ok(validKey(key), `valid effort key: ${key}`)
    assert.ok(value === null || (typeof value === 'string' && value.length > 0 && value.length <= 64), `valid effort for ${key}`)
  }
  for (const [list, max] of [[state.recent, 8], [state.favorites, 100]]) {
    assert.ok(Array.isArray(list) && list.length <= max, 'list cap')
    assert.equal(new Set(list).size, list.length, 'list is unique')
    assert.ok(list.every(validKey), 'list keys are valid')
  }
  assert.deepEqual(Object.keys(state.prefs).sort(), ['memory', 'picker'])
  assert.equal(typeof state.prefs.picker, 'boolean')
  assert.equal(typeof state.prefs.memory, 'boolean')
}

/** A fake llm service; `resolve` produces what `resolveModelInfo` yields. */
function fakeLlm(resolveInfo) {
  const calls = []
  return {
    calls,
    resolveModelInfo: async (...args) => {
      calls.push(args)
      return resolveInfo(...args)
    }
  }
}

function fakeReq({ method = 'POST', url = STATE_URL, body, chunks, type = 'application/json', headers } = {}) {
  const parts = chunks ?? (body === undefined ? [] : [typeof body === 'string' ? body : JSON.stringify(body)])
  const req = Readable.from(parts.map((part) => Buffer.from(part)))
  req.method = method
  req.url = url
  req.headers = { ...(type === null ? {} : { 'content-type': type }), ...headers }
  return req
}

function fakeRes() {
  const res = { status: 0, headers: null, body: null, ended: 0 }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers }
  res.end = (text) => { res.ended += 1; res.body = JSON.parse(text) }
  return res
}

/** Drive one request through a handler; every response must be JSON, uncacheable and sent exactly once. */
async function run(handler, opts) {
  const res = fakeRes()
  await handler(fakeReq(opts), res)
  assert.equal(res.ended, 1, 'exactly one response')
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
  return res
}

/** A handler over a real store in a temp dir. `llm` is shorthand for `getLlm: () => llm`. */
async function withHandler(fn, { llm, getLlm = () => llm, fence = () => true, ...rest } = {}) {
  return withTempDir(async (root) => {
    const dir = join(root, 'dsh-model-effort-picker')
    const store = createStateStore({ dir })
    const handler = createHandler({ fence, store, getLlm, ...rest })
    try {
      return await fn({ handler, store, dir, call: (opts) => run(handler, opts) })
    } finally {
      await store.flush() // never remove the directory under a write that is still running
    }
  })
}

/** Valid JSON of exactly `total` bytes. */
function pad(total) {
  const head = '{"pad":"'
  const tail = '"}'
  return head + 'x'.repeat(total - head.length - tail.length) + tail
}

/* ── exports and DSH home ─────────────────────────────────────────────── */

test('exports and the route prefix', () => {
  assert.deepEqual(inject, ['webServer', 'connection'])
  assert.equal(ROUTE, '/dsh-model-effort-picker')
  for (const fn of [apply, createHandler, createStateStore, mergePatch, normalizeState, resolveDshHome]) {
    assert.equal(typeof fn, 'function')
  }
})

test('resolveDshHome follows the harness convention', () => {
  const home = resolve(tmpdir(), 'dsh-fake-home')
  const fallback = join(home, '.dsh')
  assert.equal(resolveDshHome({}, home), fallback)
  assert.equal(resolveDshHome(null, home), fallback)
  assert.equal(resolveDshHome({ DSH_HOME: '' }, home), fallback)
  assert.equal(resolveDshHome({ DSH_HOME: '  \t ' }, home), fallback, 'blank counts as unset')
  assert.equal(resolveDshHome({ DSH_HOME: 42 }, home), fallback, 'non-string values are ignored')

  const custom = resolve(tmpdir(), 'custom-dsh')
  assert.equal(resolveDshHome({ DSH_HOME: `  ${custom}  ` }, home), custom, 'trimmed')
  assert.equal(resolveDshHome({ DSH_HOME: '~' }, home), home)
  assert.equal(resolveDshHome({ DSH_HOME: '~/data/dsh' }, home), join(home, 'data', 'dsh'))
  assert.equal(resolveDshHome({ DSH_HOME: '~\\data\\dsh' }, home), join(home, 'data\\dsh'))
  assert.equal(resolveDshHome({ DSH_HOME: '~other/x' }, home), resolve('~other/x'), 'only ~, ~/ and ~\\ expand')
  assert.equal(resolveDshHome({ DSH_HOME: 'rel/dsh' }, home), resolve('rel/dsh'))
  assert.ok(isAbsolute(resolveDshHome({ DSH_HOME: 'rel/dsh' }, home)))
  assert.ok(isAbsolute(resolveDshHome()), 'the defaults read the real environment')
})

/* ── normalizeState ───────────────────────────────────────────────────── */

test('normalizeState: garbage in, default state out', () => {
  const garbage = [undefined, null, 0, 42, 10n, '', 'text', true, false, [], [1, 2], () => {}, Symbol('s')]
  for (const value of garbage) assert.deepEqual(normalizeState(value), DEFAULT_STATE, typeof value)
  assert.deepEqual(normalizeState({}), DEFAULT_STATE)
  assert.deepEqual(normalizeState({ efforts: 5, recent: 'x', favorites: {}, prefs: [], version: 'z' }), DEFAULT_STATE)
  assert.equal(normalizeState({ version: 99 }).version, 1, 'the version is ours to stamp')
})

test('normalizeState: effort keys are provider/model, split at the first slash', () => {
  const invalid = ['', '/', '//', '/m', '//m', '/p/m', 'p/', 'noslash']
  const valid = ['openai/gpt-5', 'openrouter/anthropic/claude-3.5-sonnet', 'a/b/c/', 'p//m', 'ollama/llama3:8b']
  const efforts = {}
  for (const key of invalid) efforts[key] = 'low'
  for (const key of valid) efforts[key] = 'high'
  const result = normalizeState({ efforts }).efforts
  assert.deepEqual(Object.keys(result), valid, 'model ids may contain slashes; both halves must be non-empty')
  assert.ok(Object.values(result).every((value) => value === 'high'))

  const lists = normalizeState({ recent: [5, null, undefined, {}, ['a/b'], true, 'a/b'], favorites: ['/a/b', 'a/'] })
  assert.deepEqual(lists.recent, ['a/b'], 'non-string entries are dropped')
  assert.deepEqual(lists.favorites, [])
})

test('normalizeState: effort values are short non-empty strings or null; keys stop at 300 chars', () => {
  const efforts = {
    'a/low': 'low', 'a/null': null, 'a/max': 'x'.repeat(64),
    'a/empty': '', 'a/long': 'x'.repeat(65), 'a/num': 3, 'a/bool': true, 'a/obj': {}, 'a/arr': ['low'], 'a/undef': undefined
  }
  const result = normalizeState({ efforts }).efforts
  assert.deepEqual(Object.keys(result), ['a/low', 'a/null', 'a/max'])
  assert.equal(result['a/null'], null, 'null means "provider default" and is kept')

  const k300 = `p/${'m'.repeat(298)}`
  const k301 = `${k300}m`
  assert.equal(k300.length, 300)
  assert.deepEqual(Object.keys(normalizeState({ efforts: { [k300]: 'low', [k301]: 'low' } }).efforts), [k300])
})

test('normalizeState: at most 500 efforts, counted over valid entries only', () => {
  const many = {}
  for (let i = 0; i < 600; i += 1) many[`p/m${i}`] = 'low'
  const kept = Object.keys(normalizeState({ efforts: many }).efforts)
  assert.equal(kept.length, 500)
  assert.deepEqual([kept[0], kept[499]], ['p/m0', 'p/m499'], 'the first 500 in insertion order')

  const mixed = {}
  for (let i = 0; i < 520; i += 1) {
    mixed[`bad${i}`] = 'low'
    mixed[`p/m${i}`] = 'low'
  }
  const keptMixed = Object.keys(normalizeState({ efforts: mixed }).efforts)
  assert.equal(keptMixed.length, 500)
  assert.equal(keptMixed[499], 'p/m499', 'dropped entries do not eat the quota')
})

test('normalizeState: recent and favorites are unique, ordered and capped', () => {
  const keys = (n) => Array.from({ length: n }, (_, i) => `k/${i}`)
  assert.deepEqual(normalizeState({ recent: ['a/1', 'b/2', 'a/1', 'bad', 7, null, 'c/3', 'b/2'] }).recent, ['a/1', 'b/2', 'c/3'])
  assert.deepEqual(normalizeState({ recent: keys(12) }).recent, keys(8), 'the most recent 8 survive')
  const doubled = keys(10).flatMap((key) => [key, key])
  assert.deepEqual(normalizeState({ recent: doubled }).recent, keys(8), 'duplicates go before the cap applies')
  assert.deepEqual(normalizeState({ favorites: keys(150) }).favorites, keys(100))
  assert.deepEqual(normalizeState({ favorites: ['z/1', 'a/1', 'z/1', 'm/1'] }).favorites, ['z/1', 'a/1', 'm/1'], 'order kept, not sorted')
})

test('normalizeState: prefs default to true and only accept booleans', () => {
  assert.deepEqual(normalizeState({ prefs: { picker: false } }).prefs, { picker: false, memory: true })
  assert.deepEqual(normalizeState({ prefs: { memory: false } }).prefs, { picker: true, memory: false })
  assert.deepEqual(normalizeState({ prefs: { picker: 'false', memory: 0 } }).prefs, { picker: true, memory: true })
  assert.deepEqual(normalizeState({ prefs: { picker: null, memory: [] } }).prefs, { picker: true, memory: true })
  assert.deepEqual(normalizeState({ prefs: { picker: false, memory: false, extra: true } }).prefs, { picker: false, memory: false })
  assert.deepEqual(normalizeState({ prefs: 'off' }).prefs, { picker: true, memory: true })
})

test('normalizeState: hostile keys cannot pollute prototypes', () => {
  const raw = JSON.parse(
    '{"efforts":{"__proto__":"high","constructor":"low","__proto__/m":"high"},"recent":["__proto__","constructor"],"prefs":{"__proto__":{"picker":false}}}'
  )
  const state = normalizeState(raw)
  assert.deepEqual(Object.keys(state.efforts), ['__proto__/m'], 'a valid key always holds a slash, so it is never a prototype member')
  assert.equal(state.efforts['__proto__/m'], 'high')
  assert.equal(Object.getPrototypeOf(state.efforts), Object.prototype)
  assert.deepEqual(state.recent, [])
  assert.equal(state.prefs.picker, true)
  assert.equal({}.picker, undefined)
  assert.equal({}.high, undefined)
})

test('normalizeState: idempotent, fresh and non-mutating', () => {
  const messy = deepFreeze({
    efforts: { 'a/b': 'low', bad: 'x' }, recent: ['a/b', 'a/b'], favorites: ['a/b'], prefs: { picker: false, x: 1 }, extra: true
  })
  const first = normalizeState(messy) // a frozen input would make any write throw
  assert.deepEqual(normalizeState(first), first)
  assert.notEqual(first.efforts, messy.efforts)
  assertValidState(first)

  const a = normalizeState()
  const b = normalizeState()
  a.efforts['x/y'] = 'high'
  a.recent.push('x/y')
  a.prefs.picker = false
  assert.deepEqual(b, DEFAULT_STATE, 'results share no structure')
})

/* ── mergePatch ───────────────────────────────────────────────────────── */

const BASE = normalizeState({
  efforts: { 'openai/gpt-5': 'low', 'anthropic/opus': 'high' },
  recent: ['openai/gpt-5', 'anthropic/opus'],
  favorites: ['anthropic/opus'],
  prefs: { picker: true, memory: true }
})

test('mergePatch: efforts merge per key and null survives', () => {
  const merged = mergePatch(BASE, { efforts: { 'openai/gpt-5': 'max', 'x/y': 'min' } })
  assert.deepEqual(merged.efforts, { 'openai/gpt-5': 'max', 'anthropic/opus': 'high', 'x/y': 'min' })
  assert.deepEqual(merged.recent, BASE.recent)
  assert.deepEqual(merged.favorites, BASE.favorites)
  assert.deepEqual(merged.prefs, BASE.prefs)

  const nulled = mergePatch(BASE, { efforts: { 'openai/gpt-5': null, 'new/model': null } })
  assert.equal(nulled.efforts['openai/gpt-5'], null, 'null overrides an earlier effort')
  assert.ok(Object.hasOwn(nulled.efforts, 'new/model'))
  assert.equal(nulled.efforts['new/model'], null, 'null is kept as a value, not treated as "delete"')
  assert.equal(nulled.efforts['anthropic/opus'], 'high')

  const partial = mergePatch(BASE, { efforts: { 'good/one': 'low', bad: 'low', 'good/two': 5, 'good/three': 'high' } })
  assert.deepEqual(partial.efforts, { ...BASE.efforts, 'good/one': 'low', 'good/three': 'high' }, 'bad entries are dropped, good ones applied')
})

test('mergePatch: recent and favorites are replaced, not merged', () => {
  const replaced = mergePatch(BASE, { recent: ['z/1'] })
  assert.deepEqual(replaced.recent, ['z/1'])
  assert.deepEqual(replaced.favorites, BASE.favorites, 'an absent list is left alone')

  assert.deepEqual(mergePatch(BASE, { favorites: [] }).favorites, [], 'an empty list clears')
  const ignored = mergePatch(BASE, { recent: 'nope', favorites: { 'a/b': 1 } })
  assert.deepEqual(ignored.recent, BASE.recent, 'a non-array is no list at all')
  assert.deepEqual(ignored.favorites, BASE.favorites)

  const cleaned = mergePatch(BASE, { recent: ['b/1', 'b/1', 'bad', 'c/2', ...Array.from({ length: 12 }, (_, i) => `d/${i}`)] })
  assert.equal(cleaned.recent.length, 8)
  assert.deepEqual(cleaned.recent.slice(0, 3), ['b/1', 'c/2', 'd/0'], 'patch lists are normalized like any other')
})

test('mergePatch: prefs merge per boolean', () => {
  assert.deepEqual(mergePatch(BASE, { prefs: { memory: false } }).prefs, { picker: true, memory: false })
  const off = mergePatch(BASE, { prefs: { picker: false } })
  assert.deepEqual(off.prefs, { picker: false, memory: true })
  assert.deepEqual(mergePatch(off, { prefs: { memory: false } }).prefs, { picker: false, memory: false }, 'earlier prefs survive')
  assert.deepEqual(mergePatch(off, { prefs: { picker: 'yes', memory: 1 } }).prefs, off.prefs, 'non-booleans are ignored')
  assert.deepEqual(mergePatch(off, { prefs: 'x' }).prefs, off.prefs)
  assert.deepEqual(mergePatch(off, { prefs: {} }).prefs, off.prefs)
})

test('mergePatch: pure, and tolerant of a non-object patch or state', () => {
  const frozenState = deepFreeze(structuredClone(BASE))
  const frozenPatch = deepFreeze({ efforts: { 'x/y': 'low' }, recent: ['x/y'], favorites: ['x/y'], prefs: { picker: false } })
  const merged = mergePatch(frozenState, frozenPatch) // any write to either input would throw
  assertValidState(merged)
  assert.notEqual(merged.efforts, frozenState.efforts)
  assert.notEqual(merged.recent, frozenPatch.recent)

  for (const patch of [undefined, null, 'x', 5, true, [], [{ efforts: { 'a/b': 'low' } }]]) {
    assert.deepEqual(mergePatch(BASE, patch), BASE, `a ${Array.isArray(patch) ? 'array' : typeof patch} patch changes nothing`)
  }
  assert.deepEqual(mergePatch(BASE, { version: 5, junk: 1 }), BASE, 'unknown fields are ignored')
  assert.deepEqual(mergePatch('junk', { efforts: { 'a/b': 'low' } }), { ...DEFAULT_STATE, efforts: { 'a/b': 'low' } })
  assert.deepEqual(mergePatch(undefined, undefined), DEFAULT_STATE)
})

test('mergePatch: new efforts keys are refused beyond 500, existing ones still update', () => {
  const entries = (n) => Array.from({ length: n }, (_, i) => [`p/m${i}`, 'low'])

  const full = normalizeState({ efforts: Object.fromEntries(entries(500)) })
  const merged = mergePatch(full, { efforts: { 'new/model': 'high', 'p/m0': 'max' } })
  assert.equal(Object.keys(merged.efforts).length, 500)
  assert.equal(Object.hasOwn(merged.efforts, 'new/model'), false, 'no room for a new key')
  assert.equal(merged.efforts['p/m0'], 'max', 'but an existing one may change')

  const almost = normalizeState({ efforts: Object.fromEntries(entries(499)) })
  const filled = mergePatch(almost, { efforts: { 'n/1': 'a', 'n/2': 'b', 'n/3': 'c' } })
  assert.equal(Object.keys(filled.efforts).length, 500)
  assert.equal(filled.efforts['n/1'], 'a', 'the first new key takes the last slot')
  assert.equal(Object.hasOwn(filled.efforts, 'n/2'), false)
})

test('normalizeState and mergePatch survive junk in every field', () => {
  const junk = [
    undefined, null, true, false, 0, -1, 1.5, NaN, '', 'a/b', 'x'.repeat(1000), [], [null], ['a/b', 7, {}], [[]], [[['a/b']]],
    {}, { a: 1 }, { 'a/b': {} }, { 'a/b': ['x'] }, { 'a/b': 'low', 'c/d': null, bad: 1 }
  ]
  for (const field of ['efforts', 'recent', 'favorites', 'prefs', 'version']) {
    for (const value of junk) {
      const raw = { [field]: value }
      assertValidState(normalizeState(raw))
      assertValidState(mergePatch(normalizeState(raw), raw))
      assertValidState(mergePatch(raw, raw))
    }
  }
})

/* ── state store ──────────────────────────────────────────────────────── */

const nestedDir = (root) => join(root, 'nested', 'dsh-model-effort-picker')

test('store: constructing and reading never touch the disk beyond one read, and a missing file is normal', async (t) => {
  const warnings = captureWarnings(t)
  await withTempDir(async (root) => {
    const dir = nestedDir(root)
    const { fs, calls } = fakeFs()
    const store = createStateStore({ dir, fs })
    assert.equal(calls.length, 0, 'constructing does no I/O')
    assert.deepEqual(await store.read(), DEFAULT_STATE)
    assert.deepEqual(await store.read(), DEFAULT_STATE)
    await store.flush()
    assert.deepEqual(calls.map((call) => call.name), ['readFile'], 'lazy and cached: one read, no writes')
    assert.equal(existsSync(dir), false, 'reading never creates the directory')
    assert.deepEqual(warnings(), [], 'a missing file is not worth a warning')
  })
})

test('store: createStateStore requires a directory', () => {
  assert.throws(() => createStateStore(), TypeError)
  assert.throws(() => createStateStore({}), TypeError)
  assert.throws(() => createStateStore({ dir: '' }), TypeError)
  assert.throws(() => createStateStore({ dir: 7 }), TypeError)
})

test('store: patches roundtrip through the file and survive a restart', async () => {
  await withTempDir(async (root) => {
    const dir = nestedDir(root) // missing parents are created on the first write
    const store = createStateStore({ dir })
    const merged = await store.patch({
      efforts: { 'openai/gpt-5': 'high', 'openrouter/anthropic/claude-3.5-sonnet': null },
      recent: ['openai/gpt-5'],
      favorites: ['openai/gpt-5'],
      prefs: { memory: false }
    })
    assertValidState(merged)
    await store.flush()
    const file = join(dir, 'state.json')
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), merged)

    const reborn = createStateStore({ dir })
    assert.deepEqual(await reborn.read(), merged, 'a new process sees the same memory')

    await reborn.patch({ efforts: { 'anthropic/opus': 'low' }, prefs: { picker: false } })
    await reborn.flush()
    const third = await createStateStore({ dir }).read()
    assert.deepEqual(third.efforts, {
      'openai/gpt-5': 'high', 'openrouter/anthropic/claude-3.5-sonnet': null, 'anthropic/opus': 'low'
    })
    assert.deepEqual(third.prefs, { picker: false, memory: false })
    assert.deepEqual(third.recent, ['openai/gpt-5'], 'lists the patch did not carry are untouched')
  })
})

test('store: a corrupt or foreign file reads as the default state and is overwritten by the next patch', async (t) => {
  const warnings = captureWarnings(t)
  await withTempDir(async (root) => {
    const unparsable = [
      ['truncated JSON', '{"efforts": {"a/b": "lo'], ['plain text', 'hello'], ['empty file', ''], ['control bytes', '\u0000\u0001\u0002']
    ]
    for (const [label, content] of unparsable) {
      const dir = join(root, label.replaceAll(' ', '-'))
      await realFs.mkdir(dir)
      await writeFile(join(dir, 'state.json'), content)
      const store = createStateStore({ dir })
      assert.deepEqual(await store.read(), DEFAULT_STATE, label)
      assert.ok(warnings().at(-1).includes('unparsable'), `${label}: logged, not thrown`)
    }
    assert.equal(warnings().length, unparsable.length)

    for (const content of ['[1,2,3]', 'null', '"x"', '42', '{"efforts":[1],"prefs":7}']) {
      const dir = join(root, 'shape')
      await realFs.mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'state.json'), content)
      assert.deepEqual(await createStateStore({ dir }).read(), DEFAULT_STATE, content)
    }

    // The next patch replaces the bad file with a valid one.
    const dir = join(root, 'truncated-JSON')
    const store = createStateStore({ dir })
    await store.patch({ efforts: { 'a/b': 'low' } })
    await store.flush()
    assert.deepEqual((await createStateStore({ dir }).read()).efforts, { 'a/b': 'low' })
  })
})

test('store: a file with a BOM or partly invalid content is accepted and sanitized', async () => {
  await withTempDir(async (root) => {
    const file = join(root, 'state.json')
    await writeFile(file, `\uFEFF${JSON.stringify({ efforts: { 'a/b': 'low' } })}`)
    assert.deepEqual((await createStateStore({ dir: root }).read()).efforts, { 'a/b': 'low' }, 'BOM tolerated')

    await writeFile(file, JSON.stringify({
      version: 7,
      efforts: { 'a/b': 'low', bad: 'x', 'c/d': 7, 'e/f': null },
      recent: ['a/b', 'a/b', 'zzz'],
      favorites: 'nope',
      prefs: { picker: false, memory: 'yes' }
    }))
    assert.deepEqual(await createStateStore({ dir: root }).read(), {
      version: 1,
      efforts: { 'a/b': 'low', 'e/f': null },
      recent: ['a/b'],
      favorites: [],
      prefs: { picker: false, memory: true }
    })
  })
})

test('store: an unreadable file is tolerated and logged, a missing one is not', async (t) => {
  const warnings = captureWarnings(t)
  const { fs } = fakeFs({ readFile: async () => { throw fsError('EACCES', 'access denied') } })
  assert.deepEqual(await createStateStore({ dir: 'unused', fs }).read(), DEFAULT_STATE)
  assert.equal(warnings().length, 1)
  assert.match(warnings()[0], /access denied/)

  const missing = fakeFs({ readFile: async () => { throw fsError('ENOENT') } })
  assert.deepEqual(await createStateStore({ dir: 'unused', fs: missing.fs }).read(), DEFAULT_STATE)
  assert.equal(warnings().length, 1, 'ENOENT stays silent')
})

test('store: the first load is shared and read() hands out copies', async () => {
  await withTempDir(async (root) => {
    const file = join(root, 'state.json')
    await writeFile(file, JSON.stringify({ efforts: { 'a/b': 'low' } }))
    const { fs, calls } = fakeFs()
    const store = createStateStore({ dir: root, fs })
    const [first] = await Promise.all([store.read(), store.read(), store.patch({ prefs: { picker: false } }), store.read()])
    assert.equal(calls.filter((call) => call.name === 'readFile').length, 1, 'concurrent callers share one load')

    await writeFile(file, JSON.stringify({ efforts: { 'a/b': 'high' } }))
    assert.equal((await store.read()).efforts['a/b'], 'low', 'cached: later disk edits are not re-read')

    first.efforts['a/b'] = 'tampered'
    first.recent.push('x/y')
    const again = await store.read()
    assert.equal(again.efforts['a/b'], 'low', 'mutating a result cannot corrupt the cache')
    assert.deepEqual(again.recent, [])
    await store.flush()
  })
})

test('store: writes go to a temp file in the same directory and are renamed into place', async () => {
  await withTempDir(async (root) => {
    const dir = nestedDir(root)
    const { fs, calls } = fakeFs()
    const store = createStateStore({ dir, fs })
    await store.patch({ prefs: { picker: false } })
    await store.flush()

    const file = join(dir, 'state.json')
    const tmp = join(dir, `state.json.${process.pid}.tmp`)
    assert.deepEqual(calls.map((call) => call.name), ['readFile', 'mkdir', 'writeFile', 'rename'])
    assert.deepEqual(calls[1].args, [dir, { recursive: true }], 'mkdir -p first')
    assert.equal(calls[2].args[0], tmp, 'the content is never written to state.json directly')
    assert.deepEqual(calls[3].args, [tmp, file])
    assert.deepEqual(await readdir(dir), ['state.json'], 'no temp file is left behind')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).prefs.picker, false)
  })
})

test('store: a failing write is logged once and never reaches the caller; the memory survives and is retried', async (t) => {
  const warnings = captureWarnings(t)
  await withTempDir(async (root) => {
    const dir = nestedDir(root)
    let failing = true
    const { fs } = fakeFs({
      writeFile: async (...args) => {
        if (failing) throw fsError('ENOSPC', 'disk full')
        return realFs.writeFile(...args)
      }
    })
    const store = createStateStore({ dir, fs })
    const merged = await store.patch({ efforts: { 'a/b': 'low' } }) // must not throw
    await store.flush()
    assert.equal(merged.efforts['a/b'], 'low')
    assert.equal(warnings().length, 1, 'one warning per failure')
    assert.match(warnings()[0], /disk full/)
    assert.deepEqual((await store.read()).efforts, { 'a/b': 'low' }, 'the in-memory state keeps the change')
    assert.deepEqual(await readdir(dir), [], 'no partial file on disk')

    failing = false
    await store.patch({ efforts: { 'c/d': 'high' } })
    await store.flush()
    assert.deepEqual(
      JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).efforts,
      { 'a/b': 'low', 'c/d': 'high' },
      'the next write carries the change that failed earlier'
    )
    assert.equal(warnings().length, 1, 'no new warning once writes work again')
  })
})

test('store: a failing rename removes its temp file, and a failing cleanup is swallowed', async (t) => {
  const warnings = captureWarnings(t)
  await withTempDir(async (root) => {
    const dir = nestedDir(root)
    const { fs, calls } = fakeFs({ rename: async () => { throw new Error('rename exploded') } })
    const store = createStateStore({ dir, fs })
    assert.deepEqual((await store.patch({ prefs: { memory: false } })).prefs, { picker: true, memory: false })
    await store.flush()
    assert.equal(warnings().length, 1)
    assert.match(warnings()[0], /rename exploded/)
    assert.deepEqual(await readdir(dir), [], 'neither state.json nor a temp file')
    assert.deepEqual(calls.at(-1).args, [join(dir, `state.json.${process.pid}.tmp`), { force: true }], 'cleanup targets the temp file')

    const stubborn = fakeFs({
      writeFile: async () => { throw new Error('write exploded') },
      rm: async () => { throw new Error('rm exploded') }
    })
    const other = createStateStore({ dir: join(root, 'other'), fs: stubborn.fs })
    await other.patch({ prefs: { memory: false } })
    await other.flush()
    assert.equal(warnings().length, 2, 'only the write failure is reported')
  })
})

test('store: a real filesystem failure (directory under a file) is tolerated too', async (t) => {
  const warnings = captureWarnings(t)
  await withTempDir(async (root) => {
    const blocker = join(root, 'blocker')
    await writeFile(blocker, 'a file, not a directory')
    const store = createStateStore({ dir: join(blocker, 'sub') })
    const merged = await store.patch({ prefs: { picker: false } })
    await store.flush()
    assert.equal(merged.prefs.picker, false)
    assert.equal((await store.read()).prefs.picker, false)
    assert.ok(warnings().some((line) => line.includes('cannot save')))
  })
})

test('store: a transient EPERM on rename is retried; a permanent one gives up after a few tries', async (t) => {
  const warnings = captureWarnings(t)
  await withTempDir(async (root) => {
    let attempts = 0
    const flaky = fakeFs({
      rename: async (...args) => {
        attempts += 1
        if (attempts < 3) throw fsError('EPERM', 'locked by antivirus')
        return realFs.rename(...args)
      }
    })
    const dir = nestedDir(root)
    const store = createStateStore({ dir, fs: flaky.fs })
    await store.patch({ efforts: { 'a/b': 'low' } })
    await store.flush()
    assert.equal(attempts, 3)
    assert.deepEqual(warnings(), [], 'recovered quietly')
    assert.deepEqual((await createStateStore({ dir }).read()).efforts, { 'a/b': 'low' })

    let tries = 0
    const locked = fakeFs({ rename: async () => { tries += 1; throw fsError('EPERM', 'still locked') } })
    const stuck = createStateStore({ dir: join(root, 'stuck'), fs: locked.fs })
    await stuck.patch({ efforts: { 'a/b': 'low' } })
    await stuck.flush()
    assert.equal(tries, 4, 'one try plus three retries')
    assert.equal(warnings().length, 1)
    assert.match(warnings()[0], /still locked/)
  })
})

test('store: writes are serialized and a burst of patches loses nothing', async () => {
  await withTempDir(async (root) => {
    const dir = nestedDir(root)
    let inFlight = 0
    let maxInFlight = 0
    let writes = 0
    const slow = (name) => async (...args) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      try {
        await delay(8)
        return await realFs[name](...args)
      } finally {
        inFlight -= 1
      }
    }
    const { fs } = fakeFs({
      mkdir: slow('mkdir'),
      writeFile: (...args) => { writes += 1; return slow('writeFile')(...args) },
      rename: slow('rename')
    })
    const store = createStateStore({ dir, fs })
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => store.patch({ efforts: { [`p/m${i}`]: 'low' } })))
    await store.flush()
    assert.equal(maxInFlight, 1, 'file operations never interleave')
    assert.ok(writes >= 1 && writes <= 12)
    assert.equal(Object.keys(results[11].efforts).length, 12, 'each patch builds on the previous one')
    const final = await store.read()
    assert.equal(Object.keys(final.efforts).length, 12)
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')), final, 'the file ends up with the latest state')
    assert.deepEqual(await readdir(dir), ['state.json'])
  })
})

test('store: a patch that arrives during a write is written by the next one', async () => {
  await withTempDir(async (root) => {
    const dir = nestedDir(root)
    let release
    const gate = new Promise((done) => { release = done })
    let parked
    const started = new Promise((done) => { parked = done })
    let first = true
    const { fs } = fakeFs({
      writeFile: async (...args) => {
        if (first) {
          first = false
          parked()
          await gate
        }
        return realFs.writeFile(...args)
      }
    })
    const store = createStateStore({ dir, fs })
    await store.patch({ efforts: { 'a/1': 'low' } })
    await started // the first write is now parked inside writeFile
    await store.patch({ efforts: { 'b/2': 'high' } })
    release()
    await store.flush()
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).efforts, { 'a/1': 'low', 'b/2': 'high' })
  })
})

test('store: flush() is safe to call at any time', async () => {
  await withTempDir(async (root) => {
    const dir = nestedDir(root)
    const store = createStateStore({ dir })
    await store.flush() // before anything was loaded
    await store.flush()

    const pending = store.patch({ prefs: { picker: false } }) // deliberately not awaited
    await store.flush() // must still wait for the write this patch is about to queue
    assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).prefs.picker, false)
    await pending
    await store.flush()
  })
})

/* ── route handler ────────────────────────────────────────────────────── */

test('handler: a fence rejection answers 403 before anything else happens', async () => {
  const llm = fakeLlm(() => LLM_INFO)
  const requests = [
    {}, { url: INFO_URL, body: { provider: 'p', model: 'm' } }, { method: 'GET' }, { url: '/nope' }, { type: 'text/plain' }, { body: '{bad' }
  ]
  for (const fence of [() => false, () => { throw new Error('fence blew up') }]) {
    await withHandler(async ({ call, dir }) => {
      for (const opts of requests) {
        const res = await call(opts)
        assert.equal(res.status, 403)
        assert.deepEqual(res.body, { ok: false, error: 'forbidden' })
      }
      assert.equal(existsSync(dir), false, 'nothing was stored')
      assert.equal(llm.calls.length, 0, 'the llm was never asked')
    }, { fence, llm })
  }
})

test('handler: the fence sees the request', async () => {
  let seen
  await withHandler(async ({ call }) => {
    const res = await call({ url: `${STATE_URL}?probe=1`, body: {} })
    assert.equal(res.status, 200, 'a query string does not change the route')
    assert.equal(seen.url, `${STATE_URL}?probe=1`)
  }, { fence: (req) => { seen = req; return true } })
})

test('handler: unknown paths answer 404', async () => {
  await withHandler(async ({ call }) => {
    for (const url of [ROUTE, `${ROUTE}/`, `${ROUTE}/other`, `${STATE_URL}/`, `${STATE_URL}/x`, `${INFO_URL}/y`, '/state', '/', `${ROUTE}-x/state`]) {
      const res = await call({ url, body: {} })
      assert.equal(res.status, 404, url)
      assert.deepEqual(res.body, { ok: false, error: 'not-found' })
    }
  })
})

test('handler: anything but POST answers 405, ahead of the content-type and body checks', async () => {
  await withHandler(async ({ call }) => {
    for (const url of [STATE_URL, INFO_URL]) {
      for (const method of ['GET', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']) {
        const res = await call({ method, url, type: 'text/plain', body: pad(70 * 1024) })
        assert.equal(res.status, 405, `${method} ${url}`)
        assert.deepEqual(res.body, { ok: false, error: 'method' })
        assert.equal(res.headers.allow, 'POST')
      }
    }
  })
})

test('handler: only JSON bodies are accepted (415)', async () => {
  await withHandler(async ({ call }) => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp', 'application/json-seq', 'application/xjson', '', null]) {
      const res = await call({ type, body: {} })
      assert.equal(res.status, 415, String(type))
      assert.deepEqual(res.body, { ok: false, error: 'json-only' })
    }
    const oversized = await call({ type: 'text/plain', body: pad(70 * 1024) })
    assert.equal(oversized.status, 415, 'the type is checked before the body is read')
    for (const type of ['application/json', 'application/json; charset=utf-8', 'Application/JSON', 'application/json ;charset=utf-8']) {
      assert.equal((await call({ type, body: {} })).status, 200, type)
    }
  })
})

test('handler: a body over 64 KiB answers 413, one of exactly 64 KiB is read', async () => {
  await withHandler(async ({ call, store }) => {
    const limit = 64 * 1024
    assert.equal(Buffer.byteLength(pad(limit)), limit)

    const exact = await call({ body: pad(limit) })
    assert.equal(exact.status, 200, 'exactly at the cap')

    const over = await call({ body: pad(limit + 1) })
    assert.equal(over.status, 413)
    assert.deepEqual(over.body, { ok: false, error: 'body-too-large' })

    const half = Buffer.alloc(limit / 2 + 1, 'x')
    const streamed = await call({ chunks: [half, half] })
    assert.equal(streamed.status, 413, 'the cap applies to the running total across chunks')

    const declared = await call({ body: '{}', headers: { 'content-length': String(limit + 1) } })
    assert.equal(declared.status, 413, 'an honest oversized content-length is refused before reading')
    const honest = await call({ body: '{}', headers: { 'content-length': '2' } })
    assert.equal(honest.status, 200)

    const oversizedInfo = await call({ url: INFO_URL, body: pad(limit + 1) })
    assert.equal(oversizedInfo.status, 413)
    assert.deepEqual(await store.read(), DEFAULT_STATE, 'refused bodies change nothing')
  })
})

test('handler: bad JSON and bad fields answer 400 and change nothing', async () => {
  const llm = fakeLlm(() => LLM_INFO)
  await withHandler(async ({ call, store }) => {
    for (const body of ['{bad', '{"patch":', 'undefined', "{'a':1}"]) {
      const res = await call({ body })
      assert.equal(res.status, 400, body)
      assert.deepEqual(res.body, { ok: false, error: 'bad-json' })
    }
    for (const body of ['[]', '"x"', '42', 'null', 'true']) {
      for (const url of [STATE_URL, INFO_URL]) {
        const res = await call({ url, body })
        assert.equal(res.status, 400, `${url} ${body}`)
        assert.deepEqual(res.body, { ok: false, error: 'bad-body' })
      }
    }
    for (const patch of ['x', 5, true, [], [{ efforts: { 'a/b': 'low' } }]]) {
      const res = await call({ body: { patch } })
      assert.equal(res.status, 400, JSON.stringify(patch))
      assert.deepEqual(res.body, { ok: false, error: 'bad-patch' })
    }

    const bad = [
      {}, { provider: 'p' }, { model: 'm' }, { provider: 1, model: 'm' }, { provider: 'p', model: null }, { provider: '', model: 'm' },
      { provider: 'p', model: '' }, { provider: 'p', model: 'm'.repeat(301) }, { provider: ['p'], model: 'm' }, { provider: {}, model: {} }
    ]
    for (const body of bad) {
      const res = await call({ url: INFO_URL, body })
      assert.equal(res.status, 400, JSON.stringify(body))
      assert.deepEqual(res.body, { ok: false, error: 'bad-fields' })
    }
    assert.equal((await call({ url: INFO_URL })).status, 400, 'an empty body has no provider or model')
    assert.equal(llm.calls.length, 0, 'the llm is never asked about a malformed request')
    assert.deepEqual(await store.read(), DEFAULT_STATE)
  }, { llm })
})

test('handler: /state reads the memory with no patch, and an empty or null patch is just a read', async () => {
  await withHandler(async ({ call }) => {
    for (const opts of [{ body: {} }, {}, { body: { patch: null } }, { body: { patch: undefined } }, { body: { other: 1 } }]) {
      const res = await call(opts)
      assert.equal(res.status, 200)
      assert.deepEqual(res.body, { ok: true, state: DEFAULT_STATE })
    }
  })
})

test('handler: /state patches roundtrip, merge, and persist across a restart', async () => {
  await withHandler(async ({ call, store, dir }) => {
    const first = await call({
      body: {
        patch: {
          efforts: { 'openai/gpt-5': 'high', 'ollama/qwen3:30b': null },
          recent: ['openai/gpt-5', 'ollama/qwen3:30b'],
          favorites: ['openai/gpt-5'],
          prefs: { memory: false }
        }
      }
    })
    const afterFirst = {
      version: 1,
      efforts: { 'openai/gpt-5': 'high', 'ollama/qwen3:30b': null },
      recent: ['openai/gpt-5', 'ollama/qwen3:30b'],
      favorites: ['openai/gpt-5'],
      prefs: { picker: true, memory: false }
    }
    assert.equal(first.status, 200)
    assert.deepEqual(first.body, { ok: true, state: afterFirst })
    assert.deepEqual((await call({ body: {} })).body, { ok: true, state: afterFirst }, 'a read sees the patch')

    const second = await call({
      body: { patch: { efforts: { 'openai/gpt-5': 'low', 'x/y': 'min' }, recent: ['x/y'], prefs: { picker: false } } }
    })
    const afterSecond = {
      version: 1,
      efforts: { 'openai/gpt-5': 'low', 'ollama/qwen3:30b': null, 'x/y': 'min' },
      recent: ['x/y'],
      favorites: ['openai/gpt-5'],
      prefs: { picker: false, memory: false }
    }
    assert.deepEqual(second.body, { ok: true, state: afterSecond })
    assert.deepEqual(Object.keys(second.body.state).sort(), ['efforts', 'favorites', 'prefs', 'recent', 'version'])

    await store.flush()
    const restarted = createHandler({ fence: () => true, store: createStateStore({ dir }) })
    assert.deepEqual((await run(restarted, { body: {} })).body, { ok: true, state: afterSecond }, 'a restart remembers')
  })
})

test('handler: bad parts of a patch are dropped, the rest applies', async () => {
  await withHandler(async ({ call }) => {
    const res = await call({
      body: {
        patch: {
          efforts: { 'good/model': 'high', bad: 'x', 'too/long': 'x'.repeat(65), 'num/model': 3 },
          recent: 'nope',
          favorites: ['fav/one', 7, 'fav/one'],
          prefs: { picker: 'yes', memory: false },
          junk: { a: 1 },
          version: 9
        }
      }
    })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body.state, {
      version: 1,
      efforts: { 'good/model': 'high' },
      recent: [],
      favorites: ['fav/one'],
      prefs: { picker: true, memory: false }
    })
  })
})

test('handler: an unexpected failure answers 500 instead of hanging the request', async (t) => {
  const warnings = captureWarnings(t)
  const handler = createHandler({ fence: () => true, store: { read: async () => { throw new Error('store exploded') } } })
  const res = await run(handler, { body: {} })
  assert.equal(res.status, 500)
  assert.deepEqual(res.body, { ok: false, error: 'internal' })
  assert.match(warnings().join('\n'), /store exploded/)
})

test('handler: /info exposes only name, contextWindow and inputModalities', async () => {
  const llm = fakeLlm(() => LLM_INFO)
  await withHandler(async ({ call }) => {
    const res = await call({ url: INFO_URL, body: { provider: 'anthropic', model: 'claude-opus-4' } })
    assert.equal(res.status, 200)
    assert.deepEqual(res.body, { ok: true, info: { name: 'Claude Opus 4', contextWindow: 200000, inputModalities: ['text', 'image'] } })
    assert.deepEqual(llm.calls, [['anthropic', 'claude-opus-4']], 'provider and model reach the service as sent')

    const slashed = await call({ url: INFO_URL, body: { provider: 'openrouter', model: 'anthropic/claude-3.5-sonnet' } })
    assert.equal(slashed.body.ok, true)
    assert.deepEqual(llm.calls[1], ['openrouter', 'anthropic/claude-3.5-sonnet'], 'a model id with slashes is not split')
  }, { llm })
})

test('handler: /info keeps only JSON-safe, bounded values', async () => {
  const names = Array.from({ length: 20 }, (_, i) => `m${i}`)
  const cases = [
    ['name only', { name: 'Only Name' }, { name: 'Only Name' }],
    ['context only', { context: { contextWindow: 128000 } }, { contextWindow: 128000 }],
    ['modalities only', { inputModalities: ['text'] }, { inputModalities: ['text'] }],
    ['empty modalities are a real answer', { inputModalities: [] }, { inputModalities: [] }],
    ['zero context window', { name: 'N', context: { contextWindow: 0 } }, { name: 'N' }],
    ['negative context window', { name: 'N', context: { contextWindow: -5 } }, { name: 'N' }],
    ['fractional context window', { name: 'N', context: { contextWindow: 1.5 } }, { name: 'N' }],
    ['string context window', { name: 'N', context: { contextWindow: '200000' } }, { name: 'N' }],
    ['NaN context window', { name: 'N', context: { contextWindow: NaN } }, { name: 'N' }],
    ['infinite context window', { name: 'N', context: { contextWindow: Infinity } }, { name: 'N' }],
    ['unsafe context window', { name: 'N', context: { contextWindow: Number.MAX_SAFE_INTEGER + 2 } }, { name: 'N' }],
    ['null context', { name: 'N', context: null }, { name: 'N' }],
    ['non-string name and non-array modalities', { name: 123, inputModalities: 'text' }, undefined],
    ['empty name', { name: '' }, undefined],
    ['long name is cut', { name: 'x'.repeat(500) }, { name: 'x'.repeat(200) }],
    [
      'modalities are filtered to short strings',
      { name: 'N', inputModalities: ['text', 5, null, '', 'y'.repeat(33), 'image', {}, ['audio']] },
      { name: 'N', inputModalities: ['text', 'image'] }
    ],
    ['modalities are capped at 8', { name: 'N', inputModalities: names }, { name: 'N', inputModalities: names.slice(0, 8) }],
    ['everything else is ignored', { provider: 'p', id: 'm', description: 'd', defaultMaxTokens: 1, reasoning: {}, secret: 's' }, undefined]
  ]
  let current
  await withHandler(async ({ call }) => {
    for (const [label, resolved, expected] of cases) {
      current = resolved
      const res = await call({ url: INFO_URL, body: { provider: 'p', model: 'm' } })
      assert.equal(res.status, 200, label)
      assert.deepEqual(res.body, expected === undefined ? UNAVAILABLE : { ok: true, info: expected }, label)
    }
  }, { getLlm: () => ({ resolveModelInfo: async () => current }) })
})

test('handler: /info answers unavailable whenever the model cannot be resolved', async () => {
  let service
  const cases = [
    ['no llm service', () => undefined],
    ['null service', () => null],
    ['service without resolveModelInfo', () => ({})],
    ['resolveModelInfo is not a function', () => ({ resolveModelInfo: 'nope' })],
    ['getLlm throws', () => { throw new Error('no such service') }],
    ['unknown model rejects', () => fakeLlm(async () => { throw new Error('no adapter registered for provider "p"') })],
    ['resolveModelInfo throws synchronously', () => ({ resolveModelInfo: () => { throw new Error('sync failure') } })],
    ['resolves undefined', () => fakeLlm(() => undefined)],
    ['resolves null', () => fakeLlm(() => null)],
    ['resolves a string', () => fakeLlm(() => 'nope')],
    ['resolves an array', () => fakeLlm(() => [])],
    ['resolves an object with nothing usable', () => fakeLlm(() => ({}))],
    ['never settles', () => ({ resolveModelInfo: () => new Promise(() => {}) })]
  ]
  await withHandler(async ({ call }) => {
    for (const [label, make] of cases) {
      service = make
      const res = await call({ url: INFO_URL, body: { provider: 'p', model: 'm' } })
      assert.equal(res.status, 200, label)
      assert.deepEqual(res.body, UNAVAILABLE, label)
    }
  }, { getLlm: () => service(), infoTimeoutMs: 25 })
})

test('handler: with no getLlm at all /info is simply unavailable', async () => {
  const handler = createHandler({ fence: () => true, store: { read: async () => DEFAULT_STATE } })
  const res = await run(handler, { url: INFO_URL, body: { provider: 'p', model: 'm' } })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body, UNAVAILABLE)
})

test('handler: the llm service is looked up per /info request, never for /state', async () => {
  let lookups = 0
  let service
  await withHandler(async ({ call }) => {
    await call({ body: {} })
    await call({ body: { patch: { prefs: { picker: false } } } })
    assert.equal(lookups, 0, 'state requests never touch the llm')

    const early = await call({ url: INFO_URL, body: { provider: 'p', model: 'm' } })
    assert.deepEqual(early.body, UNAVAILABLE)
    assert.equal(lookups, 1)

    service = fakeLlm(() => LLM_INFO) // the service shows up after mounting
    const late = await call({ url: INFO_URL, body: { provider: 'p', model: 'm' } })
    assert.equal(late.body.ok, true, 'a service that appears later is picked up')
    assert.equal(lookups, 2)
  }, { getLlm: () => { lookups += 1; return service } })
})

/* ── behind a real HTTP server ────────────────────────────────────────── */

test('integration: the handler works behind a real node:http server', async () => {
  await withTempDir(async (root) => {
    const dir = join(root, 'dsh-model-effort-picker')
    const store = createStateStore({ dir })
    const llm = fakeLlm(() => LLM_INFO)
    const handler = createHandler({ fence: () => true, store, getLlm: () => llm })
    const server = createServer((req, res) => { handler(req, res) })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}${ROUTE}`
    const post = (path, body, headers = {}) => fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })
    try {
      let res = await post('/state', { patch: { efforts: { 'openai/gpt-5': 'high' }, prefs: { memory: false } } })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('cache-control'), 'no-store')
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
      assert.deepEqual((await res.json()).state.efforts, { 'openai/gpt-5': 'high' })

      res = await post('/state', {})
      assert.deepEqual((await res.json()).state.prefs, { picker: true, memory: false })

      res = await post('/info', { provider: 'anthropic', model: 'claude-opus-4' })
      assert.deepEqual(await res.json(), {
        ok: true, info: { name: 'Claude Opus 4', contextWindow: 200000, inputModalities: ['text', 'image'] }
      })

      res = await fetch(`${base}/state`)
      assert.equal(res.status, 405)
      assert.equal(res.headers.get('allow'), 'POST')
      await res.arrayBuffer()

      res = await fetch(`${base}/state`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })
      assert.equal(res.status, 415)
      await res.arrayBuffer()

      res = await post('/nope', {})
      assert.equal(res.status, 404)
      await res.arrayBuffer()

      res = await post('/state', '{bad')
      assert.equal(res.status, 400)
      await res.arrayBuffer()

      res = await post('/state', 'x'.repeat(64 * 1024 + 1))
      assert.equal(res.status, 413, 'the declared content-length is refused with a readable response')
      assert.deepEqual(await res.json(), { ok: false, error: 'body-too-large' })

      res = await post('/state', {}) // the connection is still good afterwards
      assert.equal(res.status, 200)
      await res.arrayBuffer()
    } finally {
      server.closeAllConnections()
      await new Promise((done) => server.close(done))
      await store.flush()
    }
    assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).efforts['openai/gpt-5'], 'high')
  })
})

/* ── plugin wiring ────────────────────────────────────────────────────── */

test('apply: one prefix route through ctx.effect, fenced, llm fetched lazily, state under DSH_HOME', async () => {
  await withTempDir(async (root) => {
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      const registered = []
      const effects = []
      let rejection
      let llmLookups = 0
      const llm = fakeLlm(() => LLM_INFO)
      const dispose = () => {}
      const injections = []
      const ctx = {
        webServer: { register: (descriptor) => { registered.push(descriptor); return dispose } },
        connection: { requestRejection: () => rejection },
        effect: (fn, label) => { effects.push({ fn, label }) },
        // The default-model hooks are optional: declared through ctx.inject, never a hard dependency.
        inject: (names, callback) => { injections.push({ names, callback }) },
        get: (name) => { llmLookups += 1; assert.equal(name, 'llm'); return llm }
      }

      apply(ctx)
      assert.deepEqual(injections.map((entry) => entry.names), [['agentDefaultModel']], 'the default-model service is requested softly')
      assert.equal(effects.length, 1, 'a single effect')
      assert.match(effects[0].label, /^dsh-model-effort-picker: /)
      assert.equal(registered.length, 0, 'registration happens inside the effect')
      assert.equal(llmLookups, 0, 'mounting never waits on or touches the llm service')

      assert.equal(effects[0].fn(), dispose, 'the effect hands back the registration disposer')
      assert.equal(registered.length, 1)
      const [route] = registered
      assert.equal(route.kind, 'prefix')
      assert.equal(route.path, ROUTE)
      assert.equal(typeof route.handler, 'function')

      rejection = { status: 403 } // anything but undefined is a rejection
      assert.equal((await run(route.handler, { body: {} })).status, 403, 'the connection fence is honoured')
      rejection = undefined

      const patched = await run(route.handler, { body: { patch: { prefs: { picker: false } } } })
      assert.equal(patched.status, 200)
      const file = join(root, 'dsh-model-effort-picker', 'state.json')
      await waitFor(() => existsSync(file))
      assert.equal(JSON.parse(await readFile(file, 'utf8')).prefs.picker, false, 'state lives under $DSH_HOME/dsh-model-effort-picker')

      const info = await run(route.handler, { url: INFO_URL, body: { provider: 'anthropic', model: 'claude-opus-4' } })
      assert.equal(info.body.ok, true)
      assert.equal(llmLookups, 1, 'the llm is fetched when an /info request needs it')
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })
})

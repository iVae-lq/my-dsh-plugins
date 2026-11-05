// Offline tests for the "quiet default model" part of the host half: the options and the remembered
// selection (pure + store + route), and the hooks that take over agentDefaultModel.saveSelection /
// currentSelection so a model switch no longer rewrites the profile config. Run: node --test test/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  ROUTE, apply, createHandler, createStateStore, installQuietDefaults, mergeOptions, normalizeOptions, normalizeSelection, sameSelection
} from '../index.js'

const OPTIONS_URL = `${ROUTE}/options`
const STATE_URL = `${ROUTE}/state`

/** Every store a test creates goes through here, so cleanup can wait for its queued writes first. */
const openStores = new Set()
function newStore(dir, options = {}) {
  const store = createStateStore({ dir, ...options })
  openStores.add(store)
  return store
}

async function withTempDir(fn) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mep-quiet-'))
  try {
    return await fn(root)
  } finally {
    // A write that is still in flight would make the recursive delete fail with ENOTEMPTY on Windows.
    await Promise.all([...openStores].map((store) => store.flush()))
    openStores.clear()
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

function fakeReq({ url, body, method = 'POST' }) {
  const text = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(text === '' ? [] : [Buffer.from(text)])
  req.method = method
  req.url = url
  req.headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)) }
  return req
}

async function run(handler, request) {
  const res = { status: 0, body: undefined, writeHead(status) { this.status = status }, end(text) { this.body = JSON.parse(text) } }
  await handler(fakeReq(request), res)
  return res
}

/** Stand-in for the real `agentDefaultModel` service: it rewrites a "config" on every save. */
function fakeService(initial = { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'max' }) {
  const service = {
    config: { ...initial },
    configWrites: [],
    currentSelection() { return { ...this.config } },
    async saveSelection(next) { this.configWrites.push({ ...next }); this.config = { ...next } }
  }
  return service
}

/* ── pure helpers ─────────────────────────────────────────────────────── */

test('normalizeOptions: quiet defaults to on and only a real boolean changes it', () => {
  assert.deepEqual(normalizeOptions(undefined), { quiet: true })
  for (const junk of [null, 5, 'x', [], {}, { quiet: 'no' }, { quiet: 0 }, { quiet: null }]) assert.deepEqual(normalizeOptions(junk), { quiet: true })
  assert.deepEqual(normalizeOptions({ quiet: false }), { quiet: false })
  assert.deepEqual(normalizeOptions({ quiet: true, extra: 1 }), { quiet: true })
})

test('mergeOptions: a patch with a boolean wins, everything else keeps the base', () => {
  assert.deepEqual(mergeOptions({ quiet: true }, { quiet: false }), { quiet: false })
  assert.deepEqual(mergeOptions({ quiet: false }, { quiet: true }), { quiet: true })
  for (const junk of [undefined, null, 'x', [], {}, { quiet: 'yes' }, { other: false }]) assert.deepEqual(mergeOptions({ quiet: false }, junk), { quiet: false })
  assert.deepEqual(mergeOptions('garbage', { other: 1 }), { quiet: true })
})

test('normalizeSelection: bounded provider/model strings, optional effort', () => {
  assert.deepEqual(normalizeSelection({ provider: 'anthropic', model: 'claude-sonnet-5-5' }), { provider: 'anthropic', model: 'claude-sonnet-5-5' })
  assert.deepEqual(normalizeSelection({ provider: 'a', model: 'b/c', reasoningEffort: 'high' }), { provider: 'a', model: 'b/c', reasoningEffort: 'high' })
  assert.deepEqual(normalizeSelection({ provider: 'a', model: 'b', reasoningEffort: null }), { provider: 'a', model: 'b' })
  assert.deepEqual(normalizeSelection({ provider: 'a', model: 'b', reasoningEffort: undefined, junk: 1 }), { provider: 'a', model: 'b' }, 'unknown fields are dropped')
  for (const bad of [undefined, null, 'x', [], {}, { provider: 'a' }, { model: 'b' }, { provider: '', model: 'b' }, { provider: 'a', model: 5 },
    { provider: 'a', model: 'b', reasoningEffort: '' }, { provider: 'a', model: 'b', reasoningEffort: 5 }, { provider: 'a', model: 'b', reasoningEffort: 'x'.repeat(65) },
    { provider: 'p'.repeat(301), model: 'b' }]) {
    assert.equal(normalizeSelection(bad), null, JSON.stringify(bad))
  }
})

/* ── store ────────────────────────────────────────────────────────────── */

test('store.peek: answers synchronously from the file, once, and agrees with the async path', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'state.json'), JSON.stringify({
      efforts: { 'a/b': 'high' }, options: { quiet: false }, lastSelection: { provider: 'openai', model: 'gpt-5.5', reasoningEffort: 'low' }
    }))
    let reads = 0
    const store = newStore(dir, { readSync: (...args) => { reads += 1; return readFileSync(...args) } })
    const peeked = store.peek()
    assert.deepEqual(peeked, { options: { quiet: false }, lastSelection: { provider: 'openai', model: 'gpt-5.5', reasoningEffort: 'low' }, basis: null })
    store.peek()
    assert.equal(reads, 1, 'the file is read once')
    assert.deepEqual((await store.read()).efforts, { 'a/b': 'high' }, 'the async path adopts the same document')
    assert.equal(reads, 1, 'and does not read again')
  })
})

test('store.peek: a missing or corrupt file is the defaults, never an error', async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(newStore(dir).peek(), { options: { quiet: true }, lastSelection: null, basis: null })
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'state.json'), '{not json')
    const silenced = console.warn
    console.warn = () => {}
    try {
      assert.deepEqual(newStore(dir).peek(), { options: { quiet: true }, lastSelection: null, basis: null })
    } finally {
      console.warn = silenced
    }
  })
})

test('store.peek: hands out copies', async () => {
  await withTempDir(async (dir) => {
    const store = newStore(dir)
    await store.saveLastSelection({ provider: 'a', model: 'b' })
    const view = store.peek()
    view.lastSelection.model = 'tampered'
    view.options.quiet = false
    assert.deepEqual(store.peek(), { options: { quiet: true }, lastSelection: { provider: 'a', model: 'b' }, basis: null })
  })
})

test('store: the remembered selection and the options roundtrip through the file and survive a restart', async () => {
  await withTempDir(async (dir) => {
    const store = newStore(dir)
    assert.equal(await store.saveLastSelection({ provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'high', junk: true }, { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'max', extra: 1 }), true)
    assert.deepEqual(await store.patchOptions({ quiet: false }), { quiet: false })
    await store.patch({ efforts: { 'x/y': 'low' } })
    await store.flush()
    const onDisk = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.deepEqual(onDisk.lastSelection, { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'high' })
    assert.deepEqual(onDisk.lastBasis, { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'max' }, 'the configured default seen at save time is kept, unknown fields dropped')
    assert.deepEqual(onDisk.options, { quiet: false })
    assert.equal(onDisk.efforts['x/y'], 'low', 'the State is still stored alongside')

    const reborn = newStore(dir)
    assert.deepEqual(reborn.peek(), { options: { quiet: false }, lastSelection: { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'high' }, basis: { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'max' } })
    assert.deepEqual(await reborn.readOptions(), { quiet: false })
  })
})

test('store: defaults are not written, so a State-only file keeps its original shape', async () => {
  await withTempDir(async (dir) => {
    const store = newStore(dir)
    await store.patch({ efforts: { 'x/y': 'low' } })
    await store.patchOptions({ quiet: true }) // unchanged
    await store.flush()
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))).sort(), ['efforts', 'favorites', 'prefs', 'recent', 'version'])
  })
})

test('store: an invalid selection is refused and changes nothing; patchOptions ignores junk', async () => {
  await withTempDir(async (dir) => {
    const store = newStore(dir)
    assert.equal(await store.saveLastSelection({ provider: 'a' }), false)
    assert.equal(await store.saveLastSelection(null), false)
    assert.equal(store.peek().lastSelection, null)
    assert.deepEqual(await store.patchOptions({ quiet: 'no' }), { quiet: true })
    assert.deepEqual(await store.patchOptions(undefined), { quiet: true })
  })
})

test('store: state patches never touch the options or the selection (the client cannot set them)', async () => {
  await withTempDir(async (dir) => {
    const store = newStore(dir)
    await store.saveLastSelection({ provider: 'a', model: 'b' })
    await store.patch({ lastSelection: { provider: 'evil', model: 'x' }, options: { quiet: false } })
    assert.deepEqual(store.peek(), { options: { quiet: true }, lastSelection: { provider: 'a', model: 'b' }, basis: null })
    assert.deepEqual(Object.keys(await store.read()).sort(), ['efforts', 'favorites', 'prefs', 'recent', 'version'])
    await store.flush() // queued writes must land before the temp dir goes away
  })
})

/* ── route ────────────────────────────────────────────────────────────── */

test('route /options: read, patch, junk and the usual HTTP discipline', async () => {
  await withTempDir(async (dir) => {
    const store = newStore(dir)
    const handler = createHandler({ fence: () => true, store })
    assert.deepEqual((await run(handler, { url: OPTIONS_URL, body: {} })).body, { ok: true, options: { quiet: true } })
    assert.deepEqual((await run(handler, { url: OPTIONS_URL, body: { patch: null } })).body, { ok: true, options: { quiet: true } })
    const off = await run(handler, { url: OPTIONS_URL, body: { patch: { quiet: false } } })
    assert.equal(off.status, 200)
    assert.deepEqual(off.body, { ok: true, options: { quiet: false } })
    assert.deepEqual((await run(handler, { url: OPTIONS_URL, body: { patch: { quiet: 'maybe', extra: 1 } } })).body.options, { quiet: false }, 'junk is ignored')
    assert.equal((await run(handler, { url: OPTIONS_URL, body: { patch: 'x' } })).status, 400)
    assert.equal((await run(handler, { url: OPTIONS_URL, method: 'GET' })).status, 405)
    assert.equal((await run(createHandler({ fence: () => false, store }), { url: OPTIONS_URL, body: {} })).status, 403)
    // the state route is untouched by all of this
    const state = await run(handler, { url: STATE_URL, body: {} })
    assert.deepEqual(Object.keys(state.body.state).sort(), ['efforts', 'favorites', 'prefs', 'recent', 'version'])
    await store.flush() // the options patch queued a write
  })
})

/* ── hooks ────────────────────────────────────────────────────────────── */

test('hooks: a save is remembered here and does not touch the config', async () => {
  await withTempDir(async (dir) => {
    const store = newStore(dir)
    const service = fakeService()
    installQuietDefaults(service, store)
    const result = service.saveSelection({ provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'high' })
    assert.ok(result instanceof Promise, 'callers chain .catch() on the result')
    await result
    assert.deepEqual(service.configWrites, [], 'no config write, so no settings/document-updated broadcast')
    assert.deepEqual(service.currentSelection(), { provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'high' }, 'new sessions start with the last choice')
    assert.deepEqual(service.config, { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'max' }, 'the configured row is left alone')
    await store.flush()
    assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).lastSelection.model, 'claude-opus-5-5')
  })
})

test('hooks: before anything is remembered the configured default is used', async () => {
  await withTempDir(async (dir) => {
    const service = fakeService()
    installQuietDefaults(service, newStore(dir))
    assert.deepEqual(service.currentSelection(), { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'max' })
  })
})

test('hooks: a selection without an effort replaces one with an effort (no stale effort)', async () => {
  await withTempDir(async (dir) => {
    const service = fakeService()
    installQuietDefaults(service, newStore(dir))
    await service.saveSelection({ provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'high' })
    await service.saveSelection({ provider: 'xai', model: 'grok-4.7' })
    assert.deepEqual(service.currentSelection(), { provider: 'xai', model: 'grok-4.7' })
  })
})

test('hooks: with quiet off the shipped behaviour (config write) is used again, at runtime', async () => {
  await withTempDir(async (dir) => {
    const store = newStore(dir)
    const service = fakeService()
    installQuietDefaults(service, store)
    await service.saveSelection({ provider: 'openai', model: 'gpt-5.5' })
    assert.equal(service.configWrites.length, 0)
    await store.patchOptions({ quiet: false })
    await service.saveSelection({ provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'low' })
    assert.deepEqual(service.configWrites, [{ provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'low' }])
    assert.deepEqual(service.currentSelection(), { provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'low' }, 'reads the config again')
    await store.patchOptions({ quiet: true })
    assert.deepEqual(service.currentSelection(), { provider: 'openai', model: 'gpt-6-luna', reasoningEffort: 'low' }, 'the older memory must not shadow the newer config write')
  })
})

test('hooks: an invalid selection falls through to the original save', async () => {
  await withTempDir(async (dir) => {
    const service = fakeService()
    installQuietDefaults(service, newStore(dir))
    await service.saveSelection({ provider: 'only-provider' })
    assert.deepEqual(service.configWrites, [{ provider: 'only-provider' }])
  })
})

test('hooks: a failing store never breaks selecting a model', async (t) => {
  const warnings = []
  t.mock.method(console, 'warn', (message) => { warnings.push(String(message)) })
  const service = fakeService()
  const broken = {
    peek() { throw new Error('disk on fire') },
    async saveLastSelection() { throw new Error('disk on fire') }
  }
  installQuietDefaults(service, broken)
  assert.deepEqual(service.currentSelection(), { provider: 'anthropic', model: 'claude-sonnet-5-5', reasoningEffort: 'max' }, 'reads fall back to the config')
  await service.saveSelection({ provider: 'openai', model: 'gpt-5.5' })
  assert.deepEqual(service.configWrites, [{ provider: 'openai', model: 'gpt-5.5' }], 'saves fall back to the config write')
  assert.ok(warnings.length >= 2 && warnings.every((w) => /dsh-model-effort-picker/.test(w)))
})

test('hooks: unloading restores the original methods exactly', async () => {
  await withTempDir(async (dir) => {
    class Service {
      currentSelection() { return { provider: 'p', model: 'm' } }
      async saveSelection() {}
    }
    const service = new Service()
    const restore = installQuietDefaults(service, newStore(dir))
    assert.ok(Object.hasOwn(service, 'saveSelection') && Object.hasOwn(service, 'currentSelection'))
    restore()
    assert.equal(Object.hasOwn(service, 'saveSelection'), false, 'prototype methods are visible again, no own property left')
    assert.equal(Object.hasOwn(service, 'currentSelection'), false)
    assert.equal(service.currentSelection, Service.prototype.currentSelection)

    const own = fakeService()
    const originalSave = own.saveSelection
    installQuietDefaults(own, newStore(dir))()
    assert.equal(own.saveSelection, originalSave, 'own-property methods are put back too')
  })
})

test('hooks: unloading does not cut out a wrapper somebody else put on top', async () => {
  await withTempDir(async (dir) => {
    const service = fakeService()
    const restore = installQuietDefaults(service, newStore(dir))
    const theirs = service.saveSelection
    service.saveSelection = async (...args) => theirs.apply(service, args)
    const mine = service.saveSelection
    restore()
    assert.equal(service.saveSelection, mine, 'their wrapper stays')
  })
})

test('hooks: services that do not look like the default-model service are left alone', () => {
  for (const service of [undefined, null, {}, { currentSelection() {} }, { saveSelection() {} }]) {
    const before = service === undefined || service === null ? service : { ...service }
    assert.equal(typeof installQuietDefaults(service, {}), 'function')
    if (before) assert.deepEqual(Object.keys(service).sort(), Object.keys(before).sort())
  }
})

test('sameSelection: provider, model and effort, a missing effort equals a missing effort', () => {
  assert.equal(sameSelection({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b' }), true)
  assert.equal(sameSelection({ provider: 'a', model: 'b', reasoningEffort: 'high' }, { provider: 'a', model: 'b', reasoningEffort: 'high' }), true)
  assert.equal(sameSelection({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b', reasoningEffort: null }), true)
  assert.equal(sameSelection({ provider: 'a', model: 'b' }, { provider: 'a', model: 'b', reasoningEffort: 'high' }), false)
  assert.equal(sameSelection({ provider: 'a', model: 'b' }, { provider: 'a', model: 'c' }), false)
  assert.equal(sameSelection({ provider: 'a', model: 'b' }, { provider: 'x', model: 'b' }), false)
  for (const junk of [undefined, null, 'x', [], 5]) assert.equal(sameSelection(junk, { provider: 'a', model: 'b' }), false)
})

test('hooks: a hand-edited configuration wins over an older remembered selection, and the next switch starts a new basis', async () => {
  await withTempDir(async (dir) => {
    const service = fakeService()
    installQuietDefaults(service, newStore(dir))
    await service.saveSelection({ provider: 'anthropic', model: 'claude-opus-5-5', reasoningEffort: 'high' })
    assert.equal(service.currentSelection().model, 'claude-opus-5-5')
    // the user edits the configured default (settings page / YAML)
    service.config = { provider: 'xai', model: 'grok-4.7' }
    assert.deepEqual(service.currentSelection(), { provider: 'xai', model: 'grok-4.7' }, 'the edit takes effect')
    await service.saveSelection({ provider: 'openai', model: 'gpt-5.5', reasoningEffort: 'low' })
    assert.deepEqual(service.currentSelection(), { provider: 'openai', model: 'gpt-5.5', reasoningEffort: 'low' }, 'a later switch is remembered again')
    assert.deepEqual(service.configWrites, [], 'and still never written to the config')
  })
})

test('hooks: the basis survives a restart, so an edit made while DSH was closed is still noticed', async () => {
  await withTempDir(async (dir) => {
    const before = fakeService()
    installQuietDefaults(before, newStore(dir))
    await before.saveSelection({ provider: 'anthropic', model: 'claude-opus-5-5' })
    await Promise.all([...openStores].map((store) => store.flush()))

    const unchanged = fakeService()
    installQuietDefaults(unchanged, newStore(dir))
    assert.deepEqual(unchanged.currentSelection(), { provider: 'anthropic', model: 'claude-opus-5-5' }, 'same configuration: the memory applies')

    const edited = fakeService({ provider: 'openai', model: 'gpt-6-luna' })
    installQuietDefaults(edited, newStore(dir))
    assert.deepEqual(edited.currentSelection(), { provider: 'openai', model: 'gpt-6-luna' }, 'edited configuration: it wins')
  })
})

test('hooks: a file written without a basis is trusted as it stands', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ lastSelection: { provider: 'openai', model: 'gpt-5.5' } }))
    const service = fakeService()
    installQuietDefaults(service, newStore(dir))
    assert.deepEqual(service.currentSelection(), { provider: 'openai', model: 'gpt-5.5' })
  })
})

test('store: a basis that is not a valid selection is dropped, the selection itself is still kept', async () => {
  await withTempDir(async (dir) => {
    const store = newStore(dir)
    assert.equal(await store.saveLastSelection({ provider: 'a', model: 'b' }, { provider: 'only' }), true)
    assert.deepEqual(store.peek(), { options: { quiet: true }, lastSelection: { provider: 'a', model: 'b' }, basis: null })
    await store.flush()
    assert.equal('lastBasis' in JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')), false)
  })
})

/* ── wiring ───────────────────────────────────────────────────────────── */

test('apply: the default-model hooks are installed through a soft ctx.inject and removed on unload', async () => {
  await withTempDir(async (root) => {
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      const injections = []
      const ctx = {
        webServer: { register: () => () => {} },
        connection: { requestRejection: () => undefined },
        effect: () => {},
        inject: (names, callback) => injections.push({ names, callback }),
        get: () => undefined
      }
      apply(ctx)
      assert.deepEqual(injections.map((entry) => entry.names), [['agentDefaultModel']])

      const service = fakeService()
      const original = service.saveSelection
      const innerEffects = []
      injections[0].callback({ get: (name) => { assert.equal(name, 'agentDefaultModel'); return service }, effect: (fn, label) => { innerEffects.push({ fn, label }) } })
      assert.equal(innerEffects.length, 1)
      assert.match(innerEffects[0].label, /^dsh-model-effort-picker: /)
      assert.equal(service.saveSelection, original, 'nothing is touched until the effect runs')
      const dispose = innerEffects[0].fn()
      assert.notEqual(service.saveSelection, original, 'hooked')
      await service.saveSelection({ provider: 'a', model: 'b' })
      assert.deepEqual(service.configWrites, [])
      // apply() owns that store, so wait for its single queued write to land (state.json appears on the final rename)
      const written = join(root, 'dsh-model-effort-picker', 'state.json')
      for (let i = 0; i < 200 && !existsSync(written); i += 1) await new Promise((done) => setTimeout(done, 10))
      assert.ok(existsSync(written), 'the remembered selection reached the file')
      dispose()
      assert.equal(service.saveSelection, original, 'restored on unload')
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })
})

test('apply: a context without ctx.inject still mounts the routes', () => {
  const effects = []
  assert.doesNotThrow(() => apply({
    webServer: { register: () => () => {} },
    connection: { requestRejection: () => undefined },
    effect: (fn, label) => effects.push(label),
    get: () => undefined
  }))
  assert.equal(effects.length, 1)
})

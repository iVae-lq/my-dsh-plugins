/**
 * dsh-model-effort-picker — host half.
 *
 * The browser half remembers the reasoning effort chosen per model, but the desktop app's web
 * origin (and port) changes between launches, so localStorage alone loses that memory. This half
 * keeps a small JSON file under the DSH home and serves it over two POST-only routes:
 *
 *   POST /dsh-model-effort-picker/state  { patch? }           -> { ok, state }
 *   POST /dsh-model-effort-picker/info   { provider, model }  -> { ok, info } | { ok:false, error:'unavailable' }
 *
 * Security posture mirrors dsh-path-link-fix: the connection's own request fence rejects foreign
 * callers, only POST + JSON is accepted (a cross-origin page cannot send that without a preflight),
 * bodies are capped, and everything read from disk or from a request is re-normalized before it is
 * stored or returned. Of what the llm service knows about a model, only three display fields leave.
 */

import { readFileSync } from 'node:fs'
import * as fsPromises from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Services required before mounting. `llm` is optional: it is looked up per request, never at mount. */
export const inject = ['webServer', 'connection']

export const ROUTE = '/dsh-model-effort-picker'
const STATE_PATH = `${ROUTE}/state`
const INFO_PATH = `${ROUTE}/info`
const OPTIONS_PATH = `${ROUTE}/options`

const PLUGIN_DIR = 'dsh-model-effort-picker'
const STATE_FILE = 'state.json'
const STATE_VERSION = 1

const MAX_BODY_BYTES = 64 * 1024
const MAX_KEY_LENGTH = 300
const MAX_EFFORT_LENGTH = 64
const MAX_EFFORTS = 500
const MAX_RECENT = 8
const MAX_FAVORITES = 100
const MAX_NAME_LENGTH = 200
const MAX_MODALITIES = 8
const MAX_MODALITY_LENGTH = 32
const INFO_TIMEOUT_MS = 10_000

// Windows can hold the destination open for a moment (antivirus, indexer), which fails rename with
// EPERM/EBUSY/EACCES although the same call a few milliseconds later succeeds.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])
const RENAME_RETRIES = 3
const RENAME_BACKOFF_MS = 20

/* ── DSH home ─────────────────────────────────────────────────────────── */

/**
 * The DSH home as the harness resolves it: `$DSH_HOME` (trimmed, `~` expanded) when non-blank,
 * else `~/.dsh`. Reimplemented so the plugin needs no private harness import.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (raw === '') return resolve(join(home, '.dsh'))
  if (raw === '~') return resolve(home)
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return resolve(join(home, raw.slice(2)))
  return resolve(raw)
}

/* ── state: pure normalization and merging ────────────────────────────── */

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_KEY_LENGTH

/**
 * `provider/model`, split at the FIRST slash so model ids may contain slashes themselves. Both
 * halves must be non-empty. Because a valid key always holds a slash it can never equal an
 * Object.prototype member such as `__proto__`, so plain objects are safe as key maps here.
 */
function isKey(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_LENGTH) return false
  const slash = value.indexOf('/')
  return slash > 0 && slash < value.length - 1
}

function isEffort(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_EFFORT_LENGTH
}

/** Valid `[key, effort | null]` pairs of a raw efforts object, in insertion order. */
function* effortEntries(raw) {
  if (!isRecord(raw)) return
  for (const [key, value] of Object.entries(raw)) {
    if (isKey(key) && (value === null || isEffort(value))) yield [key, value]
  }
}

/**
 * Shallow-merge valid raw entries over `base`. New keys beyond the cap are refused while existing
 * ones may still change; with an empty base this keeps the first MAX_EFFORTS entries in order.
 */
function mergeEfforts(base, raw) {
  const efforts = { ...base }
  let count = Object.keys(efforts).length
  for (const [key, value] of effortEntries(raw)) {
    if (!Object.hasOwn(efforts, key)) {
      if (count >= MAX_EFFORTS) continue
      count += 1
    }
    efforts[key] = value
  }
  return efforts
}

/** Unique valid keys in first-seen order, at most `max` (lists are most-recent first). */
function normalizeKeys(raw, max) {
  const keys = []
  if (!Array.isArray(raw)) return keys
  const seen = new Set()
  for (const key of raw) {
    if (keys.length >= max) break
    if (!isKey(key) || seen.has(key)) continue
    seen.add(key)
    keys.push(key)
  }
  return keys
}

/** Only known boolean prefs are taken from `raw`; everything else keeps its value in `base`. */
function mergePrefs(base, raw) {
  const prefs = { picker: base.picker, memory: base.memory }
  if (isRecord(raw)) {
    if (typeof raw.picker === 'boolean') prefs.picker = raw.picker
    if (typeof raw.memory === 'boolean') prefs.memory = raw.memory
  }
  return prefs
}

/** Any input -> a fresh, valid State. Bad parts are dropped; this never throws. */
export function normalizeState(raw) {
  const src = isRecord(raw) ? raw : {}
  return {
    version: STATE_VERSION,
    efforts: mergeEfforts({}, src.efforts),
    recent: normalizeKeys(src.recent, MAX_RECENT),
    favorites: normalizeKeys(src.favorites, MAX_FAVORITES),
    prefs: mergePrefs({ picker: true, memory: true }, src.prefs)
  }
}

/**
 * Apply a Patch to a State without mutating either. `efforts` merge per key, `recent` and
 * `favorites` are replaced whenever the patch carries an array, `prefs` merge per boolean.
 */
export function mergePatch(state, patch) {
  const base = normalizeState(state)
  if (!isRecord(patch)) return base
  return {
    version: STATE_VERSION,
    efforts: mergeEfforts(base.efforts, patch.efforts),
    recent: Array.isArray(patch.recent) ? normalizeKeys(patch.recent, MAX_RECENT) : base.recent,
    favorites: Array.isArray(patch.favorites) ? normalizeKeys(patch.favorites, MAX_FAVORITES) : base.favorites,
    prefs: mergePrefs(base.prefs, patch.prefs)
  }
}

/* ── options and the remembered default selection ─────────────────────── */
// Both live in the same file as the State but outside it: State is the user's memory (what the
// picker shows), these two steer the host half itself.

/** `quiet` (default on): keep the default-model selection out of the profile config document. */
export function normalizeOptions(raw) {
  return { quiet: !isRecord(raw) || typeof raw.quiet !== 'boolean' ? true : raw.quiet }
}

/** `{ provider, model, reasoningEffort? }` with every field a bounded non-empty string, else `null`. */
export function normalizeSelection(raw) {
  if (!isRecord(raw) || !isId(raw.provider) || !isId(raw.model)) return null
  const selection = { provider: raw.provider, model: raw.model }
  if (raw.reasoningEffort !== undefined && raw.reasoningEffort !== null) {
    if (!isEffort(raw.reasoningEffort)) return null
    selection.reasoningEffort = raw.reasoningEffort
  }
  return selection
}

/** Two selections name the same provider, model and effort (a missing effort equals a missing effort). */
export function sameSelection(left, right) {
  if (!isRecord(left) || !isRecord(right)) return false
  return left.provider === right.provider && left.model === right.model && (left.reasoningEffort ?? null) === (right.reasoningEffort ?? null)
}

/** Options patches only ever carry known booleans; anything else is ignored. */
export function mergeOptions(options, patch) {
  const base = normalizeOptions(options)
  return isRecord(patch) && typeof patch.quiet === 'boolean' ? { quiet: patch.quiet } : base
}

/* ── state: persistence ───────────────────────────────────────────────── */

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function warn(message, error) {
  console.warn(`dsh-model-effort-picker: ${message}: ${error?.message ?? error}`)
}

const emptyDocument = () => ({ state: normalizeState(undefined), options: normalizeOptions(undefined), lastSelection: null, basis: null })

/** The whole file: the State, plus the host-only `options` and `lastSelection` that sit beside it. */
function parseDocument(text) {
  // Editors on Windows like to prepend a BOM, which JSON.parse rejects.
  const raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  return {
    state: normalizeState(raw),
    options: normalizeOptions(isRecord(raw) ? raw.options : undefined),
    lastSelection: normalizeSelection(isRecord(raw) ? raw.lastSelection : undefined),
    // The configured default as it was when `lastSelection` was remembered; see installQuietDefaults.
    basis: normalizeSelection(isRecord(raw) ? raw.lastBasis : undefined)
  }
}

/**
 * The persistent memory behind the routes.
 * @param opts.dir directory holding `state.json`; created on the first write.
 * @param opts.fs `node:fs/promises`-shaped module; injectable so tests can inject faults.
 * @param opts.readSync `readFileSync`-shaped function used only by {@link peek}, which must answer synchronously.
 */
export function createStateStore({ dir, fs = fsPromises, readSync = readFileSync } = {}) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('createStateStore: dir is required')
  const file = join(dir, STATE_FILE)
  // Same directory as the target, so the final rename never crosses a filesystem boundary.
  const tmp = join(dir, `${STATE_FILE}.${process.pid}.tmp`)
  let state // normalized State, set once the first load settles
  let options // host-only switches (see normalizeOptions)
  let lastSelection // the default model selection kept here instead of in the profile config, or null
  let basis // what the profile config said when lastSelection was remembered, or null
  let loading // the one initial load every caller shares
  let queue = Promise.resolve() // tail of the write chain; never rejects
  let dirty = false // memory holds something the file does not

  /** A missing, unreadable or corrupt file is not an error: memory simply starts empty. */
  async function loadFromDisk() {
    let text
    try {
      text = String(await fs.readFile(file, 'utf8'))
    } catch (error) {
      if (error?.code !== 'ENOENT') warn(`cannot read ${file}`, error)
      return emptyDocument()
    }
    try {
      return parseDocument(text)
    } catch (error) {
      warn(`ignoring unparsable ${file}`, error)
      return emptyDocument()
    }
  }

  /** First document wins: a synchronous peek and the async load read the same file, so they agree. */
  function adopt(document) {
    if (state !== undefined) return
    state = document.state
    options = document.options
    lastSelection = document.lastSelection
    basis = document.basis
  }

  function ensureLoaded() {
    loading ??= state !== undefined ? Promise.resolve() : loadFromDisk().then(adopt)
    return loading
  }

  async function replaceFile() {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fs.rename(tmp, file)
      } catch (error) {
        if (attempt >= RENAME_RETRIES || !RENAME_RETRY_CODES.has(error?.code)) throw error
        await sleep(RENAME_BACKOFF_MS * 2 ** attempt)
      }
    }
  }

  /**
   * Write whatever memory holds right now. Writes queued behind one that already saved the latest
   * state are no-ops, so a burst of patches costs one or two writes rather than one each.
   */
  async function writeLatest() {
    if (!dirty) return
    dirty = false
    try {
      // Defaults are left out so a file that only holds the State keeps its original shape.
      const document = { ...state, ...(options.quiet ? {} : { options }), ...(lastSelection === null ? {} : { lastSelection, ...(basis === null ? {} : { lastBasis: basis }) }) }
      const text = `${JSON.stringify(document, null, 2)}\n`
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(tmp, text, 'utf8')
      await replaceFile()
    } catch (error) {
      dirty = true // keep it unsaved so the next patch tries again
      warn(`cannot save ${file}`, error)
      try {
        await fs.rm(tmp, { force: true })
      } catch {
        // best effort: a leftover temp file is overwritten by the next attempt
      }
    }
  }

  function persist() {
    dirty = true
    // writeLatest reports its own failures; the catch only stops a surprise from wedging the chain for good.
    queue = queue.then(writeLatest).catch((error) => warn('write queue failed', error))
  }

  return {
    /** The current State (a copy: callers cannot corrupt the cache). */
    async read() {
      await ensureLoaded()
      return structuredClone(state)
    },
    /** Merge a Patch, remember it, queue the atomic write, and return the merged State. */
    async patch(patch) {
      await ensureLoaded()
      state = mergePatch(state, patch)
      persist()
      return structuredClone(state)
    },
    /** The host-only switches. */
    async readOptions() {
      await ensureLoaded()
      return { ...options }
    },
    /** Change a switch, persisting only when something actually changed. */
    async patchOptions(patch) {
      await ensureLoaded()
      const next = mergeOptions(options, patch)
      if (next.quiet !== options.quiet) {
        options = next
        persist()
      }
      return { ...options }
    },
    /**
     * Synchronous view for hooks that cannot wait (the default model is read on hot paths): the
     * options and the remembered selection. The first call reads the file with `readSync`.
     */
    peek() {
      if (state === undefined) {
        try {
          adopt(parseDocument(String(readSync(file, 'utf8'))))
        } catch (error) {
          if (error?.code !== 'ENOENT') warn(`cannot read ${file}`, error)
          adopt(emptyDocument())
        }
      }
      return { options: { ...options }, lastSelection: lastSelection === null ? null : { ...lastSelection }, basis: basis === null ? null : { ...basis } }
    },
    /**
     * Remember the default model selection together with the configured default seen right now (the
     * basis). Returns false when the selection is not valid.
     */
    async saveLastSelection(selection, configured) {
      const next = normalizeSelection(selection)
      if (next === null) return false
      await ensureLoaded()
      lastSelection = next
      basis = normalizeSelection(configured)
      persist()
      return true
    },
    /** Resolves once every write queued so far has finished (successfully or not). */
    async flush() {
      // A patch still waiting on the first load only queues its write after that load settles.
      await loading
      let seen
      do {
        seen = queue
        await seen
      } while (seen !== queue)
    }
  }
}

/* ── HTTP ─────────────────────────────────────────────────────────────── */

function reply(res, status, body, headers) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

/** Read one small JSON body; anything larger than the cap is refused. */
async function readJsonBody(req, limit = MAX_BODY_BYTES) {
  // An honest client declares its size: refuse before reading so the server can discard the rest.
  const declared = Number(req.headers?.['content-length'])
  if (Number.isFinite(declared) && declared > limit) throw new Error('body-too-large')
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += buffer.length
    if (size > limit) throw new Error('body-too-large')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('bad-json')
  }
}

function pathnameOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://dsh.internal').pathname
  } catch {
    return undefined
  }
}

/** A throwing fence must fail closed. */
function passes(fence, req) {
  try {
    return Boolean(fence(req))
  } catch {
    return false
  }
}

/**
 * Whitelist the few model fields the picker shows; the rest of what the llm service knows stays here.
 * Returns `undefined` when nothing usable is left, so `ok: true` always carries at least one field.
 */
function pickInfo(resolved) {
  if (!isRecord(resolved)) return undefined
  const info = {}
  if (typeof resolved.name === 'string' && resolved.name !== '') info.name = resolved.name.slice(0, MAX_NAME_LENGTH)
  const contextWindow = resolved.context?.contextWindow
  if (Number.isSafeInteger(contextWindow) && contextWindow > 0) info.contextWindow = contextWindow
  // An empty list is meaningful (the model takes no listed input), so presence is kept.
  if (Array.isArray(resolved.inputModalities)) {
    info.inputModalities = resolved.inputModalities
      .filter((entry) => typeof entry === 'string' && entry !== '' && entry.length <= MAX_MODALITY_LENGTH)
      .slice(0, MAX_MODALITIES)
  }
  return Object.keys(info).length === 0 ? undefined : info
}

/** `undefined` whenever the model cannot be resolved, for whatever reason. */
async function describeModel(getLlm, provider, model, timeoutMs) {
  let timer
  try {
    const llm = getLlm()
    if (typeof llm?.resolveModelInfo !== 'function') return undefined
    // Adapter lookups may reach the network; a stuck one must not leave the request hanging.
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs)
      timer.unref?.()
    })
    return pickInfo(await Promise.race([llm.resolveModelInfo(provider, model), timeout]))
  } catch {
    // Unknown provider or model, adapter failure, timeout, …: the picker just shows no extras.
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The route handler, built from injectable pieces so tests can drive it without a host.
 * @param deps.fence `(req) => boolean` — true when the request passed the connection fence.
 * @param deps.store the {@link createStateStore} instance behind `/state`.
 * @param deps.getLlm `() => llmService | undefined`, called per `/info` request.
 * @param deps.infoTimeoutMs longest `/info` waits for the llm service before answering unavailable.
 */
export function createHandler({ fence, store, getLlm = () => undefined, infoTimeoutMs = INFO_TIMEOUT_MS }) {
  /**
   * Read the state, or merge a patch first. Bad parts inside the patch are dropped by the merge;
   * only a patch that is not an object at all is refused. `null` counts as "no patch" so a client
   * that always sends the field can use it to just read.
   */
  async function stateRoute(body) {
    const { patch } = body
    if (patch !== undefined && patch !== null && !isRecord(patch)) return [400, { ok: false, error: 'bad-patch' }]
    const state = patch === undefined || patch === null ? await store.read() : await store.patch(patch)
    return [200, { ok: true, state }]
  }

  async function infoRoute(body) {
    const { provider, model } = body
    if (!isId(provider) || !isId(model)) return [400, { ok: false, error: 'bad-fields' }]
    const info = await describeModel(getLlm, provider, model, infoTimeoutMs)
    return [200, info === undefined ? { ok: false, error: 'unavailable' } : { ok: true, info }]
  }

  /** Read the host-only switches, or change them first (`{ patch: { quiet: boolean } }`). */
  async function optionsRoute(body) {
    const { patch } = body
    if (patch !== undefined && patch !== null && !isRecord(patch)) return [400, { ok: false, error: 'bad-patch' }]
    const options = patch === undefined || patch === null ? await store.readOptions() : await store.patchOptions(patch)
    return [200, { ok: true, options }]
  }

  const routes = new Map([
    [STATE_PATH, stateRoute],
    [INFO_PATH, infoRoute],
    [OPTIONS_PATH, optionsRoute]
  ])

  return async (req, res) => {
    if (!passes(fence, req)) return reply(res, 403, { ok: false, error: 'forbidden' })
    const route = routes.get(pathnameOf(req))
    if (route === undefined) return reply(res, 404, { ok: false, error: 'not-found' })
    if (req.method !== 'POST') return reply(res, 405, { ok: false, error: 'method' }, { allow: 'POST' })
    const type = String(req.headers?.['content-type'] ?? '')
    if (!/^application\/json\s*(?:;|$)/i.test(type)) return reply(res, 415, { ok: false, error: 'json-only' })
    let body
    try {
      body = await readJsonBody(req)
    } catch (error) {
      const code = error?.message === 'body-too-large' || error?.message === 'bad-json' ? error.message : 'bad-body'
      return reply(res, code === 'body-too-large' ? 413 : 400, { ok: false, error: code })
    }
    if (!isRecord(body)) return reply(res, 400, { ok: false, error: 'bad-body' })
    try {
      const [status, payload] = await route(body)
      return reply(res, status, payload)
    } catch (error) {
      warn('request failed', error)
      return reply(res, 500, { ok: false, error: 'internal' })
    }
  }
}

/* ── keeping the default model out of the profile config ──────────────── */

/**
 * By default DSH rewrites the `agent-default-model` row of the profile config on EVERY model or effort
 * switch ("remember the last choice for new sessions"). That edit broadcasts `settings/document-updated`,
 * and every client store listening to it re-reads the whole settings document; the theme service then
 * re-adopts its config and strips and re-applies every CSS variable on <body>, which — with a skin
 * plugin that overrides those variables — repaints the page without the skin for a frame or two.
 *
 * While the `quiet` option is on, the two service methods are taken over: the selection is kept in this
 * plugin's own state file (no config write, no event) and `currentSelection()` answers from it, so new
 * sessions still start with the model and effort last used. Turn the option off, or unload the plugin,
 * and the service behaves exactly as shipped (the original methods are restored). Any failure inside the
 * hooks falls through to the original behaviour.
 *
 * The configured default can still be edited by hand (settings page, YAML). Each remembered selection
 * therefore carries a basis: the configured default at that moment. `currentSelection()` answers with the
 * remembered selection only while the configuration still equals its basis; once someone has changed the
 * configuration since, the configuration wins and the next switch starts a fresh basis. The same rule
 * keeps a stale memory from shadowing a newer config write made while the option was off.
 *
 * @param service the `agentDefaultModel` service (`currentSelection()` / `saveSelection(next)`).
 * @param store the {@link createStateStore} instance.
 * @returns a function that puts the original methods back.
 */
export function installQuietDefaults(service, store) {
  if (typeof service?.currentSelection !== 'function' || typeof service?.saveSelection !== 'function') return () => {}
  const originalCurrent = service.currentSelection
  const originalSave = service.saveSelection
  const hadOwnCurrent = Object.hasOwn(service, 'currentSelection')
  const hadOwnSave = Object.hasOwn(service, 'saveSelection')

  const quietCurrent = function currentSelection() {
    const configured = originalCurrent.call(service)
    try {
      const { options, lastSelection, basis } = store.peek()
      // A missing basis (a file from before bases existed) is trusted as it stands.
      if (options.quiet && lastSelection !== null && (basis === null || sameSelection(basis, configured))) return lastSelection
    } catch (error) {
      warn('reading the remembered default model failed, using the configured one', error)
    }
    return configured
  }

  const quietSave = async function saveSelection(next) {
    let handled = false
    try {
      if (store.peek().options.quiet) handled = await store.saveLastSelection(next, originalCurrent.call(service))
    } catch (error) {
      warn('remembering the default model failed, falling back to the config document', error)
    }
    // Not handled (option off, invalid selection, or a failure): the shipped behaviour, config write included.
    if (!handled) return originalSave.call(service, next)
    return undefined
  }

  service.currentSelection = quietCurrent
  service.saveSelection = quietSave
  return () => {
    for (const [name, wrapper, original, hadOwn] of [
      ['currentSelection', quietCurrent, originalCurrent, hadOwnCurrent],
      ['saveSelection', quietSave, originalSave, hadOwnSave]
    ]) {
      if (service[name] !== wrapper) continue // someone else wrapped on top of us: leave their chain alone
      if (hadOwn) service[name] = original
      else delete service[name]
    }
  }
}

export function apply(ctx) {
  const store = createStateStore({ dir: join(resolveDshHome(), PLUGIN_DIR) })
  const handler = createHandler({
    fence: (req) => ctx.connection.requestRejection(req) === undefined,
    store,
    getLlm: () => ctx.get('llm')
  })
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'dsh-model-effort-picker: routes')
  // Optional: only profiles that mount the default-model service get the hooks; never block the routes on it.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentDefaultModel'], (inner) => {
      const service = inner.get('agentDefaultModel')
      inner.effect(() => installQuietDefaults(service, store), 'dsh-model-effort-picker: quiet default model')
    })
  }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, inject, maximizeDesktopWindow } from '../index.js'

function setup({ admission } = {}) {
  let registered
  const ctx = {
    webServer: {
      register(options) {
        registered = options
        return () => {}
      },
    },
    connection: { admit: () => admission },
    effect(fn) {
      fn()
    },
  }
  apply(ctx)
  return registered
}

function call(registered, method, url) {
  return new Promise((resolve) => {
    const res = {
      writeHead(code) {
        this.code = code
      },
      end(body) {
        resolve({ code: this.code, body: JSON.parse(body) })
      },
    }
    registered.handler({ method, url }, res)
  })
}

test('the host half asks for the web server and connection services', () => {
  assert.deepEqual(inject, ['webServer', 'connection'])
})

test('registers a prefix route under /dsh-tab/api', () => {
  const registered = setup({ admission: { peer: { principal: { kind: 'owner' } } } })
  assert.equal(registered.kind, 'prefix')
  assert.equal(registered.path, '/dsh-tab/api')
})

test('rejects requests that are not admitted as the owner', async () => {
  const rejected = await call(setup({ admission: { rejection: 403 } }), 'POST', '/dsh-tab/api/maximize')
  assert.equal(rejected.code, 403)
  const stranger = await call(
    setup({ admission: { peer: { principal: { kind: 'guest' } } } }),
    'POST',
    '/dsh-tab/api/maximize',
  )
  assert.equal(stranger.code, 403)
  const anonymous = await call(setup({ admission: undefined }), 'POST', '/dsh-tab/api/maximize')
  assert.equal(anonymous.code, 401)
})

test('unknown routes are 404 for the owner', async () => {
  const registered = setup({ admission: { peer: { principal: { kind: 'owner' } } } })
  const result = await call(registered, 'GET', '/dsh-tab/api/nope')
  assert.equal(result.code, 404)
})

test('maximize never touches a window this process did not start the app from', async () => {
  // Under node --test the parent process is not the DSH desktop executable, so the script's
  // guard refuses (Windows) or the platform check does (elsewhere); either way ok is false.
  const result = await maximizeDesktopWindow()
  assert.equal(result.ok, false)
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0)
})
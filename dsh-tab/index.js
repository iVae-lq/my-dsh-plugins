/**
 * dsh-tab 的宿主半。
 *
 * 标签栏的所有界面都在浏览器侧（`exports["./client"]`）。宿主侧只做一件浏览器做不到的事：
 * 「启动自动最大化」——渲染进程没有最大化窗口的接口，所以由宿主半在 Windows 桌面端
 * 调用系统的 ShowWindow(SW_MAXIMIZE)，只作用于启动本宿主进程的那个 DSH 桌面主窗口。
 *
 * 路由：POST /dsh-tab/api/maximize（需要 DSH 的 owner 连接凭证，和会话管理插件同一套认证）。
 */
import { spawn } from 'node:child_process'

export const name = 'dsh-tab'

export const inject = ['webServer', 'connection']

const API_PREFIX = '/dsh-tab/api'

/** PowerShell：只最大化「父进程 = 启动本宿主的桌面主进程」的窗口；父进程不是同一个可执行文件就什么都不做。 */
const MAXIMIZE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -Namespace DshTab -Name Win -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool IsZoomed(System.IntPtr hWnd);'
$p = Get-Process -Id ([int]$env:DSH_TAB_PPID) -ErrorAction SilentlyContinue
if (-not $p) { Write-Output 'no-parent'; exit 3 }
if ($p.Path -ne $env:DSH_TAB_EXEC) { Write-Output 'parent-is-not-the-desktop-app'; exit 4 }
$h = $p.MainWindowHandle
if ($h -eq [System.IntPtr]::Zero) { Write-Output 'no-window'; exit 5 }
if ([DshTab.Win]::IsZoomed($h)) { Write-Output 'already'; exit 0 }
[void][DshTab.Win]::ShowWindow($h, 3)
Write-Output 'maximized'
`

/** 最大化桌面主窗口；非 Windows / 不是桌面端启动的宿主返回 ok:false，不报错。 */
export function maximizeDesktopWindow() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, reason: 'unsupported-platform' })
      return
    }
    let output = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          Buffer.from(MAXIMIZE_SCRIPT, 'utf16le').toString('base64'),
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'ignore'],
          env: { ...process.env, DSH_TAB_PPID: String(process.ppid), DSH_TAB_EXEC: process.execPath },
        },
      )
    } catch (error) {
      finish({ ok: false, reason: 'spawn-failed', error: String(error?.message ?? error) })
      return
    }
    const timeout = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      finish({ ok: false, reason: 'timeout' })
    }, 20000)
    child.stdout.on('data', (chunk) => {
      output += String(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      finish({ ok: false, reason: 'spawn-failed', error: String(error?.message ?? error) })
    })
    child.on('close', (code) => {
      clearTimeout(timeout)
      const result = output.trim().split(/\r?\n/).pop() ?? ''
      finish({ ok: code === 0, reason: result || `exit-${code}` })
    })
  })
}

const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** 和会话管理插件同一套：必须通过 DSH 连接准入，且是 owner。 */
function authenticate(ctx, req) {
  const connection = ctx.connection ?? (typeof ctx.get === 'function' ? ctx.get('connection') : undefined)
  if (!connection || typeof connection.admit !== 'function') {
    return { ok: false, status: 503, error: 'DSH connection service unavailable' }
  }
  try {
    const admission = connection.admit(req)
    if (!admission || typeof admission !== 'object') return { ok: false, status: 401, error: 'unauthorized' }
    if ('rejection' in admission) {
      const status = typeof admission.rejection === 'number' ? admission.rejection : 401
      return { ok: false, status, error: status === 403 ? 'forbidden' : 'unauthorized' }
    }
    if (admission.peer?.principal?.kind !== 'owner') return { ok: false, status: 403, error: 'owner required' }
    return { ok: true }
  } catch (error) {
    return { ok: false, status: 403, error: String(error?.message ?? error) }
  }
}

export function apply(ctx) {
  const webServer = ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') return
  ctx.effect(
    () =>
      webServer.register({
        kind: 'prefix',
        path: API_PREFIX,
        handler: async (req, res) => {
          const auth = authenticate(ctx, req)
          if (!auth.ok) {
            send(res, auth.status, { ok: false, error: auth.error })
            return
          }
          const url = new URL(req.url ?? '/', 'http://localhost')
          const path = url.pathname.startsWith(API_PREFIX) ? url.pathname.slice(API_PREFIX.length) || '/' : '/'
          if (req.method === 'POST' && path === '/maximize') {
            send(res, 200, await maximizeDesktopWindow())
            return
          }
          send(res, 404, { ok: false, error: 'not found' })
        },
      }),
    'dsh-tab: host api',
  )
}

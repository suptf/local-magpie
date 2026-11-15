// local-magpie：magpie（yetone/magpie）插件内置方案。
// 二进制随插件目录分发（bin/magpie），代码一律走绝对路径，不依赖 PATH 上的 magpie。
// 版本更新只交给 Web UI（serve --web，http://127.0.0.1:3430/?k=…）里的更新按钮
// （serve 就地替换当前运行路径的二进制、同 pid 用原参数重启），插件侧不跑 magpie update，
// 避免和 serve 自更新打架。
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'local-magpie'

// 唯一入口：二进制绝对路径（import.meta.url 解析），不依赖 PATH。
const BIN = fileURLToPath(new URL('../bin/magpie', import.meta.url))
const BINDIR = dirname(BIN)
const SERVE_LOG = join(BINDIR, 'serve.log')
const GATEWAY = 'http://127.0.0.1:3425'
const WEB = 'http://127.0.0.1:3430'

// —— 基础链接：dsh-go 引擎到 magpie 的 baseURL ——
// magpie「资源库 → billion-context」给 DeepSeek Harness 打开时，会把引擎的 magpie 路由写成
// http://127.0.0.1:8787/bili/http://127.0.0.1:3425/v1（经 billion-context 的 bili 代理）。
// 引擎重启后 magpie 是新拉起的，但 bili 代理不会自动补拉（实测如此），引擎仍指着 8787 → 连不上；
// 手工在 magpie 里关掉再打开 DeepSeek Harness 开关才会重跑安装程序把代理拉起来。
// 这里在引擎加载本插件时（含每次重启）自动把这条链路修好。
const DSH_HOME_DIR = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const BILI_PROXY_ORIGIN = join(homedir(), '.local', 'state', 'billion-context', 'proxy-origin')
const BILI_CLI = join(homedir(), '.local', 'bin', 'bili')
const BILI_SERVE_LOG = join(homedir(), '.config', 'magpie', 'bili-start.log')
const BILI_DEFAULT_ORIGIN = 'http://127.0.0.1:8787'
const MAGPIE_UPSTREAM = 'http://127.0.0.1:3425/v1'
const BILI_RESPAWN_COOLDOWN_MS = 60000
const BILI_BOOT_TIMEOUT_MS = 75000
const BILI_MAX_SPAWNS = 2

// 基础链接的运行态（引擎内存里，重启引擎即清空；供面板/状态条展示）。
const link = { mode: 'off', state: 'idle', detail: '', attempts: 0, lastSpawn: 0, busy: false }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function httpOk(url, ms = 6000) {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), ms)
    const r = await fetch(url, { signal: ctl.signal })
    clearTimeout(t)
    return r.status === 200
  } catch {
    return false
  }
}

// magpie 写的 dsh 路由里 magpie 供应商的 baseURL（6/8 空格缩进；/bili/ 形式说明 billion-context 已启用）。
const BILI_ROUTE_RE = /^( {6}| {8})baseURL: (http:\/\/127\.0\.0\.1:\d+)\/bili\/(http:\/\/127\.0\.0\.1:3425\/v1)[ \t]*$/gm
function routeFiles() {
  const out = [join(DSH_HOME_DIR, 'settings.yaml')]
  try {
    for (const name of readdirSync(join(DSH_HOME_DIR, 'profiles'))) {
      const p = join(DSH_HOME_DIR, 'profiles', name, 'cordis.patch.yml')
      if (existsSync(p)) out.push(p)
    }
  } catch {}
  return out
}
function readRoutes() {
  const out = []
  for (const file of routeFiles()) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    for (const m of text.matchAll(BILI_ROUTE_RE)) out.push({ file, indent: m[1], origin: m[2], upstream: m[3], value: `${m[2]}/bili/${m[3]}` })
  }
  return out
}
function rewriteRoutes(routes, origin) {
  for (const r of routes) {
    const value = origin ? `${origin}/bili/${r.upstream}` : r.upstream
    const lines = readFileSync(r.file, 'utf8').split('\n')
    const idx = lines.findIndex((l) => l === `${r.indent}baseURL: ${r.value}`)
    if (idx >= 0) {
      lines[idx] = `${r.indent}baseURL: ${value}`
      try { writeFileSync(r.file, lines.join('\n')) } catch {}
    }
  }
}

function biliOriginFromState() {
  try {
    const o = JSON.parse(readFileSync(BILI_PROXY_ORIGIN, 'utf8'))
    if (typeof o.origin === 'string' && o.origin.startsWith('http')) return o.origin
    if (Number.isInteger(o.port) && o.port > 0) return `http://127.0.0.1:${o.port}`
  } catch {}
  return BILI_DEFAULT_ORIGIN
}

const chainUrl = (origin) => `${origin}/bili/${MAGPIE_UPSTREAM}/models`

function biliAlive() {
  return spawnSync('pgrep', ['-f', 'bili start'], { timeout: 5000 }).status === 0
}
function killBili() {
  spawnSync('pkill', ['-f', 'bili start'], { timeout: 5000 })
}
function spawnBili(port) {
  if (!existsSync(BILI_CLI)) return
  try { mkdirSync(dirname(BILI_SERVE_LOG), { recursive: true }) } catch {}
  const logFd = openSync(BILI_SERVE_LOG, 'a')
  try {
    const child = spawn(process.execPath, [BILI_CLI, 'start', '--port', String(port)], { detached: true, stdio: ['ignore', logFd, logFd] })
    child.unref()
  } catch {}
  closeSync(logFd)
}

async function waitChain(origin) {
  const end = Date.now() + BILI_BOOT_TIMEOUT_MS
  for (;;) {
    if (await httpOk(chainUrl(origin))) return true
    if (Date.now() >= end) return false
    await sleep(2000)
  }
}

// 引擎启动（含重启）/ 定时巡检 / 面板点按共用的一条修链流程。
async function repairBaseLink(reason) {
  if (link.busy) return
  link.busy = true
  try {
    const routes = readRoutes()
    if (!routes.length) { link.mode = 'off'; link.state = 'idle'; link.detail = ''; return }
    link.mode = 'bili'
    const stateOrigin = biliOriginFromState()
    if (await httpOk(chainUrl(stateOrigin))) { link.state = 'ok'; link.detail = stateOrigin; return }
    const routeOrigin = routes[0].origin
    if (stateOrigin !== routeOrigin && await httpOk(chainUrl(routeOrigin))) { link.state = 'ok'; link.detail = routeOrigin; return }
    link.state = 'fixing'
    link.detail = reason
    if (link.attempts >= BILI_MAX_SPAWNS) { link.state = 'failed'; return }
    // 网关先要在。
    if (!isRunning()) startServe()
    for (let i = 0; i < 10 && httpCode(`${GATEWAY}/v1/models`) !== 200; i++) await sleep(1500)
    // bili 楔死（在跑但链路不通）就关掉重拉；没了就补拉——等价于在 magpie 里关掉再打开开关。
    if (biliAlive()) {
      killBili()
      for (let i = 0; i < 15 && biliAlive(); i++) await sleep(300)
    }
    const now = Date.now()
    if (!biliAlive() && now - link.lastSpawn >= BILI_RESPAWN_COOLDOWN_MS && link.attempts < BILI_MAX_SPAWNS) {
      const port = stateOrigin === BILI_DEFAULT_ORIGIN ? 8787 : Number(new URL(stateOrigin).port)
      spawnBili(port)
      link.lastSpawn = now
      link.attempts++
    }
    if (await waitChain(stateOrigin)) { link.state = 'ok'; link.detail = stateOrigin; return }
    // 端口漂移：状态文件里的 origin 能通但路由写的是旧端口 → 回写路由。
    if (stateOrigin !== routeOrigin && (await httpOk(chainUrl(stateOrigin)))) {
      rewriteRoutes(routes, stateOrigin)
      link.state = 'ok'
      link.detail = stateOrigin
      return
    }
    if (link.attempts >= BILI_MAX_SPAWNS) {
      // 代理实在起不来：退回直连，至少让 dsh-go 连得上（压缩暂不可用）。
      rewriteRoutes(routes, null)
      link.mode = 'direct'
      link.state = 'degraded'
    } else {
      link.state = 'failed'
    }
  } finally {
    link.busy = false
  }
}

function linkLabel(zh) {
  if (link.mode === 'direct') return zh ? '已降级直连 magpie' : 'direct to magpie'
  if (link.mode === 'off') return zh ? 'billion-context 未启用' : 'billion-context off'
  const port = (() => { try { return new URL(link.detail).port } catch { return '' } })()
  switch (link.state) {
    case 'ok': return zh ? `经 bili ${port || '8787'} · 正常` : `via bili ${port || '8787'} · ok`
    case 'fixing': return zh ? '正在修复基础链接…' : 'repairing base link…'
    case 'failed': return zh ? 'bili 代理未恢复' : 'bili proxy down'
    case 'idle': return zh ? '—' : '—'
    default: return zh ? '基础链接检测中…' : 'checking base link…'
  }
}

const isZh = (locale) => !String(locale ?? 'zh').startsWith('en')

function httpCode(url) {
  const r = spawnSync('curl', ['-sS', '-m', '5', '-o', '/dev/null', '-w', '%{http_code}', url], { timeout: 8000 })
  if (r.status !== 0) return null
  const code = parseInt(String(r.stdout).trim(), 10)
  return Number.isFinite(code) ? code : null
}

function webLink() {
  try {
    const m = String(readFileSync(SERVE_LOG, 'utf8')).match(/magpie web on (http:\/\/\S+)/g)
    if (m?.length) return m[m.length - 1].replace(/^magpie web on /, '')
  } catch {}
  return null
}

function readState() {
  const s = {
    installed: existsSync(BIN),
    version: null,
    running: false,
    http: null,
  }
  if (s.installed) {
    const v = spawnSync(BIN, ['--version'], { timeout: 8000 })
    if (v.status === 0) s.version = String(v.stdout).trim()
  }
  s.running = spawnSync('pgrep', ['-f', `${BIN} serve`], { timeout: 5000 }).status === 0
  if (s.running) s.http = httpCode(`${GATEWAY}/v1/models`)
  return s
}

function stripText(s, zh) {
  if (!s.installed) return zh ? 'magpie 未安装' : 'magpie: not installed'
  let base
  if (s.running) base = zh ? 'magpie 运行中' : 'magpie: running'
  else return `magpie ${s.version ?? '已装'}`.slice(0, 24)
  if (link.mode === 'bili' && link.state !== 'ok' && link.state !== 'idle') return zh ? `${base}·链接异常` : `${base}·link bad`
  return base
}

function panelData(s, caps) {
  const zh = isZh(caps?.locale)
  let statusLine
  if (!s.installed) statusLine = zh ? '还没装 magpie（二进制不在插件目录里）' : 'magpie binary missing from plugin dir'
  else if (s.running) statusLine = zh ? '网关运行中（3425）· Web UI 在 3430' : 'Gateway on 3425 · Web UI on 3430'
  else statusLine = zh ? '已安装，网关未运行' : 'Installed, gateway not running'

  let httpLabel
  if (!s.installed) httpLabel = '—'
  else if (!s.running) httpLabel = zh ? '未运行' : 'not running'
  else if (s.http === 200) httpLabel = '200 OK'
  else httpLabel = zh ? `请求失败（${s.http ?? '无响应'}）` : `request failed (${s.http ?? 'no response'})`

  return {
    statusLine,
    versionLabel: s.version ?? (zh ? '未安装' : 'not installed'),
    httpLabel,
    webLabel: s.running ? (zh ? '3430 · 「打开 Web UI」用默认浏览器' : '3430 · Open Web UI uses default') : (zh ? '未启动' : 'not running'),
    linkLabel: linkLabel(zh),
    gateway: GATEWAY,
  }
}

function startServe() {
  try { mkdirSync(BINDIR, { recursive: true }) } catch {}
  const logFd = openSync(SERVE_LOG, 'a')
  const child = spawn(BIN, ['serve', '--web'], { detached: true, stdio: ['ignore', logFd, logFd] })
  child.unref()
  closeSync(logFd)
}

function isRunning() {
  return spawnSync('pgrep', ['-f', `${BIN} serve`], { timeout: 5000 }).status === 0
}

function viewChildren(zh) {
  const kids = [
    { type: 'text', text: { $: 'data.statusLine' } },
    { type: 'metric', label: '版本', value: { $: 'data.versionLabel' } },
    { type: 'keyValue', items: [
      ['网关', GATEWAY],
      ['Web UI', { $: 'data.webLabel' }],
      ['/v1/models', { $: 'data.httpLabel' }],
      ['基础链接', { $: 'data.linkLabel' }],
    ] },
    { type: 'actions', items: [
      { label: '启动网关', action: 'start', icon: 'play' },
      { label: '关闭网关', action: 'stop', icon: 'stop' },
      { label: '打开 Web UI', action: 'open', icon: 'external' },
      { label: zh ? '复制网关链接' : 'Copy gateway link', action: 'copy-link', icon: 'copy' },
    ] },
  ]
  return kids
}

export function apply(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    let stripEmit = null
    let panelEmit = null
    let lastZh = true
    let lastCaps = null

    const push = () => {
      const s = readState()
      if (stripEmit) stripEmit({ text: stripText(s, lastZh) })
      if (panelEmit) panelEmit(panelData(s, lastCaps))
    }

    ctx.dshGo.strip('magpie-status', (scope, emit, caps) => {
      lastZh = isZh(caps?.locale)
      stripEmit = emit
      push()
      const timer = setInterval(push, 15000)
      return () => {
        clearInterval(timer)
        if (stripEmit === emit) stripEmit = null
      }
    })

    ctx.dshGo.panel('magpie', {
      view: (scope, caps) => ({
        type: 'stack',
        title: 'magpie 网关',
        children: viewChildren(isZh(caps?.locale)),
      }),
      data: (scope, emit, caps) => {
        lastCaps = caps
        panelEmit = emit
        push()
        const timer = setInterval(push, 2000)
        return () => {
          clearInterval(timer)
          if (panelEmit === emit) panelEmit = null
        }
      },
      actions: {
        start: (scope, event) => {
          const zh = isZh(event?.locale)
          if (!existsSync(BIN)) return { toast: zh ? '还没装 magpie' : 'magpie not installed' }
          if (isRunning()) return { toast: zh ? '网关已在运行' : 'Gateway already running' }
          startServe()
          return { toast: zh ? '正在启动网关 + Web UI…' : 'Starting gateway + Web UI…' }
        },
        stop: (scope, event) => {
          const zh = isZh(event?.locale)
          spawnSync('pkill', ['-f', `${BIN} serve`], { timeout: 5000 })
          push()
          return { toast: zh ? '已关闭网关' : 'Gateway stopped' }
        },
        open: (scope, event) => {
          const zh = isZh(event?.locale)
          const link = webLink()
          if (!link) return { toast: zh ? 'Web UI 还没就绪（启动网关试试）' : 'Web UI not ready (start gateway first)' }
          // 协议 link 效果只收 https，本机面板是 http；直接从引擎发 Android intent 调起默认浏览器。
          const r = spawnSync('/system/bin/cmd', ['activity', 'start', '-a', 'android.intent.action.VIEW', '-d', link], { timeout: 2500 })
          if (r.status === 0) return { toast: zh ? '已用默认浏览器打开 Web UI' : 'Opened Web UI in browser' }
          return { copy: link, toast: zh ? '打不开，已复制链接' : 'Failed to open; link copied' }
        },
        'copy-link': (scope, event) => {
          const zh = isZh(event?.locale)
          const link = webLink()
          if (!link) return { toast: zh ? 'Web UI 还没就绪（启动网关试试）' : 'Web UI not ready (start gateway first)' }
          return { copy: link, toast: zh ? '已复制网关链接' : 'Gateway link copied' }
        },
        uninstall: (scope, event) => {
          const zh = isZh(event?.locale)
          spawnSync('pkill', ['-f', `${BIN} serve`], { timeout: 5000 })
          try { rmSync(BINDIR, { recursive: true, force: true }) } catch {}
          push()
          return { toast: zh ? '已卸载 magpie' : 'magpie removed' }
        },
      },
    })

    // 引擎（含重启）加载本插件时，若网关没在跑就自动拉起来。
    if (existsSync(BIN) && !isRunning()) startServe()
    // 引擎（含重启）加载本插件时，顺手修好 dsh-go → magpie 的基础链接：
    // bili 代理死了自动补拉、端口漂移自动回写路由，起不来才降级直连。
    void repairBaseLink('引擎启动')
    const linkTimer = setInterval(() => { void repairBaseLink('定时巡检') }, 30000)
    if (typeof linkTimer.unref === 'function') linkTimer.unref()
  })
}

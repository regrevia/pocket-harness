// 「经我们的中转服务器」：不用 SSH、不用对方有账号，插件自己往服务器拉一条 WebSocket，
// 公网请求顺着这条连接回来（和 cloudflared 一个思路）。
//
// 与 public.mjs 的分工：
//   public.mjs = 自己的服务器 + ssh -R（对面要有账号，只适合自己用）
//   relay.mjs  = 我们的中转（只给 slug + 密钥，适合给朋友用）
//
// 配置只落这台电脑：~/.dsh/pet-voice/relay.json（0600）
//   { enabled, slug, secret, wsUrl, publicBase }
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { classifyPublicPath, publicState } from './public.mjs'
import { forwardPath } from './guardPath.mjs'

const DIR = join(homedir(), '.dsh/pet-voice')
const CONFIG_PATH = join(DIR, 'relay.json')
const DEFAULT_WS = 'wss://pet.regrevia.com/relay/ws'
const DEFAULT_BASE = 'https://pet.regrevia.com/r/%s/pet-voice/'

const state = {
  socket: null,
  localPort: 0,
  since: 0,
  lastError: '',
  connected: false,
  tries: 0,
  timer: null,
}

export function getRelayConfig() {
  let raw = {}
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch {
    /* 没配过 */
  }
  return {
    enabled: raw.enabled === true,
    slug: String(raw.slug ?? '').trim(),
    secret: String(raw.secret ?? '').trim(),
    wsUrl: String(raw.wsUrl ?? '').trim() || DEFAULT_WS,
    publicBase: String(raw.publicBase ?? '').trim(),
  }
}

export function setRelayConfig(patch = {}) {
  const next = { ...getRelayConfig(), ...patch }
  mkdirSync(DIR, { recursive: true })
  const tmp = `${CONFIG_PATH}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, CONFIG_PATH)
  if (!next.enabled) stopRelay()
  else if (state.localPort) startRelay({ port: state.localPort })
  return next
}

export function relayBase(cfg = getRelayConfig()) {
  const raw = String(cfg.publicBase ?? '').trim().replace(/\/+$/, '')
  if (raw) {
    // 只认「…/pet-voice」收尾的地址：少了这一段，配对链接和二维码都指向不存在的路径
    if (/^https?:\/\/[^/]+\/(?:r\/[^/]+\/)?pet-voice$/.test(raw)) return `${raw}/`
    state.lastError = `publicBase 不合规（要 …/pet-voice）：${raw}`
  }
  if (!cfg.slug) return ''
  return DEFAULT_BASE.replace('%s', encodeURIComponent(cfg.slug))
}

export function relayState() {
  const cfg = getRelayConfig()
  return {
    ok: true,
    enabled: cfg.enabled,
    slug: cfg.slug,
    hasSecret: Boolean(cfg.secret),
    base: relayBase(cfg),
    connected: state.connected,
    since: state.since || null,
    lastError: state.lastError,
    tries: state.tries,
    localPort: state.localPort || null,
    // 中转不可达时，面板要能说清「现在手机走的是哪条路」
    public: publicState(),
  }
}

function forwardLocal(port, msg) {
  return new Promise((resolve) => {
    let body = null
    if (msg.body) {
      try {
        body = Buffer.from(msg.body, 'base64')
      } catch {
        body = null
      }
    }
    const headers = { ...(msg.headers ?? {}) }
    headers.host = `127.0.0.1:${port}`
    if (body) headers['content-length'] = String(body.length)
    const req = httpRequest(
      { host: '127.0.0.1', port, method: msg.method || 'GET', path: msg.path || '/', headers, timeout: 120000 },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const out = Buffer.concat(chunks)
          const outHeaders = {}
          for (const [k, v] of Object.entries(res.headers)) {
            if (['connection', 'keep-alive', 'transfer-encoding', 'content-length'].includes(k)) continue
            outHeaders[k] = Array.isArray(v) ? v.join(', ') : v
          }
          resolve({ id: msg.id, status: res.statusCode ?? 502, headers: outHeaders, body: out.toString('base64') })
        })
      },
    )
    req.on('error', () => resolve({ id: msg.id, status: 502, headers: {}, body: Buffer.from('{"ok":false,"error":"local-down"}').toString('base64') }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ id: msg.id, status: 504, headers: {}, body: Buffer.from('{"ok":false,"error":"local-timeout"}').toString('base64') })
    })
    if (body) req.write(body)
    req.end()
  })
}

/** 面板门禁：中转进来的是公网流量，面板相关路径一律不转（和 public.mjs 同一套判定）。 */
function allowed(path) {
  const verdict = classifyPublicPath(path)
  return verdict.status === 0 ? verdict.target : null
}

export function startRelay({ port } = {}) {
  // 保留 tries：退避要真的往上爬（否则地址写错就永远 2 s 一次重连）
  stopRelay({ keepConfig: true })
  state.localPort = Number(port) || state.localPort
  const cfg = getRelayConfig()
  if (!cfg.enabled || !cfg.slug || !cfg.secret || !state.localPort) return relayState()

  const url = `${cfg.wsUrl}?slug=${encodeURIComponent(cfg.slug)}&secret=${encodeURIComponent(cfg.secret)}`
  let ws
  try {
    ws = new WebSocket(url)
  } catch (err) {
    state.lastError = `建连接失败：${err.message}`
    return relayState()
  }
  state.socket = ws
  state.tries += 1

  ws.addEventListener('open', () => {
    state.connected = true
    state.since = Date.now()
    state.lastError = ''
  })

  ws.addEventListener('message', async (ev) => {
    let msg
    try {
      msg = JSON.parse(String(ev.data))
    } catch {
      return
    }
    if (msg.t === 'ping') {
      try {
        ws.send(JSON.stringify({ t: 'pong' }))
      } catch {
        /* 连接已经断了，close 会重连 */
      }
      return
    }
    if (!msg.id) return
    const target = allowed(String(msg.path ?? ''))
    if (!target) {
      const body = Buffer.from(JSON.stringify({ ok: false, error: 'forbidden' }))
      ws.send(JSON.stringify({ id: msg.id, status: 403, headers: {}, body: body.toString('base64') }))
      return
    }
    const answer = await forwardLocal(state.localPort, { ...msg, path: forwardPath(target) })
    try {
      ws.send(JSON.stringify(answer))
    } catch {
      /* 断了就算了，对方会超时 */
    }
  })

  // close 与 error 可能先后到；只认第一次，否则会排两个重连定时器，两边互抢同一条连接。
  let failed = false
  const fail = (reason) => {
    if (failed) return
    failed = true
    if (state.socket !== ws) return
    state.connected = false
    state.lastError = reason
    stopRelay({ keepConfig: true })
    state.timer = setTimeout(() => startRelay({ port: state.localPort }), Math.min(30_000, 2000 * Math.max(1, state.tries)))
    state.timer.unref?.()
  }
  ws.addEventListener('close', () => fail('连接已断开'))
  ws.addEventListener('error', (e) => fail(`连接出错：${e?.message ?? e?.type ?? 'unknown'}`))
  return relayState()
}

export function stopRelay({ keepConfig = false } = {}) {
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
  const ws = state.socket
  state.socket = null
  state.connected = false
  if (ws) {
    try {
      ws.close(1000, 'stopped')
    } catch {
      /* 已经关了 */
    }
  }
  if (!keepConfig) state.tries = 0
  return relayState()
}

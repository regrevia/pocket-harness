#!/usr/bin/env node
/**
 * 宠物中转服务：把 `http://<服务器>/r/<slug>/pet-voice/...` 转发到该用户的 Mac 上。
 *
 * 为什么不用 ssh -R：那要求对方机器有我们的 SSH 账号，等于把服务器 shell 交出去。
 * 这里改成对方（插件）主动往服务器建一条 WebSocket，请求顺着这条连接回去，
 * 服务器只知道「哪个 slug 在线」，不需要对方有账号。
 *
 * 隔离：每个 slug 一条独立连接、独立密钥；请求只可能落到自己那条连接上，
 * 不同用户之间没有共享端口、共享进程，也没有共享令牌。
 *
 * 协议（WS 上，JSON 一行一条）：
 *   服务器 → 插件  { id, method, path, headers, body }        body 是 base64
 *   插件 → 服务器  { id, status, headers, body }              body 是 base64
 *   心跳          { t: 'ping' } / { t: 'pong' }
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.RELAY_PORT ?? 8090)
const HOST = process.env.RELAY_HOST ?? '127.0.0.1'
const TENANTS_FILE = process.env.RELAY_TENANTS ?? '/etc/pet-relay/tenants.json'
const MAX_BODY = Number(process.env.RELAY_MAX_BODY ?? 12 * 1024 * 1024)
const TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS ?? 30_000)

const HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding',
])

function loadTenants() {
  try {
    const raw = JSON.parse(readFileSync(TENANTS_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch (err) {
    console.error(`[relay] cannot read ${TENANTS_FILE}: ${err.message}`)
    return {}
  }
}

function safeEq(a, b) {
  const ab = Buffer.from(String(a ?? ''))
  const bb = Buffer.from(String(b ?? ''))
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

/** slug → { ws, tenant } */
const online = new Map()
/** 请求 id → { resolve, timer } */
const pending = new Map()
let nextId = 1

const wss = new WebSocketServer({ noServer: true })

function closeWith(ws, code, reason) {
  try { ws.close(code, reason) } catch {}
}

wss.on('connection', (ws, slug) => {
  const prev = online.get(slug)
  if (prev) closeWith(prev, 4001, 'superseded')
  online.set(slug, ws)
  console.log(`[relay] online slug=${slug} total=${online.size}`)

  const ping = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ t: 'ping' }))
  }, 25_000)

  ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(String(data)) } catch { return }
    if (msg.t === 'pong') return
    const hit = msg.id && pending.get(msg.id)
    if (!hit) return
    pending.delete(msg.id)
    clearTimeout(hit.timer)
    hit.resolve(msg)
  })

  const drop = () => {
    clearInterval(ping)
    if (online.get(slug) === ws) online.delete(slug)
    for (const [id, p] of pending) {
      if (p.slug !== slug) continue
      pending.delete(id)
      clearTimeout(p.timer)
      p.resolve(null)
    }
    console.log(`[relay] offline slug=${slug} total=${online.size}`)
  }
  ws.on('close', drop)
  ws.on('error', (err) => {
    console.error(`[relay] ws error slug=${slug}: ${err.message}`)
    drop()
  })
})

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJSON(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj))
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length })
  res.end(body)
}

async function handleRelayRequest(req, res, slug, rest) {
  const tenants = loadTenants()
  const tenant = tenants[slug]
  if (!tenant) return sendJSON(res, 404, { ok: false, error: 'unknown-slug' })

  const ws = online.get(slug)
  if (!ws || ws.readyState !== ws.OPEN) {
    return sendJSON(res, 503, { ok: false, error: 'owner-offline', slug })
  }

  let bodyBuf = Buffer.alloc(0)
  try { bodyBuf = await readBody(req) } catch { return sendJSON(res, 413, { ok: false, error: 'too-large' }) }

  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP.has(k.toLowerCase())) continue
    headers[k] = Array.isArray(v) ? v.join(', ') : v
  }

  const id = String(nextId++)
  const answer = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(null)
    }, TIMEOUT_MS)
    pending.set(id, { resolve, timer, slug })
    ws.send(JSON.stringify({
      id,
      method: req.method,
      path: rest || '/',
      headers,
      body: bodyBuf.length ? bodyBuf.toString('base64') : '',
    }), (err) => {
      if (!err) return
      pending.delete(id)
      clearTimeout(timer)
      resolve(null)
    })
  })

  if (!answer) return sendJSON(res, 502, { ok: false, error: 'owner-timeout' })

  const out = answer.body ? Buffer.from(answer.body, 'base64') : Buffer.alloc(0)
  const outHeaders = {}
  for (const [k, v] of Object.entries(answer.headers ?? {})) {
    if (HOP.has(k.toLowerCase())) continue
    outHeaders[k] = v
  }
  outHeaders['content-length'] = String(out.length)
  res.writeHead(Number(answer.status) || 502, outHeaders)
  res.end(out)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://relay')
  const path = url.pathname

  if (path === '/relay/health') {
    const tenants = loadTenants()
    return sendJSON(res, 200, {
      ok: true,
      tenants: Object.keys(tenants).length,
      online: [...online.keys()],
      pending: pending.size,
      uptime: Math.round(process.uptime()),
    })
  }

  if (path === '/relay/ws') {
    res.writeHead(400, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ ok: false, error: 'websocket-only' }))
  }

  const m = /^\/r\/([a-z0-9][a-z0-9-]{1,31})(\/.*)?$/.exec(path)
  if (!m) return sendJSON(res, 404, { ok: false, error: 'not-found' })

  const [, slug, tail] = m
  let rest = tail ?? '/'
  const qs = url.search
  if (qs) rest += qs
  return handleRelayRequest(req, res, slug, rest)
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://relay')
  if (url.pathname !== '/relay/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
    return socket.destroy()
  }
  const slug = url.searchParams.get('slug') ?? ''
  const secret = url.searchParams.get('secret') ?? ''
  const tenant = loadTenants()[slug]
  if (!tenant || !safeEq(tenant.secret, secret)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, slug))
})

server.listen(PORT, HOST, () => {
  console.log(`[relay] listening on ${HOST}:${PORT}, tenants=${TENANTS_FILE}`)
})

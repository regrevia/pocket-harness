#!/usr/bin/env node
/**
 * 中转租户管理：在服务器上跑（node admin.mjs <cmd>）。
 *
 *   node admin.mjs list
 *   node admin.mjs add <slug> [note]      # 生成密钥，打印给对方的接入串
 *   node admin.mjs del <slug>
 *   node admin.mjs show <slug>
 *
 * tenants.json 结构：{ "<slug>": { secret, note, createdAt } }
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'

const FILE = process.env.RELAY_TENANTS ?? '/etc/pet-relay/tenants.json'
const PUBLIC_BASE = process.env.RELAY_PUBLIC_BASE ?? 'https://pet.regrevia.com'

function load() {
  try { return JSON.parse(readFileSync(FILE, 'utf8')) } catch { return {} }
}

function save(obj) {
  mkdirSync(dirname(FILE), { recursive: true })
  const tmp = `${FILE}.tmp`
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, FILE)
}

const [cmd, ...rest] = process.argv.slice(2)
const tenants = load()

const slugOk = (s) => /^[a-z0-9][a-z0-9-]{1,31}$/.test(s)

if (cmd === 'list') {
  const rows = Object.entries(tenants)
  if (!rows.length) console.log('（没有租户）')
  for (const [slug, t] of rows) console.log(`${slug}\t${t.note ?? ''}\t${t.createdAt ?? ''}`)
} else if (cmd === 'add') {
  const slug = rest[0]
  if (!slugOk(slug ?? '')) {
    console.error('slug 只允许小写字母/数字/短横线，2–32 位')
    process.exit(1)
  }
  if (tenants[slug]) {
    console.error(`已存在：${slug}`)
    process.exit(1)
  }
  tenants[slug] = {
    secret: randomBytes(24).toString('base64url'),
    note: rest.slice(1).join(' ') || '',
    createdAt: new Date().toISOString(),
  }
  save(tenants)
  console.log('已添加。把下面两行给对方：')
  console.log(`  中转地址：${PUBLIC_BASE}/r/${slug}/pet-voice/`)
  console.log(`  中转密钥：${tenants[slug].secret}`)
} else if (cmd === 'del') {
  const slug = rest[0]
  if (!tenants[slug]) { console.error('没有这个 slug'); process.exit(1) }
  delete tenants[slug]
  save(tenants)
  console.log(`已删除 ${slug}`)
} else if (cmd === 'show') {
  const slug = rest[0]
  const t = tenants[slug]
  if (!t) { console.error('没有这个 slug'); process.exit(1) }
  console.log(JSON.stringify({ slug, ...t, base: `${PUBLIC_BASE}/r/${slug}/pet-voice/` }, null, 2))
} else {
  console.log('用法：admin.mjs list | add <slug> [note] | del <slug> | show <slug>')
  process.exit(cmd ? 1 : 0)
}

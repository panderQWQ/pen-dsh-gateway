/**
 * pen-gateway —— 点读笔 DSH 网关（host 端插件）
 * ============================================================================
 * 问题：笔端（QuickJS/falcon）只有朴素的 request/response HTTP，拉不动 DSH 的
 * 原始事件流（一次 session.history 尾部就是几百 KB 的 assistant/chunk）。
 *
 * 方案：本插件挂载 /api/pen/* 前缀路由（webServer 最长前缀优先，赢过宿主 /api），
 * 在 PC 侧完成 重 RPC + 事件折叠，只给笔端发几 KB 的紧凑 JSON：
 *
 *   GET  /api/pen/health                  → {ok, plugin, version}
 *   GET  /api/pen/sessions                → {sessions:[{id,title,running,updatedAt}]}
 *   GET  /api/pen/tail?sessionId=&n=      → {running, messages:[{role,text,seq}]}
 *   POST /api/pen/prompt {sessionId,text} → {ok, accepted}   （queue 模式入队）
 *   POST /api/pen/cancel {sessionId}      → {ok}
 *   POST /api/pen/new {cwd?}              → {ok, sessionId} （建新会话）
 *
 * 内部全部走 loopback 复用宿主 /api RPC（信封 {type:'client-request',...}），
 * 不直接依赖 host 内部服务 API，宿主升级不易被牵连。
 *
 * 信任栅栏：与 whale_craft / dsh-serve 同款（DNS-rebinding + 跨站），
 * loopback 恒放行；本机局域网 IP 自动放行（笔就在局域网），另可配 trustedHosts。
 * ============================================================================
 */
import z from '@deepseek-ai/schemastery'
import { networkInterfaces } from 'node:os'

export const name = 'pen-gateway'
export const inject = ['webServer']

const PLUGIN_VERSION = '0.1.0'

export const Config = z.object({
  /** loopback RPC 目标端口（宿主 webserver） */
  port: z.natural().default(3080),
  /** 额外放行的 Host 权威（如 '192.168.8.7:3080'）；本机 IP 自动放行 */
  trustedHosts: z.array(z.string()).default([]),
  /** /api/pen/new 建新会话的默认 cwd */
  newSessionCwd: z.string().default(''),
  /** 单条消息回给笔端的最大字符数 */
  maxMsgChars: z.natural().default(6000),
})

/* ============================ 工具（照抄 whale_craft 同款栅栏） ============================ */

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) >= 0 && Number(p) <= 255)
    && parts[0] === '127'
}

function parseAuthority(authority) {
  try { return new URL(`http://${authority}`) } catch { return undefined }
}

function isTrustedRequest(headers, trustedHosts) {
  const host = headers.host
  if (typeof host !== 'string') return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !trustedHosts.includes(hostUrl.host) && !trustedHosts.includes(hostUrl.hostname)) return false
  if (headers['sec-fetch-site'] === 'cross-site') return false
  const origin = headers.origin
  if (origin === undefined) return true
  try { return new URL(origin).host === hostUrl.host } catch { return false }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => {
      data += chunk
      if (data.length > 1_000_000) req.destroy()
    })
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')) } catch { resolve({}) } })
    req.on('error', () => resolve({}))
  })
}

/* ============================ 折叠：事件流 → 紧凑消息 ============================ */

/** 从 pi-ai message.content 里抽纯文本块 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (b && (b.type === 'text' || b.type === undefined) && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

function clip(s, max) {
  if (typeof s !== 'string') return ''
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/**
 * 把 session.history 事件折成 [{role, text, seq}]。
 * 只保留 user/message 与 assistant/message 的文本块（跳过 reasoning/tool/chunk）。
 * events 按返回顺序（seq 升序）。
 */
function foldEvents(events, maxMsgChars) {
  const out = []
  for (const entry of events) {
    const ev = entry?.event ?? entry
    if (!ev || typeof ev.type !== 'string') continue
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
    const d = ev.data ?? {}
    const msg = d.message ?? d
    const text = textOfContent(msg.content ?? msg.text)
    if (!text) continue
    out.push({ role: ev.type === 'user/message' ? 'user' : 'assistant', text: clip(text, maxMsgChars), seq: ev.seq ?? 0 })
  }
  return out
}

export function apply(ctx, config) {
  const port = config.port ?? 3080
  const maxMsgChars = config.maxMsgChars ?? 6000

  /* 信任主机 = loopback + 本机所有 IPv4:port + 配置追加 */
  const trusted = new Set(config.trustedHosts ?? [])
  for (const [ifname, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) {
        trusted.add(`${a.address}:${port}`)
        trusted.add(a.address)
        ctx.logger?.info?.(`[pen-gateway] 信任本机网卡 ${ifname} → ${a.address}:${port}`)
      }
    }
  }
  const liveTrusted = () => [...trusted]

  /* ---- loopback RPC 复用宿主 /api ---- */
  let rpcSeq = 0
  async function rpc(method, payload) {
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: 'pen' + Date.now().toString(36) + (rpcSeq++).toString(36),
      method,
      payload: payload ?? {},
    })
    const r = await fetch(`http://127.0.0.1:${port}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    })
    const env = await r.json()
    const result = env?.result
    if (!result?.ok) {
      const err = result?.error ?? { code: 'rpc-failed', message: `HTTP ${r.status}` }
      throw new Error(`${err.code ?? 'rpc'}: ${err.message ?? 'unknown'}`)
    }
    return result.value
  }

  let listCache = { at: 0, v: null, wv: null }
  async function listSessions(force) {
    const now = Date.now()
    if (!force && listCache.v && now - listCache.at < 900) return listCache.items
    const [v, wv] = await Promise.all([
      rpc('session.list', {}),
      rpc('workspace.list', {}).catch(() => null),
    ])
    listCache = { at: now, v, wv }
    const archived = new Set(wv?.archivedSessionIds ?? [])
    listCache.items = (v?.items ?? [])
      .filter((it) => !it.origin)                     // 子代理不进列表
      .filter((it) => !archived.has(it.sessionId))    // 归档（已隐藏）的不进列表
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return listCache.items
  }

  function titleOf(it) {
    const t = it.projections?.values?.title
    if (typeof t === 'string' && t.trim()) return t.trim()
    const base = String(it.cwd ?? '').split('/').filter(Boolean).pop() || '工作区'
    const preset = it.agentPreset && it.agentPreset !== 'standard' ? ` · ${it.agentPreset}` : ''
    return base + preset
  }

  /** 完整对话快照（笔端缓存用）：尽量把整段历史折出来，最多 maxN 条 */
  async function snapshot(sessionId, maxN) {
    const want = Math.min(Math.max(maxN ?? 200, 1), 400)
    const listP = rpc('session.list', {}).catch(() => null)
    const messages = []
    const seen = new Set()
    let beforeSeq
    for (let page = 0; page < 24; page++) {
      const payload = { sessionId, maxMessages: 24 }
      if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq
      let v
      try { v = await rpc('session.history', payload) } catch { break }
      const evs = v?.events ?? []
      if (!evs.length) break
      const folded = foldEvents(evs, maxMsgChars)
      const batch = []
      for (const m of folded) {
        const key = m.seq + '|' + m.role
        if (seen.has(key)) continue
        seen.add(key)
        batch.push(m)
      }
      messages.unshift(...batch)
      beforeSeq = Math.min(...evs.map((e) => (e.event ?? e).seq ?? 0))
      if (messages.length >= want || !v?.hasMore) break
    }
    const listV = await listP
    const me = (listV?.items ?? []).find((it) => it.sessionId === sessionId)
    const cp = me?.projections?.values?.contextPressure
    let ctx = null
    if (cp && typeof cp.contextWindow === 'number' && cp.contextWindow > 0) {
      const used = typeof cp.projectedTokens === 'number' ? cp.projectedTokens : (cp.pressureTokens ?? 0)
      ctx = { pct: Math.max(0, Math.min(100, Math.round((used / cp.contextWindow) * 100))), used, total: cp.contextWindow }
    }
    const trimmed = messages.slice(-want)
    return {
      running: !!me?.running, title: me ? titleOf(me) : '', ctx,
      messages: trimmed, count: trimmed.length,
      savedAt: Date.now(),
    }
  }

  /** seq 之前的若干条（往上翻） */
  async function before(sessionId, beforeSeq, n) {
    const want = Math.min(Math.max(n ?? 5, 1), 30)
    const out = []
    let cursor = beforeSeq
    let hasMore = false
    for (let page = 0; page < 6; page++) {
      const v = await rpc('session.history', { sessionId, maxMessages: 24, beforeSeq: cursor })
      const evs = v?.events ?? []
      if (!evs.length) break
      const folded = foldEvents(evs, maxMsgChars)
      out.unshift(...folded)
      cursor = Math.min(...evs.map((e) => (e.event ?? e).seq ?? 0))
      hasMore = !!v?.hasMore
      if (out.length >= want || !hasMore) break
    }
    return { messages: out.slice(-want), hasMore }
  }

  /** 尾部折叠消息；带 running 标志 */
  async function tail(sessionId, n) {
    const want = Math.min(Math.max(n ?? 6, 1), 400)
    const listP = rpc('session.list', {}).catch(() => null)
    const messages = []
    let beforeSeq
    for (let page = 0; page < 24; page++) {
      const payload = { sessionId, maxMessages: 24 }
      if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq
      const v = await rpc('session.history', payload)
      const evs = v?.events ?? []
      if (evs.length) {
        const folded = foldEvents(evs, maxMsgChars)
        messages.unshift(...folded)
        beforeSeq = Math.min(...evs.map((e) => (e.event ?? e).seq ?? 0))
      }
      if (messages.length >= want || !v?.hasMore || !evs.length) break
    }
    const listV = await listP
    const me = (listV?.items ?? []).find((it) => it.sessionId === sessionId)
    const cp = me?.projections?.values?.contextPressure
    let ctx = null
    if (cp && typeof cp.contextWindow === 'number' && cp.contextWindow > 0) {
      const used = typeof cp.projectedTokens === 'number' ? cp.projectedTokens : (cp.pressureTokens ?? 0)
      ctx = {
        pct: Math.max(0, Math.min(100, Math.round((used / cp.contextWindow) * 100))),
        used, total: cp.contextWindow,
      }
    }
    return { running: !!me?.running, title: me ? titleOf(me) : '', messages: messages.slice(-want), ctx }
  }

  /* ---- /api/pen 路由 ----
   * GET/POST 双支持：笔端原生 http 的 POST body 能力未验证，全走 GET + query；
   * 桌面侧调试可用 POST JSON。 */
  async function handle(req, res, path, q, body) {
    body = body ?? {}
    if (path === '/health') {
      return sendJson(res, 200, { ok: true, plugin: 'pen-gateway', version: '0.1.0' })
    }
    if (path === '/sessions') {
      const items = await listSessions()
      return sendJson(res, 200, {
        ok: true,
        sessions: items.slice(0, 40).map((it) => ({
          id: it.sessionId, title: titleOf(it), running: !!it.running,
          blank: !!it.blank, updatedAt: it.updatedAt ?? 0,
        })),
      })
    }
    /* ---- 路径式（笔端 downloadFile 会丢 query，缓存只能走这里）----
     * /api/pen/s/<sessionId>      完整对话快照
     * /api/pen/h/<hex>            回显 hex 编码的文本（笔端写配置文件用）
     */
    const mSess = /^\/s\/([^/]+)$/.exec(path)
    if (mSess) {
      const sessionId = decodeURIComponent(mSess[1])
      try {
        return sendJson(res, 200, { ok: true, ...(await snapshot(sessionId, 120)) })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }
    const mHex = /^\/h\/([0-9a-fA-F]*)$/.exec(path)
    if (mHex) {
      const text = Buffer.from(mHex[1], 'hex').toString('utf8')
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      })
      res.end(text)
      return
    }
    if (path === '/snapshot') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      if (!sessionId) return sendJson(res, 200, { ok: false, error: 'sessionId required' })
      const n = parseInt(q.get('n') ?? body.n ?? '200', 10) || 200
      try {
        return sendJson(res, 200, { ok: true, ...(await snapshot(sessionId, n)) })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }
    if (path === '/cfg') {
      /* 把笔端要持久化的文本原样回显（笔端用 downloadFile 落到 /userdata/dsh） */
      const text = String(q.get('text') ?? body.text ?? '')
      res.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text),
      })
      res.end(text)
      return
    }
    if (path === '/before') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      const seq = parseInt(q.get('seq') ?? body.seq ?? '', 10)
      const n = Math.min(Math.max(parseInt(q.get('n') ?? body.n ?? '5', 10) || 5, 1), 30)
      if (!sessionId || !Number.isFinite(seq)) return sendJson(res, 200, { ok: false, error: 'sessionId/seq required' })
      try {
        const got = await before(sessionId, seq, n)
        return sendJson(res, 200, { ok: true, messages: got.messages, count: got.messages.length, hasMore: got.hasMore })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }
    if (path === '/watch') {
      /* 长轮询：等这个会话有新动静（或超时）就返回，笔端据此“秒级”刷新 */
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      const since = parseInt(q.get('since') ?? body.since ?? '0', 10) || 0
      const waitMs = Math.min(Math.max(parseInt(q.get('timeout') ?? body.timeout ?? '12', 10) * 1000 || 12000, 1000), 25000)
      if (!sessionId) return sendJson(res, 200, { ok: false, error: 'sessionId required' })
      const t0 = Date.now()
      let changed = false
      while (Date.now() - t0 < waitMs) {
        try {
          const items = await listSessions(true)
          const me = items.find((it) => it.sessionId === sessionId)
          const upd = me?.updatedAt ?? 0
          if (upd > since) { changed = true; break }
        } catch {}
        await new Promise((r) => setTimeout(r, 400))
      }
      try {
        const t = await tail(sessionId, 6)
        const items2 = await listSessions()
        const me2 = items2.find((it) => it.sessionId === sessionId)
        return sendJson(res, 200, { ok: true, changed, updatedAt: me2?.updatedAt ?? 0, ...t, waitedMs: Date.now() - t0 })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }
    if (path === '/tail') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      if (!sessionId) return sendJson(res, 200, { ok: false, error: 'sessionId required' })
      const n = parseInt(q.get('n') ?? body.n ?? '6', 10) || 6
      return sendJson(res, 200, { ok: true, ...(await tail(sessionId, n)) })
    }
    if (path === '/prompt') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      const text = String(q.get('text') ?? body.text ?? '').trim()
      const mode = (q.get('mode') ?? body.mode) === 'steer' ? 'steer' : 'queue'
      if (!sessionId || !text) return sendJson(res, 200, { ok: false, error: 'sessionId/text required' })
      const v = await rpc('session.prompt', {
        sessionId, mode,
        content: [{ type: 'text', text }],
        clientTimeZone: 'Asia/Shanghai',
      })
      return sendJson(res, 200, { ok: true, accepted: v?.accepted === true })
    }
    if (path === '/cancel') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      if (!sessionId) return sendJson(res, 200, { ok: false, error: 'sessionId required' })
      await rpc('session.cancel', { sessionId })
      return sendJson(res, 200, { ok: true })
    }
    if (path === '/models') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      if (!sessionId) return sendJson(res, 200, { ok: false, error: 'sessionId required' })
      const v = await rpc('session.models', { sessionId })
      const cur = v?.current ?? {}
      const rows = []
      for (const g of v?.groups ?? []) {
        for (const m of g.models ?? []) {
          rows.push({
            label: String(m.name ?? m.id),
            group: String(g.name ?? g.id),
            provider: g.id, model: m.id,
            current: cur.provider === g.id && cur.model === m.id,
          })
        }
      }
      return sendJson(res, 200, { ok: true, routable: !!v?.routable, current: cur, models: rows })
    }
    if (path === '/setmodel') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      const provider = String(q.get('provider') ?? body.provider ?? '')
      const model = String(q.get('model') ?? body.model ?? '')
      if (!sessionId || !provider || !model) {
        return sendJson(res, 200, { ok: false, error: 'sessionId/provider/model required' })
      }
      const v = await rpc('session.selectModel', { sessionId, provider, model })
      return sendJson(res, 200, { ok: true, selected: v?.selected ?? null })
    }
    if (path === '/new') {
      const payload = {}
      const cwd = String(q.get('cwd') ?? body.cwd ?? config.newSessionCwd ?? '').trim()
      if (cwd) payload.cwd = cwd
      const v = await rpc('session.create', payload)
      return sendJson(res, 200, { ok: true, sessionId: v?.sessionId ?? '' })
    }
    return sendJson(res, 200, { ok: false, error: `unknown endpoint ${path}` })
  }

  const route = {
    kind: 'prefix',
    path: '/api/pen',
    handler: async (req, res) => {
      if (!isTrustedRequest(req.headers, liveTrusted())) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      try {
        const url = new URL(req.url ?? '/', 'http://x')
        const sub = url.pathname.slice('/api/pen'.length) || '/'
        if (req.method === 'POST') {
          const body = await readJsonBody(req)
          await handle(req, res, sub, url.searchParams, body)
        } else {
          await handle(req, res, sub, url.searchParams, null)
        }
      } catch (e) {
        ctx.logger?.warn?.(`[pen-gateway] ${req.method} ${req.url} 失败：${e instanceof Error ? e.message : String(e)}`)
        sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    },
  }
  ctx.effect(() => ctx.webServer.register(route), 'pen-gateway: /api/pen 路由')
  ctx.logger?.info?.('[pen-gateway] /api/pen/* 已挂载（点读笔网关 v0.1.0）')
}

export default { name, inject, Config, apply }

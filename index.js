/**
 * pen-gateway —— 点读笔 DSH 网关（host 端插件）
 * ============================================================================
 * 问题：笔端（QuickJS/falcon）只有朴素的 request/response HTTP，拉不动 DSH 的
 * 原始事件流（一次尾部读就是几百 KB 的 assistant/chunk）。
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
 *   GET  /api/pen/approvals?sessionId=    → {approvals:[{id,toolName,reason,…}]}（待审批）
 *   POST /api/pen/approve {id,allow}      → {ok, outcome}  （笔端批准/拒绝）
 *   GET  /api/pen/perm?sessionId=         → {preset,presets:[…],approval,sandbox}
 *   POST /api/pen/perm {sessionId,preset} → 切换权限预设
 *
 * 传输层（v1.1.0 起）：
 *   - DSH 0.1.7+：宿主 /api 加了浏览器鉴权栅栏（非浏览器 HTTP 回环 RPC 一律 401），
 *     改走进程内 typertGateway.invoke({namespace:'session',...})，不经 HTTP、不受栅栏影响；
 *   - DSH ≤0.1.1：自动回退旧的 HTTP loopback（session.history 等老方法名 + 老信封）。
 *   首次调用探测一次（session/modelCatalog 只有新版有），之后记住通道，探测失败 60s 后重试。
 *
 * 响应形状与 v0.1.0 完全一致，笔端 app（笔上DSH v1.1.x）无需任何改动。
 *
 * 信任栅栏：与 whale_craft / dsh-serve 同款（DNS-rebinding + 跨站），
 * loopback 恒放行；本机局域网 IP 自动放行（笔就在局域网），另可配 trustedHosts。
 * ============================================================================
 */
import z from '@deepseek-ai/schemastery'
import { networkInterfaces } from 'node:os'

export const name = 'pen-gateway'
export const inject = ['webServer']

const PLUGIN_VERSION = '1.2.0'

export const Config = z.object({
  /** 旧版 HTTP 回退通道的目标端口（宿主 webserver） */
  port: z.natural().default(3080),
  /** 额外放行的 Host 权威（如 '192.168.8.7:3080'）；本机 IP 自动放行 */
  trustedHosts: z.array(z.string()).default([]),
  /** /api/pen/new 建新会话的默认 cwd */
  newSessionCwd: z.string().default(''),
  /** 单条消息回给笔端的最大字符数 */
  maxMsgChars: z.natural().default(6000),
  /** 笔端在线时把 DSH 的审批请求转给笔端弹窗（默认开） */
  approvals: z.boolean().default(true),
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

function clip(s, max) {
  if (typeof s !== 'string') return ''
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/** 从 message.content 里抽纯文本块（跳过 reasoning/tool-call；与 UI 的抽法一致） */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const b of content) {
    if (b && (b.type === 'text' || b.type === undefined) && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n').trim()
}

/**
 * 事件 → 消息本体。0.1.x 两种形状：
 *   user/message      data 就是消息本体 {id, role, source, content:[...]}
 *   assistant/message data = {turn, step, stream, message:{id, role, source, content:[...]}}
 * 老版 DSH 的 history 事件也兼容（data.message ?? data 同样成立）。
 */
function messageOfEvent(ev) {
  const d = ev?.data
  if (!d || typeof d !== 'object') return undefined
  const m = d.message ?? d
  return (m && typeof m === 'object' && Array.isArray(m.content)) ? m : undefined
}

/**
 * 把一页事件折成 [{role, text, seq}]。
 * 只保留 user/message 与 assistant/message 的文本块（跳过 reasoning/tool/chunk）。
 * events 按 seq 升序。
 */
function foldEvents(events, maxMsgChars) {
  const out = []
  for (const entry of events) {
    const ev = entry?.event ?? entry
    if (!ev || typeof ev.type !== 'string') continue
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
    const msg = messageOfEvent(ev)
    if (!msg) continue
    const text = textOfContent(msg.content)
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

  /* ============================ RPC 层 ============================
   * 新宿主（0.1.7+）：进程内 typertGateway.invoke，args 按 wire 字段精确匹配：
   *   大多数方法  { request: {...} }
   *   session/list { _request: {...} }
   *   session/modelCatalog {}
   * 老宿主（≤0.1.1）：HTTP loopback，老方法名 + 老信封。
   * 通道探测：modelCatalog 只有新版有；探测结果缓存，false 60s 后重试。 */

  function safeGet(key) {
    try { return ctx.get(key) } catch { return undefined }
  }

  function errText(e) {
    if (e && typeof e === 'object') {
      const code = typeof e.code === 'string' ? e.code : ''
      const msg = typeof e.message === 'string' ? e.message : String(e)
      return code ? `${code}: ${msg}` : msg
    }
    return String(e)
  }

  let rpcSeq = 0
  let probeState = { v: null, at: 0 }

  async function gw(method, args) {
    const service = safeGet('typertGateway')
    if (!service || typeof service.invoke !== 'function') {
      throw new Error('gateway/unavailable: typertGateway 服务不存在')
    }
    return await service.invoke({ namespace: 'session', method, args })
  }

  async function callNew(method, args) {
    try {
      return await gw(method, args)
    } catch (e) {
      throw new Error(errText(e))
    }
  }

  async function httpOld(method, payload) {
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
    const raw = await r.text()
    let env
    try { env = JSON.parse(raw) } catch {
      throw new Error(`dsh ${r.status}: ${raw.slice(0, 80) || '空响应'}（HTTP RPC 被宿主拒绝）`)
    }
    const result = env?.result
    if (!result?.ok) {
      const err = result?.error ?? { code: 'rpc-failed', message: `HTTP ${r.status}` }
      throw new Error(`${err.code ?? 'rpc'}: ${err.message ?? 'unknown'}`)
    }
    return result.value
  }

  async function rpcMode() {
    if (probeState.v === true) return true
    if (probeState.v === false && Date.now() - probeState.at < 60_000) return false
    const service = safeGet('typertGateway')
    let ok = false
    if (service && typeof service.invoke === 'function') {
      try {
        await service.invoke({ namespace: 'session', method: 'modelCatalog', args: {} })
        ok = true
      } catch { ok = false }
    }
    probeState = { v: ok, at: Date.now() }
    ctx.logger?.info?.(`[pen-gateway] RPC 通道：${ok ? '进程内 typertGateway（DSH 0.1.7+）' : 'HTTP loopback（旧版 DSH）'}`)
    return ok
  }

  /* ============================ 会话列表 ============================ */

  let listCache = { at: 0, items: null }
  async function listSessions(force) {
    const now = Date.now()
    if (!force && listCache.items && now - listCache.at < 900) return listCache.items
    let items
    if (await rpcMode()) {
      const v = await callNew('list', { _request: {} })
      /* 0.1.7 起没有 workspace.list 了，拿不到归档名单：只过滤子代理，
         归档会话偶尔会出现在列表里（不影响使用） */
      items = (v?.items ?? []).filter((it) => !it.origin)
    } else {
      const [v, wv] = await Promise.all([
        httpOld('session.list', {}),
        httpOld('workspace.list', {}).catch(() => null),
      ])
      const archived = new Set(wv?.archivedSessionIds ?? [])
      items = (v?.items ?? [])
        .filter((it) => !it.origin)
        .filter((it) => !archived.has(it.sessionId))
    }
    items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    listCache = { at: now, items }
    return items
  }

  function titleOf(it) {
    const t = it.projections?.values?.title
    if (typeof t === 'string' && t.trim()) return t.trim()
    const base = String(it.cwd ?? '').split('/').filter(Boolean).pop() || '工作区'
    const preset = it.agentPreset && it.agentPreset !== 'standard' ? ` · ${it.agentPreset}` : ''
    return base + preset
  }

  /* ============================ 分页读 ============================
   * 新版 session.page 不认 throughSeq:-1（那是空页），尾部 seq 要先从
   * session.projections 的 asOfSeq 拿（= 日志最后一条事件的 seq）。
   * 老版 session.history 自带头部读，不需要游标。 */

  async function cursorOf(sessionId) {
    if (!(await rpcMode())) return null
    const v = await callNew('projections', { request: { sessionId } })
    if (!v || typeof v.asOfSeq !== 'number') throw new Error('session/not-found: projections 为空')
    return v.asOfSeq
  }

  /** 读一页：返回 {events:[{type,seq,time,data}], hasMore}（事件已解包、统一形状） */
  async function pageOnce(sessionId, cursor, beforeSeq, maxMessages) {
    if (await rpcMode()) {
      const req = { address: { kind: 'session', sessionId }, throughSeq: cursor, maxMessages }
      if (beforeSeq !== undefined) req.beforeSeq = beforeSeq
      const v = await callNew('page', { request: req })
      return {
        events: (v?.records ?? []).map((r) => r?.event).filter(Boolean),
        hasMore: !!v?.hasMore,
      }
    }
    const payload = { sessionId, maxMessages }
    if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq
    const v = await httpOld('session.history', payload)
    return {
      events: (v?.events ?? []).map((e) => e?.event ?? e).filter(Boolean),
      hasMore: !!v?.hasMore,
    }
  }

  /** 从尾部往下翻，折出最多 want 条；wantMeta 时顺带取 running/title/上下文水位 */
  async function foldHistory(sessionId, want, { maxPages = 24, wantMeta = false } = {}) {
    const cap = Math.min(Math.max(want, 1), 400)
    const cursor = await cursorOf(sessionId)
    const listP = wantMeta ? listSessions().catch(() => null) : Promise.resolve(null)
    const messages = []
    const seen = new Set()
    let beforeSeq
    let hasMore = false
    for (let page = 0; page < maxPages; page++) {
      const got = await pageOnce(sessionId, cursor, beforeSeq, 24)
      hasMore = got.hasMore
      if (!got.events.length) break
      const batch = []
      for (const m of foldEvents(got.events, maxMsgChars)) {
        const key = m.seq + '|' + m.role
        if (seen.has(key)) continue
        seen.add(key)
        batch.push(m)
      }
      messages.unshift(...batch)
      beforeSeq = Math.min(...got.events.map((e) => e.seq ?? 0))
      if (messages.length >= cap || !hasMore) break
    }
    const me = (await listP ?? []).find((it) => it.sessionId === sessionId)
    const cp = me?.projections?.values?.contextPressure
    let ctxInfo = null
    if (cp && typeof cp.contextWindow === 'number' && cp.contextWindow > 0) {
      const used = typeof cp.pressureTokens === 'number' ? cp.pressureTokens : 0
      ctxInfo = {
        pct: Math.max(0, Math.min(100, Math.round((used / cp.contextWindow) * 100))),
        used, total: cp.contextWindow,
      }
    }
    const trimmed = messages.slice(-cap)
    return { running: !!me?.running, title: me ? titleOf(me) : '', ctx: ctxInfo, messages: trimmed, count: trimmed.length, hasMore }
  }

  /** seq 之前的若干条（往上翻） */
  async function foldBefore(sessionId, beforeSeq, want) {
    const cap = Math.min(Math.max(want, 1), 30)
    const cursor = await cursorOf(sessionId)
    const out = []
    let top = beforeSeq
    let hasMore = false
    for (let page = 0; page < 6; page++) {
      const got = await pageOnce(sessionId, cursor, top, 24)
      hasMore = got.hasMore
      if (!got.events.length) break
      out.unshift(...foldEvents(got.events, maxMsgChars))
      top = Math.min(...got.events.map((e) => e.seq ?? 0))
      if (out.length >= cap || !hasMore) break
    }
    return { messages: out.slice(-cap), hasMore }
  }

  /* ============================ 写操作 ============================ */

  let promptSeq = 0
  async function doPrompt(sessionId, text, mode) {
    if (await rpcMode()) {
      const v = await callNew('prompt', {
        request: {
          requestId: `pen-${Date.now().toString(36)}-${(promptSeq++).toString(36)}`,
          sessionId,
          mode,
          content: [{ type: 'text', text }],
          clientTimeZone: 'Asia/Shanghai',
        },
      })
      return v?.accepted === true
    }
    const v = await httpOld('session.prompt', { sessionId, mode, content: [{ type: 'text', text }], clientTimeZone: 'Asia/Shanghai' })
    return v?.accepted === true
  }

  async function doCancel(sessionId) {
    if (await rpcMode()) {
      await callNew('cancel', { request: { sessionId } })
      return
    }
    await httpOld('session.cancel', { sessionId })
  }

  async function doSelectModel(sessionId, provider, model) {
    if (await rpcMode()) {
      const v = await callNew('selectModel', { request: { sessionId, provider, model } })
      return v?.selected ?? null
    }
    const v = await httpOld('session.selectModel', { sessionId, provider, model })
    return v?.selected ?? null
  }

  async function doCreate(cwd) {
    const payload = {}
    if (cwd) payload.cwd = cwd
    if (await rpcMode()) {
      const v = await callNew('create', { request: payload })
      return v?.sessionId ?? ''
    }
    const v = await httpOld('session.create', payload)
    return v?.sessionId ?? ''
  }

  async function modelsOf(sessionId) {
    if (await rpcMode()) {
      const v = await callNew('modelCatalog', {})
      /* 新版目录是全局的：会话当前模型从 projections.values.modelSelection 补 */
      const items = await listSessions().catch(() => null)
      const me = (items ?? []).find((it) => it.sessionId === sessionId)
      const sel = me?.projections?.values?.modelSelection
      const cur = sel?.next ?? sel?.lastUsed ?? v?.default ?? {}
      const rows = []
      for (const g of v?.groups ?? []) {
        for (const m of g.models ?? []) {
          rows.push({
            label: String(m.name ?? m.id),
            group: String(g.name ?? g.id),
            provider: g.id, model: m.id,
            current: cur?.provider === g.id && cur?.model === m.id,
          })
        }
      }
      return { routable: (v?.routableProviders ?? []).length > 0, current: cur, models: rows }
    }
    const v = await httpOld('session.models', { sessionId })
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
    return { routable: !!v?.routable, current: cur, models: rows }
  }

  /* ============================ 审批桥（运行时外部权限） ============================
   * DSH 的 approval/request 是瀑布事件：宿主 ctx.waterfall(...)，监听者返回
   * 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' 之一，只有 allowed-once 放行。
   * 浏览器桥（api-remotes）把请求塞进队列等浏览器拉取——浏览器没开就永远挂着。
   * 这里 prepend 抢在最前：笔端在线时把请求挂起给笔端弹窗，同时 1.5s 后照旧转给
   * 浏览器桥（两边谁先答都算数）；笔端没在用时完全不插手。 */

  let approvalSeq = 0
  const parked = new Map()          // id → { info, resolve }
  let lastPenSeen = 0               // 笔端最近一次访问 /api/pen/* 的时间
  const PEN_ACTIVE_MS = 20_000      // 静默这么久就认为笔端没在用
  const APPROVALS_ENABLED = config.approvals !== false

  function parkApproval(request) {
    const id = 'pa' + (++approvalSeq)
    const agent = request?.agent
    const info = {
      id,
      toolName: String(request?.toolName ?? ''),
      callId: request?.callId ? String(request.callId) : '',
      reason: String(request?.reason ?? request?.displayReason ?? ''),
      sessionId: String(agent?.session?.id ?? agent?.sessionId ?? ''),
      at: Date.now(),
    }
    let resolve
    const promise = new Promise((r) => { resolve = r })
    parked.set(id, { info, resolve })
    const signal = request?.signal
    if (signal && typeof signal.addEventListener === 'function') {
      const onAbort = () => { resolveTicket(id, 'cancelled') }
      signal.addEventListener('abort', onAbort, { once: true })
      promise.then(() => { try { signal.removeEventListener('abort', onAbort) } catch {} })
    }
    return { info, promise }
  }

  function resolveTicket(id, outcome) {
    const t = parked.get(id)
    if (!t) return false
    parked.delete(id)
    t.resolve(outcome)
    return true
  }

  function pendingApprovals(sessionId) {
    const out = []
    for (const { info } of parked.values()) {
      if (sessionId && info.sessionId && info.sessionId !== sessionId) continue
      out.push({ ...info, ageMs: Date.now() - info.at })
    }
    return out
  }

  ctx.on('approval/request', function (request, next) {
    try {
      if (!APPROVALS_ENABLED) return next()
      if (!request || typeof request.toolName !== 'string') return next()
      /* 笔端最近没动静 → 维持原样，只让浏览器 UI 处理 */
      if (Date.now() - lastPenSeen > PEN_ACTIVE_MS) return next()
      const ticket = parkApproval(request)
      ctx.logger?.info?.(`[pen-gateway] 审批请求 ${ticket.info.toolName}（${ticket.info.id}）转给笔端`)
      return new Promise((resolve) => {
        let done = false
        const finish = (o) => {
          if (done) return
          done = true
          parked.delete(ticket.info.id)
          resolve(o)
        }
        ticket.promise.then((o) => { if (o) finish(o) })
        setTimeout(() => {
          if (done) return
          Promise.resolve().then(next).then(finish, () => finish('unavailable'))
        }, 1500)
      })
    } catch (e) {
      ctx.logger?.warn?.(`[pen-gateway] 审批拦截失败：${e instanceof Error ? e.message : String(e)}`)
      return next()
    }
  }, { prepend: true, global: true })

  /* ============================ 权限管理（预设 + 策略） ============================ */

  function liveSessionOf(sessionId) {
    const sessions = safeGet('sessions')
    const viaSessions = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    if (viaSessions) return viaSessions
    const agents = safeGet('agents')
    const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
    return agent?.session
  }

  function permOf(sessionId) {
    const presets = safeGet('permissionPresets')
    let catalog = { options: [] }
    try { catalog = presets?.catalog?.() ?? catalog } catch {}
    const options = Array.isArray(catalog?.options) ? catalog.options : []
    const session = liveSessionOf(sessionId)
    let state = null
    let preset = null
    try {
      if (session && presets) {
        state = presets.permissionState(session)
        preset = presets.current(session)
      }
    } catch {}
    return {
      live: !!session,
      preset,
      presetName: (options.find((o) => o.value === preset)?.name) ?? (preset === 'custom' ? '自定义' : null),
      sandbox: state?.sandbox ?? null,
      approval: state?.approval ?? null,
      presets: options.map((o) => ({
        value: String(o.value),
        name: String(o.name ?? o.value),
        description: o.description ? String(o.description) : '',
      })),
    }
  }

  function setPreset(sessionId, name) {
    const presets = safeGet('permissionPresets')
    const session = liveSessionOf(sessionId)
    if (!presets || typeof presets.set !== 'function') throw new Error('permission/unavailable: 宿主没有 permissionPresets 服务')
    if (!session) throw new Error('permission/session-idle: 会话未激活，先在笔端发一条消息再改权限')
    presets.set(session, name)
    return permOf(sessionId)
  }

  /* ============================ /api/pen 路由 ============================
   * GET/POST 双支持：笔端原生 http 的 POST body 能力未验证，全走 GET + query；
   * 桌面侧调试可用 POST JSON。 */
  async function handle(req, res, path, q, body) {
    body = body ?? {}
    lastPenSeen = Date.now()
    if (path === '/health') {
      return sendJson(res, 200, { ok: true, plugin: 'pen-gateway', version: PLUGIN_VERSION })
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
        const h = await foldHistory(sessionId, 120, { wantMeta: true })
        return sendJson(res, 200, { ok: true, ...h, savedAt: Date.now() })
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
        const h = await foldHistory(sessionId, n, { wantMeta: true })
        return sendJson(res, 200, { ok: true, ...h, savedAt: Date.now() })
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
        const got = await foldBefore(sessionId, seq, n)
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
        if (pendingApprovals(sessionId).length) { changed = true; break }
        try {
          const items = await listSessions(true)
          const me = items.find((it) => it.sessionId === sessionId)
          const upd = me?.updatedAt ?? 0
          if (upd > since) { changed = true; break }
        } catch {}
        await new Promise((r) => setTimeout(r, 400))
      }
      try {
        const t = await foldHistory(sessionId, 6, { wantMeta: true })
        const items2 = await listSessions()
        const me2 = items2.find((it) => it.sessionId === sessionId)
        return sendJson(res, 200, { ok: true, changed, updatedAt: me2?.updatedAt ?? 0, ...t, approvals: pendingApprovals(sessionId), waitedMs: Date.now() - t0 })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e?.message ?? e) })
      }
    }
    if (path === '/tail') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      if (!sessionId) return sendJson(res, 200, { ok: false, error: 'sessionId required' })
      const n = parseInt(q.get('n') ?? body.n ?? '6', 10) || 6
      return sendJson(res, 200, { ok: true, ...(await foldHistory(sessionId, n, { wantMeta: true })), approvals: pendingApprovals(sessionId) })
    }
    if (path === '/approvals') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      return sendJson(res, 200, { ok: true, approvals: pendingApprovals(sessionId) })
    }
    if (path === '/approve') {
      const id = String(q.get('id') ?? body.id ?? '')
      const allow = String(q.get('allow') ?? body.allow ?? '1') !== '0'
      if (!id) return sendJson(res, 200, { ok: false, error: 'id required' })
      const outcome = allow ? 'allowed-once' : 'rejected'
      const done = resolveTicket(id, outcome)
      ctx.logger?.info?.(`[pen-gateway] 笔端审批 ${id} → ${outcome}${done ? '' : '（已失效）'}`)
      return sendJson(res, 200, { ok: true, decided: done, outcome })
    }
    if (path === '/perm') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      const want = String(q.get('preset') ?? body.preset ?? '')
      if (!sessionId) return sendJson(res, 200, { ok: false, error: 'sessionId required' })
      if (want) {
        try {
          return sendJson(res, 200, { ok: true, ...setPreset(sessionId, want) })
        } catch (e) {
          return sendJson(res, 200, { ok: false, error: String(e?.message ?? e), ...permOf(sessionId) })
        }
      }
      return sendJson(res, 200, { ok: true, ...permOf(sessionId) })
    }
    if (path === '/prompt') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      const text = String(q.get('text') ?? body.text ?? '').trim()
      const mode = (q.get('mode') ?? body.mode) === 'steer' ? 'steer' : 'queue'
      if (!sessionId || !text) return sendJson(res, 200, { ok: false, error: 'sessionId/text required' })
      const accepted = await doPrompt(sessionId, text, mode)
      return sendJson(res, 200, { ok: true, accepted })
    }
    if (path === '/cancel') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      if (!sessionId) return sendJson(res, 200, { ok: false, error: 'sessionId required' })
      await doCancel(sessionId)
      return sendJson(res, 200, { ok: true })
    }
    if (path === '/models') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      if (!sessionId) return sendJson(res, 200, { ok: false, error: 'sessionId required' })
      return sendJson(res, 200, { ok: true, ...(await modelsOf(sessionId)) })
    }
    if (path === '/setmodel') {
      const sessionId = String(q.get('sessionId') ?? body.sessionId ?? '')
      const provider = String(q.get('provider') ?? body.provider ?? '')
      const model = String(q.get('model') ?? body.model ?? '')
      if (!sessionId || !provider || !model) {
        return sendJson(res, 200, { ok: false, error: 'sessionId/provider/model required' })
      }
      const selected = await doSelectModel(sessionId, provider, model)
      return sendJson(res, 200, { ok: true, selected })
    }
    if (path === '/new') {
      const cwd = String(q.get('cwd') ?? body.cwd ?? config.newSessionCwd ?? '').trim()
      const sessionId = await doCreate(cwd)
      return sendJson(res, 200, { ok: true, sessionId })
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
  ctx.logger?.info?.(`[pen-gateway] /api/pen/* 已挂载（点读笔网关 v${PLUGIN_VERSION}）`)
}

export default { name, inject, Config, apply }

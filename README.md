# pen-dsh-gateway

把 **有道词典笔** 接到 **DeepSeek Harness (DSH)** 上的桥接插件。

DSH 的 web API（`/api/*`）是给浏览器用的：一次 `session.history` 返回的事件流动辄几百 KB，
小屏设备（词典笔、手表、ESP32 之类）既解析不动也显示不下。本插件在宿主里注册一组
`/api/pen/*` 轻量接口，**在服务端把事件流折叠成一条条「角色 + 纯文本」消息**，
笔端拿到的是可以直接往屏幕上画的数据。

> 配套的笔端小程序（`笔上DSH`）目前尚未开源。

---

## 特性

- **折叠会话**：`session.history` 的 `assistant/chunk`、`reasoning`、`tool` 事件全部丢掉，
  只保留 `user/message` 与 `assistant/message` 的文本块
- **长度截断**：单条消息默认截到 6000 字符（可配），避免糊满小屏
- **标题/上下文百分比**：标题取 `projections.values.title`；
  上下文占用取 `projections.values.contextPressure`，换算成 `pct`
- **归档过滤**：`workspace.list` 里 `archivedSessionIds` 中的会话不出现在列表里
- **长轮询**：`/watch` 挂起最多 25 秒，会话一有动静立刻返回（近似「服务器主动推送」）
- **纯路径式缓存接口**：`/s/<id>`、`/h/<hex>`。
  有些嵌入式运行时（如有道词典笔的 falcon）**用 `downloadFile` 下载时会丢掉 URL 的 query**，
  所以缓存类接口必须无 query，插件为此专门提供了路径式版本
- **信任边界**：只接受 loopback 或本机网卡地址（自动信任 `本机IPv4:port`），可用 `trustedHosts` 追加

## 安装

```bash
git clone https://github.com/panderQWQ/pen-dsh-gateway.git
dsh plugin --profile web add link:$PWD/pen-dsh-gateway
# 重启一次 dsh web（插件是加载时注册路由，重启后生效）
```

自测：

```bash
curl -s http://127.0.0.1:3080/api/pen/health
curl -s http://127.0.0.1:3080/api/pen/sessions | head -c 300
```

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/pen/health` | 探活 |
| GET/POST | `/api/pen/sessions` | 会话列表 `{id,title,running,blank,updatedAt}`（最多 40 条） |
| GET/POST | `/api/pen/tail?sessionId=&n=` | 尾部 n 条消息 + `running` + `ctx` |
| GET/POST | `/api/pen/snapshot?sessionId=&n=` | 完整快照（最多 400 条，返回 `savedAt`） |
| **GET** | `/api/pen/s/<sessionId>` | 路径式快照（缓存用，默认 120 条，无 query） |
| **GET** | `/api/pen/h/<hex>` | 回显 hex 编码的文本（笔端写配置文件用，无 query） |
| GET/POST | `/api/pen/before?sessionId=&seq=&n=` | `seq` 之前的 n 条（往上翻页） |
| GET/POST | `/api/pen/watch?sessionId=&since=&timeout=` | 长轮询，`since(updatedAt)` 之后有变化就返回 |
| GET/POST | `/api/pen/prompt?sessionId=&text=&mode=queue\|steer` | 发消息 |
| GET/POST | `/api/pen/new?cwd=` | 新建会话 |
| GET/POST | `/api/pen/models?sessionId=` | 模型列表（含 `current`） |
| GET/POST | `/api/pen/setmodel?sessionId=&provider=&model=` | 切换模型 |
| GET/POST | `/api/pen/cancel?sessionId=` | 停止当前轮 |
| GET/POST | `/api/pen/cfg?text=` | 回显文本（query 版，桌面调试用） |

返回体一律 `{ok:true, ...}` / `{ok:false, error:"..."}`，HTTP 状态码保持 200，方便嵌入式端解析。

`session.history` 的原始事件 → 折叠后：

```json
{ "role": "user",      "text": "把渲染换成画布", "seq": 41 }
{ "role": "assistant", "text": "改好了，v0.5.0", "seq": 42 }
```

## 配置

在 profile 的插件配置里（`Config` schema，`@deepseek-ai/schemastery`）：

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | `3080` | DSH web 端口（loopback RPC 也用它） |
| `trustedHosts` | `[]` | 额外放行的 Host，形如 `192.168.8.7:3080` |
| `newSessionCwd` | `''` | `/new` 新建会话的工作目录 |
| `maxMsgChars` | `6000` | 单条消息最大字符数 |

## 工作原理

```
笔端小程序 ──HTTP(JSON)──▶ pen-gateway(本插件) ──loopback POST /api/<method>──▶ DSH web 内核
                              │
                              └─ session.list / session.history / session.prompt …
                                 折叠事件流、算标题与上下文百分比
```

宿主 RPC 走 loopback：`POST http://127.0.0.1:<port>/api/<method>`，
信封 `{type:'client-request', rpcId, method, payload}`，回包
`{type:'server-response', rpcId, result:{ok:true,value}|{ok:false,error}}`。

## License

MIT

# AI Terminal Bridge API 接口文档

把宿主机终端通过 HTTP / WebSocket / MCP 暴露给外部 AI 代理使用。

## 1. 服务地址

| 环境 | 地址 |
|---|---|
| 预览（公网） | `https://8790-35521e1ac3aed563.monkeycode-ai.live` |
| 本机 | `http://localhost:8790` |

下文示例统一用预览地址，`$BASE` 即：

```bash
BASE="https://8790-35521e1ac3aed563.monkeycode-ai.live"
```

## 2. 认证

两种凭据，任选其一：

### 2.1 API 令牌（推荐给程序/AI 代理）

初始 bootstrap 令牌：`qq928820655`（由 `AITB_TOKEN` 配置，永久有效，admin 权限）。

也可在 Web 界面「令牌管理」创建托管令牌（`aitb_` 开头，可限定 scope 和有效期）。

令牌传入方式（按优先级）：

```
Authorization: Bearer <token>        # 标准
X-AITB-Token: <token>                # 头字段
GET /api/sessions?token=<token>      # 查询参数（WebSocket 用这种方式）
Cookie: aitb_token=<token>           # Cookie
```

```bash
curl -s "$BASE/api/sessions" -H "Authorization: Bearer qq928820655"
```

### 2.2 账号会话（给 Web 界面 / 人）

默认账号 `admin`，初始密码等于 bootstrap 令牌值，首次登录强制改密。

```bash
# 登录，拿会话令牌（有效期 7 天）
curl -s -X POST "$BASE/api/auth/login" \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"<你的密码>"}'
# 返回 {"sessionToken":"sess_...","mustChangePassword":false}
```

会话令牌用法与 API 令牌相同（放 `Authorization: Bearer sess_...`）。

### 2.3 权限 scope

| scope | 能力 |
|---|---|
| `exec` | 执行命令（/api/exec、/api/sessions/:id/exec） |
| `session` | 终端会话管理（列表、创建、WS 交互） |
| `admin` | 令牌管理（创建/轮换/删除/查看完整值），含前两者能力 |

账号登录的会话具有 admin；托管令牌按创建时指定的 scope 生效。

## 3. 认证接口

### POST /api/auth/login

登录。密码字段可填账号密码，也可填任一托管 API 令牌（bootstrap 值不能当密码登录）。10 分钟内失败 8 次锁定 1 分钟。

```bash
curl -s -X POST "$BASE/api/auth/login" \
  -H "content-type: application/json" \
  -d '{"username":"admin","password":"xxx"}'
```

响应：`{ "sessionToken": "sess_...", "mustChangePassword": true, "account": {...} }`

### GET /api/auth/me

当前身份。需要认证。

```bash
curl -s "$BASE/api/auth/me" -H "Authorization: Bearer $TOKEN"
# {"kind":"session","username":"admin","scopes":["exec","session","admin"],...}
```

### POST /api/auth/password

修改密码。`newPassword` 允许与当前密码相同。需要认证。

```bash
curl -s -X POST "$BASE/api/auth/password" \
  -H "Authorization: Bearer $SESS" -H "content-type: application/json" \
  -d '{"username":"admin","currentPassword":"old","newPassword":"new"}'
```

### POST /api/auth/logout

注销当前会话。需要认证。

## 4. 令牌管理（需 admin）

### GET /api/tokens

列出托管令牌（只含掩码）。

### POST /api/tokens

创建令牌。字段全可选：`name`、`scopes`（默认 `["exec","session"]`）、`token`（自定义值 8-128 字符，留空随机）、有效期 `ttlMs` / `expiresAt`（最大 30 天，缺省永久）。

```bash
# 创建 2 小时有效的临时令牌
curl -s -X POST "$BASE/api/tokens" \
  -H "Authorization: Bearer qq928820655" -H "content-type: application/json" \
  -d '{"name":"agent-2h","scopes":["exec"],"ttlMs":7200000}'
# 响应里的 token.token 是完整值，仅此一次返回
```

### GET /api/tokens/:id/reveal

取回某个托管令牌的完整值（此后随时可查，不再只显示一次）。

```bash
curl -s "$BASE/api/tokens/tok_xxxx/reveal" -H "Authorization: Bearer qq928820655"
```

### POST /api/tokens/:id/rotate

轮换（生成新值，旧值立即失效）。响应含新完整值。

### POST /api/tokens/:id/rename

改名。body：`{"name":"新名字"}`

### POST /api/tokens/:id/value

自定义令牌值。body：`{"token":"aitb_myvalue"}`

### POST /api/tokens/:id/disable · /enable

停用 / 启用。

### DELETE /api/tokens/:id

删除令牌。

## 5. 终端会话（需 session scope）

### GET /api/sessions

列出所有会话。

### POST /api/sessions

创建交互式 shell 会话。body 可选：`name`、`cwd`、`shell`、`cols`、`rows`。

**按名创建（幂等，推荐给 AI 持续使用）**：`name` 已存在且活跃时直接返回该会话（`reused:true`，HTTP 200），不存在才新建（`reused:false`，HTTP 201）。同名死会话自动清理。

```bash
# 重复调用安全，永远拿到同一个 "ai-work" 会话
curl -s -X POST "$BASE/api/sessions" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"name":"ai-work","cwd":"/workspace"}'
# 第一次: {"session":{"id":"s1a2b3c4d5e6",...},"reused":false}   (201)
# 之后:   {"session":{"id":"s1a2b3c4d5e6",...},"reused":true}    (200)
```

WebSocket 同样支持按名接入：`/ws?token=<token>&name=ai-work`，会话存在则附加，不存在自动创建。

### 会话自动生命周期

| 条件 | 行为 |
|---|---|
| 超过 **60 分钟** 无人连接（无 WS 观察者且无 HTTP 操作者） | 自动关闭进程（会话保留在列表，可查看历史输出） |
| 关闭后超过 **3 天** 无人使用 | 自动从列表清除（审计存档不受影响） |
| 有人连接/操作期间 | 不会触发上述清理 |

可用 `AITB_CONN_IDLE_KILL_MINUTES`、`AITB_CONN_PURGE_DAYS` 调整；清理动作记录在访问记录（`空闲关闭` / `自动清除`）。

### GET /api/sessions/:id

会话快照（含滚动缓冲区）。参数：`offset`（从该字符数之后取）、`strip=0`（保留 ANSI 转义，默认剥离）。

### POST /api/sessions/:id/input

向会话写入输入（模拟键盘）。body：`{"data":"ls -la\r"}`

### POST /api/sessions/:id/exec

在指定会话里执行一条命令并等待输出。body：`command`、可选 `timeoutMs`（默认 30s，最大 120s）、可选 `requestId`（幂等键，同会话同 requestId 重放缓存结果并回显）。

实现：命令尾部自动追加退出码哨兵，服务端读到哨兵才返回——**真实 `exitCode`、输出不含命令回显、CRLF 已归一化为 LF**。超时未读到哨兵时 `truncated:true`、`timedOut:true`、`truncatedReason:"timeout"` 且 `exitCode:null`（命令还在跑，未跑完）。

```bash
curl -s -X POST "$BASE/api/sessions/$SID/exec" \
  -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"command":"git status --short"}'
# {"sessionId":"s_x","requestId":null,"offset":123,"output":" M file\n","alive":true,"exitCode":0,"truncated":false}
```

### POST /api/sessions/purge?ephemeral=1

批量清理会话。默认只清 ephemeral（`/api/exec` 一次性会话）；`?ephemeral=0` 清理全部。

```bash
curl -s -X POST "$BASE/api/sessions/purge?ephemeral=1" -H "Authorization: Bearer $TOKEN"
# {"ok":true,"removed":["s_x","s_y"]}
```

### POST /api/sessions/:id/resize

调整终端尺寸。body：`{"cols":120,"rows":32}`

### POST /api/sessions/:id/kill

结束会话进程（会话保留在列表，进程退出）。

### DELETE /api/sessions/:id

删除会话。

### POST /api/exec

一次性执行：自动建会话跑命令、收输出、自动销毁。需要 `exec` scope。

**请求体：**

| 字段 | 类型 | 说明 |
|---|---|---|
| `command` | string | 必填。由 `bash -c` 执行 |
| `timeoutMs` | number | 超时上限，默认 15000，同步模式最大 120000；detach 模式最大 `AITB_EXEC_MAX_MS`（默认 10 分钟） |
| `requestId` | string | 可选，≤128 字符。**幂等键**：同 requestId 的重放返回缓存结果（`cached:true`），不会重复执行；并发重复请求合并为一次执行 |
| `detach` | boolean | true 时立即返回 `execId`，用 status/output 接口拉取，见下文 |
| `cwd` / `shell` / `cols` / `rows` / `keep` | - | 同会话参数；`keep:true` 保留会话不销毁 |

**响应（同步模式）：**

```json
{
  "execId": "s8c9d523f1b52",
  "requestId": "dq-001",
  "commandLabel": "echo MARK_$RANDOM >>",
  "status": "exited",
  "exitCode": 0,
  "output": "...",
  "truncated": false,
  "timedOut": false,
  "killed": false,
  "bytesReturned": 1,
  "bytesTotal": 3,
  "durationMs": 41,
  "cached": true
}
```

- `exitCode`：真实退出码；**超时被杀时是 `124`**（不再返回 null），配合 `timedOut:true`
- `truncatedReason`：截断原因，`timeout`（超时强杀）或 `killed`（手动 DELETE）
- `output` 已清洗 ANSI/CR，无回显污染；**字节精确，末尾换行保留**（`printf 'A\nB\nC\n'` 返回 `"A\nB\nC\n"`），可直接做逐字节比对
- `cleanupMs`：超时被杀时，deadline 之后花在收尾上的毫秒数（端到端 ≈ timeoutMs + cleanupMs + 网络）
- 客户端断连**不会**杀掉正在执行的命令（跑完为止）；`timeoutMs` 到点才杀
- 超时先对命令发 SIGTERM（给脚本 trap 清理的机会），随后强杀

**detach 模式（长任务推荐）：**

```bash
# 1. 发起，立即返回
curl -s -X POST "$BASE/api/exec" -H "Authorization: Bearer $T" \
  -H "content-type: application/json" \
  -d '{"command":"./deploy.sh","detach":true,"timeoutMs":600000}'
# {"execId":"sf656018120b8","detached":true,"status":"running",
#  "pollStatus":"/api/exec/sf656018120b8/status","pollOutput":"/api/exec/.../output?offset=0"}

# 2. 轮询状态
curl -s "$BASE/api/exec/$ID/status" -H "Authorization: Bearer $T"
# {"execId":"...","status":"running"|"exited"|"timeout"|"killed"|"failed",
#  "exitCode":null,"timedOut":false,"durationMs":2131,"bytesTotal":10,...}

# 3. 增量拉输出（offset 传上次响应里的 offset；服务端已清洗 CR/ANSI）
curl -s "$BASE/api/exec/$ID/output?offset=0" -H "Authorization: Bearer $T"
# {"status":"exited","exitCode":0,"data":"P_A\nP_B\n","offset":10,
#  "bytesTotal":10,"bytesReturned":10,"truncated":false,"bufferStart":0}

# 4. 中途终止（可选）
curl -s -X DELETE "$BASE/api/exec/$ID" -H "Authorization: Bearer $T"
```

已结束的 detach 任务保留 10 分钟（`AITB_EXEC_TTL_MS`）供查询，之后自动清理。任务从会话列表摘除，不占用 UI 会话位。

### PUT /api/files?path=<绝对路径>

上传文件（需要 `exec` scope）。body 为原始字节，上限 10MB（`AITB_UPLOAD_MAX_BYTES`）。小文件（≤ 数百 KB）一次性写入为「临时文件 + rename」原子落盘，**上传中断不会留下半截文件**。

**响应：**

```json
{"ok":true,"path":"/tmp/pkg.tar.gz","bytes":4096,"offset":4096,"receivedBytes":4096,"sha256":"..."}
```

`receivedBytes` 为该路径当前累计字节数，作为下一次续传的 `offset`。

**断点续传（大文件推荐按 1MB 分块）：**

```bash
# 第一块
curl -s -X PUT "$BASE/api/files?path=/tmp/big.bin" -H "Authorization: Bearer $T" \
  -H "content-type: application/octet-stream" --data-binary @chunk_000
# {"receivedBytes":1048576,...}
# 后续块带 offset
curl -s -X PUT "$BASE/api/files?path=/tmp/big.bin&offset=1048576" -H "Authorization: Bearer $T" \
  -H "content-type: application/octet-stream" --data-binary @chunk_001
```

- `offset=N`：从位置 N 续写（先截断到 N，容忍上次半截写入）；文件不存在返回 `409 offset_without_file`，N 超过文件大小返回 `409 offset_beyond_eof`
- 传输停滞（默认 30s 无数据，`AITB_UPLOAD_IDLE_MS`）服务端主动断开并返回 `504 {"code":"upload_stalled"}`——**不会无限挂死**
- 客户端中断（未发完就断连）返回 `400 upload_aborted`

**GET /api/files?path=<绝对路径>**：下载文件，`x-aitb-sha256` 头可校验。**`&stat=1`**：只查大小不传内容（续传前对齐用），返回 `{"size":n,"mtimeMs":...}`。404 返回 `{"code":"file_not_found"}`。

### GET /api/health

健康检查（无需认证）。

## 6. WebSocket 终端

```
wss://8790-35521e1ac3aed563.monkeycode-ai.live/ws?token=<token>&session=<id可选>&offset=<n可选>
```

- 不带 `session` 参数时自动创建新会话
- 需要 `session` scope；认证失败返回 HTTP 401

消息协议（JSON 单条文本帧）：

| 方向 | 消息 |
|---|---|
| 客户端 → 服务端 | `{"type":"input","data":"ls\r"}` |
| 客户端 → 服务端 | `{"type":"resize","cols":120,"rows":32}` |
| 客户端 → 服务端 | `{"type":"ping"}` |
| 客户端 → 服务端 | `{"type":"kill"}` |
| 服务端 → 客户端 | `{"type":"snapshot","session":{...},"data":"...","offset":n}` 连接建立时 |
| 服务端 → 客户端 | `{"type":"output","data":"..."}` PTY 输出 |
| 服务端 → 客户端 | `{"type":"exit","code":0}` 进程退出 |
| 服务端 → 客户端 | `{"type":"error","message":"..."}` |
| 服务端 → 客户端 | `{"type":"pong","t":...}` |

Web 界面已内置 25 秒心跳和断线自动重连（1.5s 后重连当前会话）。

## 7. 快速上手示例

```bash
BASE="https://8790-35521e1ac3aed563.monkeycode-ai.live"
T="qq928820655"

# 健康检查
curl -s "$BASE/api/health"

# 执行一条命令
curl -s -X POST "$BASE/api/exec" \
  -H "Authorization: Bearer $T" -H "content-type: application/json" \
  -d '{"command":"uname -a"}'

# 建会话 + 写命令 + 取输出
SID=$(curl -s -X POST "$BASE/api/sessions" -H "Authorization: Bearer $T" \
  -H "content-type: application/json" -d '{}' | python3 -c "import sys,json;print(json.load(sys.stdin)['session']['id'])")
curl -s -X POST "$BASE/api/sessions/$SID/input" \
  -H "Authorization: Bearer $T" -H "content-type: application/json" \
  -d '{"data":"echo hello from bridge\r"}'
sleep 1
curl -s "$BASE/api/sessions/$SID" -H "Authorization: Bearer $T"
```

## 8. 客户端注意事项（实测踩坑记录）

### 8.1 Python urllib / requests 被 403 拦截

预览域名的 Cloudflare 层按 User-Agent 签名拦截（`error code: 1010`），`Python-urllib/3.x` 默认 UA 会被 403，请求**到不了桥**。加一个普通 UA 即可：

```python
headers = {
    "Authorization": "Bearer " + TOK,
    "User-Agent": "aitb-client/1.0",   # 任意非 Python-urllib UA
    "content-type": "application/json",
}
```

### 8.2 urllib 必须捕获 HTTPError，否则「令牌失效」看起来像「桥挂了」

`urllib.request.urlopen` 对 4xx/5xx **抛 `HTTPError` 异常**（不是返回响应对象）。桥返回的 401 + JSON body 就挂在异常对象上。不捕获的话客户端只能看到「抛异常」，和连接层故障难以区分：

```python
import urllib.request, urllib.error

def call(req, timeout=30):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        # 401 = 令牌失效，桥是活的！body 在 e.read() 里
        return e.code, json.loads(e.read() or b'{}')
    except (urllib.error.URLError, TimeoutError) as e:
        return 0, {"error": str(e)}   # 这才是「桥连不上」
```

判活顺序：`GET /api/health` 200 → 桥活着；再 401 → 令牌死了，**换令牌，别重启桥**。

### 8.3 curl 传 body 的姿势 + 多行脚本规则

```bash
# 正确：--data-binary @file 或 -d '<json>'
curl -X POST "$BASE/api/exec" -H "Authorization: Bearer $T" \
  -H "content-type: application/json" --data-binary @body.json

# 错误：-F body.json（multipart 表单，本服务不解析）
```

**多行脚本 / 带真实换行的内容，一律 `PUT /api/files` 落盘再 `exec` 执行，不要塞进 `command` 的内联 JSON**（JSON 字符串里真实换行必须转义成 `\n`，手拼必坏）：

```bash
curl -X PUT "$BASE/api/files?path=/tmp/job.sh" -H "Authorization: Bearer $T" \
  -H "content-type: application/octet-stream" --data-binary @script.sh
curl -X POST "$BASE/api/exec" -H "Authorization: Bearer $T" \
  -H "content-type: application/json" -d '{"command":"bash /tmp/job.sh","timeoutMs":60000}'
```

### 8.4 客户端超时取值硬规则

**`curl -m` 必须 ≥ `timeoutMs/1000 + 30`。** 反例：`-m 15` 配 `timeoutMs:30000` → curl 15s 报 (28) 超时，而桥还在正常跑——现象和「桥挂了」一模一样。detach 模式没有这个问题（发起毫秒级返回），长任务优先 detach。

### 8.5 空 200 响应的兜底

代理层偶发返回「HTTP 200 但 body 为 0 字节」（桥侧从未发出过空体响应）。客户端 JSON 解析前先判空，空 body 按网络故障重试即可（带 `requestId` 时重试零副作用）：

```python
raw = resp.read()
data = json.loads(raw) if raw else {"error": "empty_body", "retry": True}
```

### 8.6 调用方建议

1. **所有 `/api/exec` 都带 `requestId`**（uuid 即可）：代理层重试不会产生重复副作用，回包可一一对应，响应里会回显 `requestId` + `cached` 标记。
2. **超过 ~10s 的命令用 detach 模式**：发起请求毫秒级返回，不存在长连接被代理掐断的问题；轮询 status/output 都是幂等 GET。
3. **超时判断看 `timedOut` + `exitCode=124`**，不要再拿 `exitCode:null` 猜。超时的端到端耗时 ≈ `timeoutMs` + `cleanupMs`（SIGTERM 收尾）+ 网络延迟，轮询间隔要留余量。
4. `output` 已清洗回显/ANSI/CR，**字节精确（末尾换行保留）**，可直接做 sha256sum / diff 比对。detach 的 `output` 接口翻页永远传服务端返回的 `offset`。
5. **detach 翻页的推荐收敛循环**（任务结束后再查会返回空 data、offset 不变）：

```python
off = 0
while True:
    d = get(f"/api/exec/{eid}/output?offset={off}")
    data = d.get("data") or ""
    if not data or d.get("offset") == off:
        break          # 空数据或 offset 没动 -> 到尾巴了
    off = d["offset"]
# 或者直接看 d["status"] != "running" 就不用翻页了
```

## 9. 速率与限制

| 项 | 值 |
|---|---|
| 最大并发会话 | 8（`AITB_MAX_SESSIONS`） |
| 会话空闲回收 | 30 分钟 |
| ephemeral 会话回收 | 完成后 50ms 回收；命令本身跑满 `timeoutMs` 才杀 |
| 滚动缓冲区 | 2 MB / 会话 |
| 令牌最大有效期 | 30 天 |
| 登录失败锁定 | 10 分钟内 8 次失败锁 1 分钟 |
| /api/exec 同步超时 | 默认 15s，最大 120s；超时 `exitCode=124` + `timedOut:true` |
| /api/exec detach 超时 | 默认 15s，最大 10 分钟（`AITB_EXEC_MAX_MS`） |
| detach 任务保留 | 10 分钟（`AITB_EXEC_TTL_MS`） |
| 文件上传/下载 | 单文件 10MB（`AITB_UPLOAD_MAX_BYTES`）；`?offset=N` 断点续传；停滞 30s 返回 504（`AITB_UPLOAD_IDLE_MS`） |
| 会话 exec 超时 | 默认 30s，最大 120s，超时返回 `timedOut:true` + `truncatedReason:"timeout"` |
| 审计日志保留 | 30 天（每小时自动清理） |

# ai-terminal-bridge

把本机终端通过 HTTP + WebSocket + MCP 暴露给外部 AI，让模型可以直接在宿主机上执行命令、读写交互式会话。

- 基于真实 PTY（`pty.fork`），支持 tmux/vim/top 等全屏程序、ANSI 颜色、窗口 resize
- 三种接入方式：HTTP API、WebSocket 实时流、MCP（Claude Desktop / Cursor / opencode 等直接挂载）
- 多令牌体系：固定 bootstrap 令牌 + 可自助创建的静态令牌 + 带过期时间的临时令牌，支持权限范围、轮换、停用、吊销
- 内置 Web 终端（xterm.js）与令牌管理面板，浏览器打开即可用
- 会话上限、空闲回收、输出环形缓冲（默认 2MB / 会话）

## 目录

```
ai-terminal-bridge/
├── bin/
│   ├── pty_worker.py      # PTY 工作进程，JSON 帧多路复用
│   ├── aitb.js            # 命令行客户端
│   └── aitb-mcp.js        # MCP stdio server
├── src/
│   ├── server.js          # HTTP + WebSocket 服务
│   ├── sessions.js        # 会话管理与输出缓冲
│   ├── tokens.js          # 令牌存储、权限范围、过期与轮换
│   └── config.js          # 配置加载与令牌生成
├── public/                # Web 终端界面
├── deploy/                # systemd / 启动 / 安装脚本
├── test/                  # node:test 集成测试
└── package.json
```

## 快速开始

```bash
cd /workspace/ai-terminal-bridge
npm install
npm start
```

启动后输出：

```
ai-terminal-bridge listening on http://127.0.0.1:8787
token: aitb_xxxx****xxxx  (full token in /root/.ai-terminal-bridge/token)
web ui: http://127.0.0.1:8787/?token=<token>
```

浏览器打开 `http://127.0.0.1:8787/?token=<token>`，左侧新建终端即可。

## 配置

`.env`（从 `.env.example` 复制）或用环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `AITB_HOST` | `127.0.0.1` | 监听地址，对外服务用 `0.0.0.0` |
| `AITB_PORT` | `8787` | 端口 |
| `AITB_TOKEN` | 自动生成 | 固定 bootstrap 令牌，权限恒为 admin，不可通过 API 吊销 |
| `AITB_TOKENS_FILE` | `~/.ai-terminal-bridge/tokens.json` | 托管令牌持久化位置 |
| `AITB_SHELL` | `/bin/bash` | 默认 shell |
| `AITB_CWD` | 启动目录 | 默认工作目录 |
| `AITB_MAX_SESSIONS` | `8` | 并发会话上限 |
| `AITB_SESSION_IDLE_MS` | `1800000` | 会话空闲回收时间 |
| `AITB_CONN_IDLE_KILL_MINUTES` | `60` | 无连接多少分钟后自动关闭会话（`AITB_CONN_IDLE_KILL_MS` 可直传毫秒） |
| `AITB_CONN_PURGE_DAYS` | `3` | 关闭后多少天无人使用则清除（`AITB_CONN_PURGE_MS` 可直传毫秒） |
| `AITB_CONN_SWEEP_MS` | `60000` | 生命周期巡检间隔 |
| `AITB_MAX_TTL_MS` | `2592000000`（30d） | 临时令牌最长有效期 |
| `AITB_CORS` | `*` | 允许跨域的 Origin，设为空关闭 CORS 头 |

## 令牌体系

两类令牌并存：

| 类型 | 来源 | 权限 | 有效期 | 管理方式 |
|---|---|---|---|---|
| bootstrap | `AITB_TOKEN` 或 `~/.ai-terminal-bridge/token` | 恒为 `admin` | 永久 | 改环境变量后重启 |
| 静态（static） | API / CLI / Web 面板创建 | 自选 | 永不过期 | 可轮换、停用、删除 |
| 临时（ephemeral） | 创建时指定 TTL | 自选 | 到期自动失效并从库中清除 | 可提前吊销 |

权限范围（scopes）：

- `exec`：`/api/exec` 一次性执行
- `session`：会话增删改查、`/ws` WebSocket、会话内执行/输入/resize
- `admin`：令牌管理接口；含 `admin` 的令牌自动拥有全部权限

令牌存储文件 `tokens.json` 以 0600 写入，列表接口只返回掩码（`aitb_xxxxxxxx****abcd`），完整值仅在创建或轮换时返回一次。

### 创建令牌

```bash
# 固定令牌（给长期外部 agent）
aitb token new --name "agent-prod" --scopes exec,session

# 临时令牌（1 小时后自动失效）
aitb token new --name "agent-temp" --ttl 1h --scopes exec

# 自定义 48 位十六进制令牌值
aitb token new --name "pinned" --value aitb_0123456789abcdef0123456789abcdef0123456789abcdef
```

`--ttl` 支持 `90s`、`30m`、`2h`、`7d` 或纯秒数。不传则永不过期。

### 管理令牌

```bash
aitb token ls                    # 列表（掩码 + 剩余有效期 + scopes）
aitb token verify                # 当前令牌的身份与权限
aitb token rotate <tokenId>      # 轮换，旧值立即失效
aitb token disable <tokenId>     # 停用
aitb token enable <tokenId>      # 启用
aitb token rm <tokenId>          # 删除（吊销）
```

HTTP 等价接口：

```bash
POST   /api/tokens                         创建 {"name":"x","ttlMs":3600000,"scopes":["exec"]}
GET    /api/tokens                         列表
DELETE /api/tokens/<id>                    吊销
POST   /api/tokens/<id>/rotate             轮换
POST   /api/tokens/<id>/disable | /enable  停用 / 启用
GET    /api/token/verify                   校验当前令牌
```

Web 面板左侧「令牌管理」可直接创建静态/临时令牌，创建后完整值会显示 30 秒并自动复制到剪贴板。

## HTTP API

所有 `/api/*`（除 `/api/health`）都需要 `Authorization: Bearer <token>`，也接受 `X-AITB-Token` 头、`?token=` 查询串或 `aitb_token` Cookie。bootstrap 令牌或带对应 scope 的托管令牌均可。

### 健康检查

```bash
curl http://127.0.0.1:8787/api/health
```

### 一次性执行（推荐给 AI）

在新 PTY 里跑命令，进程退出即返回，自动剥离前端回显与 ANSI：

```bash
curl -s -X POST http://127.0.0.1:8787/api/exec \
  -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"command":"ls -la /workspace","timeoutMs":10000}'
```

响应：

```json
{
  "exitCode": 0,
  "output": "total 12\ndrwxr-xr-x ...\n"
}
```

可选字段：`cwd`、`shell`、`timeoutMs`（默认 15000，上限 120000）、`quietMs`、`keep`（保留会话时返回 `sessionId`）。

### 会话管理

```bash
# 新建持久会话
curl -s -X POST http://127.0.0.1:8787/api/sessions \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"cwd":"/tmp","name":"build"}'

# 列表 / 详情 / 删除
curl -s http://127.0.0.1:8787/api/sessions -H "Authorization: Bearer $TOKEN"
curl -s "http://127.0.0.1:8787/api/sessions/<id>?offset=0" -H "Authorization: Bearer $TOKEN"
curl -s -X DELETE http://127.0.0.1:8787/api/sessions/<id> -H "Authorization: Bearer $TOKEN"
```

### 会话内执行与原始输入

```bash
# 在已有交互 shell 里执行，返回增量输出
curl -s -X POST http://127.0.0.1:8787/api/sessions/<id>/exec \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"command":"git status","timeoutMs":8000}'

# 直接写 PTY 字节（适合给交互程序发按键）
curl -s -X POST http://127.0.0.1:8787/api/sessions/<id>/input \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"data":"y\n"}'

# 调整窗口大小
curl -s -X POST http://127.0.0.1:8787/api/sessions/<id>/resize \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"cols":160,"rows":48}'

# 结束 shell 进程
curl -s -X POST http://127.0.0.1:8787/api/sessions/<id>/kill \
  -H "Authorization: Bearer $TOKEN"
```

## WebSocket

```
ws://127.0.0.1:8787/ws?token=<token>[&session=<id>&offset=<n>&cwd=<dir>]
```

不带 `session` 时自动新建会话。

服务端 → 客户端：

```json
{"type":"snapshot","session":{...},"data":"...","offset":1234}
{"type":"output","data":"..."}
{"type":"exit","code":0}
{"type":"error","message":"..."}
```

客户端 → 服务端：

```json
{"type":"input","data":"ls\n"}
{"type":"resize","cols":120,"rows":32}
{"type":"kill"}
{"type":"ping"}
```

## 命令行客户端

通过 `npm link` 或 `node bin/aitb.js` 使用：

```bash
export AITB_URL=http://127.0.0.1:8787
export AITB_TOKEN=$(cat ~/.ai-terminal-bridge/token)

node bin/aitb.js health
node bin/aitb.js exec "uname -a; df -h"
node bin/aitb.js exec "make -j4" --cwd /workspace/proj --timeout 120000
node bin/aitb.js new --cwd /tmp --name scratch
node bin/aitb.js sh <sessionId> "cd /etc && ls"
node bin/aitb.js tail <sessionId>
node bin/aitb.js ls
node bin/aitb.js rm <sessionId>

# 令牌管理
node bin/aitb.js token new --name agent --ttl 2h --scopes exec,session
node bin/aitb.js token ls
```

外部 agent 拿到临时令牌后只需把它设成 `AITB_TOKEN` 即可调用，与服务端的 bootstrap 令牌互不影响。

## MCP 接入

`bin/aitb-mcp.js` 是一个 stdio MCP server，暴露 7 个工具：`terminal_exec`、`terminal_new`、`terminal_list`、`terminal_send`、`terminal_read`、`terminal_kill`、`terminal_remove`。

### opencode / Claude Desktop / Cursor

在对应配置里加入（以 `opencode.json` 为例）：

```json
{
  "mcp": {
    "terminal": {
      "type": "local",
      "command": ["node", "/workspace/ai-terminal-bridge/bin/aitb-mcp.js"],
      "enabled": true,
      "environment": {
        "AITB_URL": "http://127.0.0.1:8787",
        "AITB_TOKEN": "<token>"
      }
    }
  }
}
```

Claude Desktop 的 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "terminal": {
      "command": "node",
      "args": ["/workspace/ai-terminal-bridge/bin/aitb-mcp.js"],
      "env": {
        "AITB_URL": "http://127.0.0.1:8787",
        "AITB_TOKEN": "<token>"
      }
    }
  }
}
```

对应模型侧的调用：

```json
{"name":"terminal_exec","arguments":{"command":"df -h"}}
{"name":"terminal_new","arguments":{"cwd":"/workspace","name":"work"}}
{"name":"terminal_send","arguments":{"session_id":"s123","data":"npm run build\n","wait_ms":2000}}
{"name":"terminal_read","arguments":{"session_id":"s123","offset":0}}
```

## 部署

临时前台运行：

```bash
./deploy/start.sh
```

systemd 常驻（root）：

```bash
sudo ./deploy/install.sh
sudo ./deploy/uninstall.sh   # 卸载
```

`install.sh` 会生成令牌写入 `/etc/systemd/system/ai-terminal-bridge.service`，并 `enable --now`。对外监听时在 service 里设 `AITB_HOST=0.0.0.0`。

## 安全说明

- 默认只监听 `127.0.0.1`；改成 `0.0.0.0` 前请确认网络边界，最好前面加反向代理与 TLS
- bootstrap 令牌是唯一最高凭据，泄露等于交出完整控制权；日常外部接入建议发放受限 scope 的静态/临时令牌
- 令牌是唯一凭据，泄露等于交出 shell；轮换：`aitb token rotate <id>`，或在 Web 面板点「轮换」
- 服务以启动它的用户身份运行，不要用 root 起（除非明确需要）
- 令牌不要进 git、日志或前端源码；`tokens.json` 与 `token` 文件权限均为 0600

## 测试

```bash
npm test
```

覆盖鉴权、令牌增删改查与过期、权限范围、轮换停用、一次性执行、会话生命周期、WebSocket 流、静态资源、detach、断点续传、超时语义、审计、配置解析等 55 个用例。

'use strict';

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'aitb_token';
const USER_KEY = 'aitb_user';

let sessionToken = localStorage.getItem(TOKEN_KEY) || '';
let username = localStorage.getItem(USER_KEY) || 'admin';
const urlToken = new URLSearchParams(location.search).get('token');
if (urlToken) history.replaceState(null, '', location.pathname);

let term = null;
let fit = null;
let socket = null;
let currentId = null;
let appStarted = false;
let forcedChange = false;
let authKind = '';

function setConn(text, ok) {
  const el = $('connState');
  el.textContent = text;
  el.style.color = ok ? '#3fb950' : '#7d8590';
}

function onUnauthorized() {
  sessionToken = '';
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${sessionToken}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401 && !path.startsWith('/api/auth/login')) {
    onUnauthorized();
    throw new Error('unauthorized');
  }
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function doLogin(u, p) {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  sessionToken = data.sessionToken;
  localStorage.setItem(TOKEN_KEY, sessionToken);
  if (data.account && data.account.username) {
    username = data.account.username;
    localStorage.setItem(USER_KEY, username);
  }
  return data;
}

function showLogin(message) {
  $('userView').classList.add('hidden');
  $('passView').classList.add('hidden');
  $('loginView').classList.remove('hidden');
  $('loginErr').textContent = message || '';
  $('loginPass').value = '';
  setSidebarLocked(true);
  $('empty').textContent = '登录后可使用终端';
  setTimeout(() => $('loginPass').focus(), 50);
}

function setSidebarLocked(locked) {
  for (const id of ['sessionPanel', 'tokenPanel', 'docPanel', 'auditPanel']) {
    $(id).classList.toggle('hidden', locked);
  }
}

function showPassCard(forced) {
  forcedChange = forced;
  $('passTitle').textContent = forced ? '设置新密码' : '修改密码';
  $('passNote').classList.toggle('hidden', !forced);
  $('passCancel').classList.toggle('hidden', forced);
  $('passErr').textContent = '';
  $('passOld').value = '';
  $('passNew').value = '';
  $('passNew2').value = '';
  $('passView').classList.remove('hidden');
  setTimeout(() => $('passOld').focus(), 50);
}

function hidePassModal() {
  $('passView').classList.add('hidden');
}

function hideAuth() {
  $('loginView').classList.add('hidden');
  $('passView').classList.add('hidden');
  $('userView').classList.remove('hidden');
  setSidebarLocked(false);
  $('empty').textContent = '选择或新建一个终端';
}

function setUser(name, kind) {
  const isToken = String(kind || '').startsWith('token');
  $('whoami').textContent = name || '未登录';
  $('userAvatar').textContent = (String(name || '?')[0] || '?').toUpperCase();
  $('userKind').textContent = isToken ? '令牌会话' : '账号登录';
  $('btnChangePass').classList.toggle('hidden', isToken || !name);
}

function startApp() {
  if (appStarted) {
    setUser(username, authKind);
    return;
  }
  appStarted = true;
  setUser(username, authKind);
  ensureTerminal();
  loadSessions();
  loadTokens();
  loadAuditHint();
  setInterval(() => {
    if (document.visibilityState === 'visible') loadSessions();
  }, 5000);
  $('empty').style.display = 'grid';
}

async function afterLogin(data) {
  authKind = (data.account && data.account.kind) || (data.account && data.account.username ? 'account' : 'token');
  if (data.account && data.account.username) {
    username = data.account.username;
    localStorage.setItem(USER_KEY, username);
  }
  if (data.mustChangePassword) {
    hideAuth();
    showPassCard(true);
    return;
  }
  hideAuth();
  startApp();
}

async function boot() {
  if (urlToken) {
    try {
      const data = await doLogin('admin', urlToken);
      await afterLogin(data);
    } catch (err) {
      showLogin(`URL 中的令牌无效：${err.message}`);
    }
    return;
  }
  if (!sessionToken) {
    showLogin();
    return;
  }
  try {
    const me = await api('/api/auth/me');
    authKind = me.kind || 'token';
    if (me.username && !me.username.startsWith('token:')) username = me.username;
    if (me.account && me.account.mustChangePassword) {
      hideAuth();
      showPassCard(true);
      return;
    }
    hideAuth();
    startApp();
  } catch {
    if (sessionToken) showLogin();
  }
}

$('loginBtn').addEventListener('click', async () => {
  const u = $('loginUser').value.trim() || 'admin';
  const p = $('loginPass').value;
  if (!p) {
    $('loginErr').textContent = '请输入密码或登录令牌';
    return;
  }
  try {
    const data = await doLogin(u, p);
    await afterLogin(data);
  } catch (err) {
    $('loginErr').textContent = err.message;
  }
});
$('loginPass').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('loginBtn').click();
});

$('passSave').addEventListener('click', async () => {
  const cur = $('passOld').value;
  const n1 = $('passNew').value;
  const n2 = $('passNew2').value;
  if (n1.length < 6) {
    $('passErr').textContent = '新密码至少 6 位';
    return;
  }
  if (n1 !== n2) {
    $('passErr').textContent = '两次输入的新密码不一致';
    return;
  }
  try {
    await api('/api/auth/password', {
      method: 'POST',
      body: JSON.stringify({ username, currentPassword: cur, newPassword: n1 }),
    });
    hidePassModal();
    if (forcedChange) {
      forcedChange = false;
      startApp();
    }
  } catch (err) {
    $('passErr').textContent = err.message;
  }
});

$('passCancel').addEventListener('click', hidePassModal);

$('btnChangePass').addEventListener('click', () => showPassCard(false));

$('btnLogout').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  location.reload();
});

function ensureTerminal() {
  if (term) return;
  term = new Terminal({
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 13,
    cursorBlink: true,
    theme: {
      background: '#0b0e14',
      foreground: '#c9d1d9',
      cursor: '#1f6feb',
      selectionBackground: '#264f78',
    },
  });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open($('terminal'));
  fit.fit();
  term.onData((data) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'input', data }));
    }
  });
  term.onResize(({ cols, rows }) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols, rows }));
    }
  });
  window.addEventListener('resize', () => {
    try {
      fit.fit();
    } catch {
      /* hidden */
    }
  });
}

let reconnectTimer = null;

function connect(sessionId) {
  if (socket) {
    if (socket._ping) clearInterval(socket._ping);
    try {
      socket.close();
    } catch {
      /* noop */
    }
    socket = null;
  }
  ensureTerminal();
  term.reset();
  $('empty').style.display = 'none';
  currentId = sessionId;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ token: sessionToken });
  if (sessionId) params.set('session', sessionId);
  socket = new WebSocket(`${proto}://${location.host}/ws?${params}`);
  const sock = socket;

  sock.onopen = () => {
    if (sock !== socket) return;
    setConn('已连接', true);
    fit.fit();
    socket._ping = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
  };
  sock.onmessage = (event) => {
    if (sock !== socket) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === 'snapshot') {
      currentId = msg.session.id;
      if (msg.data) term.write(msg.data);
      loadSessions();
    } else if (msg.type === 'output') {
      term.write(msg.data);
    } else if (msg.type === 'exit') {
      term.write(`\r\n\x1b[90m[进程已退出 code=${msg.code}]\x1b[0m\r\n`);
      setConn('进程已退出', false);
      loadSessions();
    } else if (msg.type === 'error') {
      if (/session not found/i.test(msg.message || '')) {
        currentId = null;
        term.reset();
        $('empty').style.display = 'grid';
        loadSessions();
      } else {
        term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
      }
    }
  };
  sock.onclose = () => {
    if (sock !== socket) return;
    setConn('断开', false);
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (currentId && document.visibilityState === 'visible') {
        connect(currentId);
      }
    }, 1500);
  };
  sock.onerror = () => {
    if (sock !== socket) return;
    setConn('连接错误', false);
  };
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('zh-CN', { hour12: false });
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 3600 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function renderSessions(sessions) {
  const list = $('sessionList');
  if (!sessions) return;
  list.innerHTML = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    li.className = 'session-item' + (s.id === currentId ? ' active' : '');
    li.innerHTML = `
      <div class="row">
        <span class="name"></span>
        <button class="close" title="关闭">×</button>
      </div>
      <div class="row">
        <span class="meta"></span>
        <span class="dot ${s.alive ? '' : 'dead'}"></span>
      </div>
      <div class="viewers"></div>`;
    li.querySelector('.name').textContent = s.name || s.id;
    li.querySelector('.meta').textContent = `${s.cwd} · ${fmtTime(s.createdAt)}`;
    const vEl = li.querySelector('.viewers');
    const live = s.viewers || [];
    const parts = [];
    if (live.length) {
      parts.push(`使用中：${live.join('、')}`);
    } else if (s.alive) {
      parts.push('空闲');
    }
    if (s.lastOperator && !live.includes(s.lastOperator)) {
      parts.push(`${s.lastOperator} ${timeAgo(s.lastOperatorAt)}操作过`);
    }
    vEl.textContent = parts.join(' · ');
    if (live.length) vEl.classList.add('busy');
    else if (s.lastOperator) vEl.classList.add('recent');
    li.querySelector('.close').addEventListener('click', async (e) => {
      e.stopPropagation();
      await api(`/api/sessions/${encodeURIComponent(s.id)}`, { method: 'DELETE' }).catch(() => {});
      if (currentId === s.id) {
        currentId = null;
        term && term.reset();
        $('empty').style.display = 'grid';
      }
      loadSessions();
    });
    li.addEventListener('click', () => connect(s.id));
    list.appendChild(li);
  }
}

function fmtDateTime(ts) {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', {
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

let auditTimer = null;
let auditCache = [];

function buildTerminals(events) {
  const map = new Map();
  const ensure = (id, ts, actor, ip) => {
    if (!map.has(id)) {
      map.set(id, { sessionId: id, creator: '', ip: '', start: ts, viewers: [], lastDisconnect: 0, end: null });
    }
    const t = map.get(id);
    if (!t.creator && actor) t.creator = actor;
    if (!t.ip && ip) t.ip = ip;
    if (ts < t.start) t.start = ts;
    return t;
  };
  for (const ev of events) {
    if (ev.kind === 'session_create' && ev.sessionId) {
      ensure(ev.sessionId, ev.ts, ev.actor, ev.ip);
    } else if (ev.kind === 'ws_connect' && ev.sessionId) {
      const t = ensure(ev.sessionId, ev.ts, ev.actor, ev.ip);
      if (!t.viewers.includes(ev.actor)) t.viewers.push(ev.actor);
    } else if (ev.kind === 'ws_disconnect' && ev.sessionId) {
      const t = map.get(ev.sessionId);
      if (t && ev.ts > t.lastDisconnect) t.lastDisconnect = ev.ts;
    } else if (ev.kind === 'session_end' && ev.sessionId) {
      const t = ensure(ev.sessionId, ev.ts, 'system', '');
      t.end = ev;
    }
  }
  return [...map.values()].sort((a, b) => b.start - a.start);
}

function findSessionEnd(sessionId) {
  for (let i = auditCache.length - 1; i >= 0; i--) {
    const e = auditCache[i];
    if (e.kind === 'session_end' && e.sessionId === sessionId) return e;
  }
  return null;
}

async function loadAudit() {
  try {
    const data = await api('/api/audit?limit=1000');
    auditCache = data.events;
    const list = $('auditList');
    list.innerHTML = '';
    const terminals = buildTerminals(auditCache);
    for (const t of terminals) {
      const endEv = findSessionEnd(t.sessionId);
      const li = document.createElement('li');
      li.className = 'audit-row';
      li.innerHTML = `
        <span class="at"></span>
        <span class="who"></span>
        <span class="sid"></span>
        <span class="st"></span>`;
      li.querySelector('.at').textContent = fmtDateTime(t.start);
      li.querySelector('.who').textContent = [t.creator, ...t.viewers].filter(Boolean).join(' / ') || '-';
      li.querySelector('.sid').textContent = t.sessionId;
      const st = li.querySelector('.st');
      if (t.end) {
        st.textContent = `已结束 ${fmtTime(t.end.ts)} · 访问: ${t.viewers.join('、') || '-'}`;
      } else if (t.viewers.length) {
        st.textContent = `访问中：${t.viewers.join('、')}`;
        st.classList.add('on');
      } else if (t.lastDisconnect) {
        st.textContent = `已断开 ${fmtTime(t.lastDisconnect)}`;
      } else {
        st.textContent = '运行中';
      }
      li.addEventListener('click', () => openTermIo({
        sessionId: t.sessionId,
        actor: t.creator || t.viewers[0] || '-',
        ip: t.ip,
        start: t.start,
        end: t.lastDisconnect || (t.end && t.end.ts) || null,
      }, t.end || endEv));
      list.appendChild(li);
    }
    if (!terminals.length) {
      list.innerHTML = '<li class="hint">暂无终端记录</li>';
    }

    const evWrap = $('auditEvents');
    evWrap.innerHTML = '';
    const labels = {
      login: '登录', login_fail: '登录失败', logout: '退出',
      ws_connect: '终端接入', ws_disconnect: '终端断开', ws_kill: '终止终端',
      api: '接口调用', forbidden: '权限拒绝',
      session_create: '创建终端', session_end: '终端结束',
    };
    for (const ev of auditCache.slice(-80).reverse()) {
      const li = document.createElement('li');
      li.className = 'audit-ev' + (ev.kind === 'login_fail' || ev.kind === 'forbidden' ? ' bad' : '');
      li.innerHTML = `<span class="t"></span><span class="k"></span><span class="d"></span>`;
      li.querySelector('.t').textContent = fmtDateTime(ev.ts);
      li.querySelector('.k').textContent = labels[ev.kind] || ev.kind;
      li.querySelector('.d').textContent = [ev.actor, ev.detail || (ev.sessionId || ''), ev.ip].filter(Boolean).join(' · ');
      evWrap.appendChild(li);
    }

    $('auditLive').classList.add('on');
    $('auditModalHint').textContent = `共 ${data.info.count} 条事件 / ${terminals.length} 个终端 · 保留 ${Math.round(data.info.maxAgeMs / 86400000)} 天 · 点击终端行查看输入输出`;
    $('auditHint').textContent = `共 ${terminals.length} 个终端 / ${data.info.count} 条事件`;
  } catch (err) {
    $('auditLive').classList.remove('on');
    $('auditModalHint').textContent = err.message;
  }
}

function openAuditModal() {
  $('auditModal').classList.remove('hidden');
  loadAudit();
  if (!auditTimer) {
    auditTimer = setInterval(() => {
      if (!$('auditModal').classList.contains('hidden')) loadAudit();
    }, 4000);
  }
}

async function openTermIo(acc, endEv) {
  $('termIoTitle').textContent = `终端 ${acc.sessionId}`;
  $('termModal').classList.remove('hidden');
  $('termIoBody').innerHTML = '<p class="hint">加载中…</p>';
  let output = '';
  let live = false;
  try {
    const r = await api(`/api/sessions/${encodeURIComponent(acc.sessionId)}?strip=0`);
    output = r.session.data || '';
    live = r.session.alive;
  } catch {
    output = endEv ? endEv.output || '' : '';
    live = false;
  }
  if (!endEv) endEv = findSessionEnd(acc.sessionId);
  const md = [
    `### 终端 ${acc.sessionId}`,
    '',
    `- 访问者：${acc.actor || '-'}`,
    `- 来源 IP：${acc.ip || '-'}`,
    `- 接入时间：${fmtDateTime(acc.start)}`,
    `- 连接状态：${acc.end ? `已于 ${fmtDateTime(acc.end)} 断开` : '访问中'}`,
    endEv ? `- 终端进程：已结束（${endEv.detail || ''}，${fmtDateTime(endEv.ts)}）` : `- 终端进程：${live ? '运行中' : '状态未知'}`,
    '',
    '```',
    output || '(无输出记录)',
    '```',
  ].join('\n');
  $('termIoBody').innerHTML = renderMarkdown(md);
  $('termIoBody').dataset.raw = md;
}

async function loadAuditHint() {
  try {
    const data = await api('/api/audit?limit=1');
    $('auditHint').textContent = `共 ${data.info.count} 条事件，保留 ${Math.round(data.info.maxAgeMs / 86400000)} 天，超期自动清理`;
  } catch {
    /* sidebar hint only */
  }
}

$('btnAudit').addEventListener('click', openAuditModal);
$('auditRefresh').addEventListener('click', loadAudit);
$('auditClose').addEventListener('click', () => $('auditModal').classList.add('hidden'));
$('auditModal').addEventListener('click', (e) => {
  if (e.target === $('auditModal')) $('auditModal').classList.add('hidden');
});
$('termIoClose').addEventListener('click', () => $('termModal').classList.add('hidden'));
$('termModal').addEventListener('click', (e) => {
  if (e.target === $('termModal')) $('termModal').classList.add('hidden');
});
$('termIoCopy').addEventListener('click', async () => {
  const raw = $('termIoBody').dataset.raw || '';
  const ok = await copyText(raw);
  $('termIoCopy').textContent = ok ? '已复制' : '复制失败';
  setTimeout(() => {
    $('termIoCopy').textContent = '复制全文';
  }, 1500);
});

async function loadSessions() {
  try {
    const data = await api('/api/sessions');
    renderSessions(data.sessions);
    setConn('已连接', true);
  } catch (err) {
    setConn(err.message, false);
  }
}

async function loadTokens() {
  const list = $('tokenList');
  if (!list) return;
  try {
    const data = await api('/api/tokens');
    list.innerHTML = '';
    if (!data.tokens.length) {
      $('tokenHint').textContent = '暂无托管令牌（bootstrap 令牌不可在此管理）';
    } else {
      $('tokenHint').textContent = '点「复制」可随时查看完整令牌，已自动复制到剪贴板';
    }
    for (const t of data.tokens) {
      const li = document.createElement('li');
      li.className = 'token-item';
      const exp = t.expiresAt ? `${Math.max(0, Math.round(t.expiresInMs / 1000))}s 后过期` : '永不过期';
      li.innerHTML = `
        <div class="row">
          <span class="tname"></span>
          <span class="badge ${t.kind}${t.enabled ? '' : ' off'}"></span>
        </div>
        <div class="tval"></div>
        <div class="row">
          <span>${exp} · ${t.scopes.join(',')}</span>
          <span class="acts">
            <button data-act="copy">复制</button>
            <button data-act="rotate">轮换</button>
            <button data-act="toggle">${t.enabled ? '停用' : '启用'}</button>
            <button data-act="rm">删除</button>
          </span>
        </div>`;
      li.querySelector('.tname').textContent = t.name;
      li.querySelector('.badge').textContent = t.enabled ? t.kind : 'off';
      li.querySelector('.tval').textContent = t.masked;
      li.querySelectorAll('button').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const act = btn.dataset.act;
          try {
            if (act === 'copy') {
              const r = await api(`/api/tokens/${encodeURIComponent(t.id)}/reveal`);
              showReveal(`${t.name} 完整令牌（已复制）`, r.token.token);
            } else if (act === 'rotate') {
              const r = await api(`/api/tokens/${encodeURIComponent(t.id)}/rotate`, { method: 'POST', body: '{}' });
              showReveal('已轮换，旧令牌立即失效：', r.token.token);
            } else if (act === 'toggle') {
              const op = t.enabled ? 'disable' : 'enable';
              await api(`/api/tokens/${encodeURIComponent(t.id)}/${op}`, { method: 'POST', body: '{}' });
            } else if (act === 'rm') {
              await api(`/api/tokens/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
            }
            loadTokens();
          } catch (err) {
            $('tokenHint').textContent = err.message;
          }
        });
      });
      list.appendChild(li);
    }
  } catch (err) {
    const list2 = $('tokenList');
    if (list2) list2.innerHTML = '';
    $('tokenHint').textContent = err.message === 'forbidden' ? '当前令牌无 admin 权限' : err.message;
  }
}

function showReveal(label, value) {
  const box = document.createElement('div');
  box.className = 'reveal';
  box.textContent = `${label}\n${value}`;
  $('tokenPanel').insertBefore(box, $('tokenList'));
  if (navigator.clipboard) navigator.clipboard.writeText(value).catch(() => {});
  setTimeout(() => box.remove(), 30000);
}
function parseTtl(text) {
  const m = /^(\d+)\s*([smhd])$/.exec(String(text || '').trim().toLowerCase());
  if (!m) return 0;
  const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
  return Number(m[1]) * mult;
}

$('tfCreate').addEventListener('click', async () => {
  const name = $('tfName').value.trim();
  const kind = $('tfKind').value;
  const ttl = parseTtl($('tfTtl').value);
  const value = $('tfValue').value.trim();
  const body = { name: name || (kind === 'ephemeral' ? '临时令牌' : '静态令牌') };
  if (kind === 'ephemeral') {
    if (!ttl) {
      $('tokenHint').textContent = '临时令牌需要有效期，格式如 30m/2h/7d';
      return;
    }
    body.ttlMs = ttl;
  }
  if (value) body.token = value;
  try {
    const data = await api('/api/tokens', { method: 'POST', body: JSON.stringify(body) });
    showReveal(`${body.name}（已复制）`, data.token.token);
    $('tfName').value = '';
    $('tfTtl').value = '';
    $('tfValue').value = '';
    loadTokens();
  } catch (err) {
    $('tokenHint').textContent = err.message;
  }
});

function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const out = [];
  const lines = md.split('\n');
  let i = 0;
  let listBuf = [];
  let listType = 'ul';

  const flushList = () => {
    if (listBuf.length) {
      out.push(`<${listType}>` + listBuf.map((t) => `<li>${inline(t)}</li>`).join('') + `</${listType}>`);
      listBuf = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('```')) {
      flushList();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      out.push(
        `<div class="md-code-wrap"><button type="button" class="md-copy" data-copy="1">复制</button><pre class="md-code">${esc(buf.join('\n'))}</pre></div>`
      );
      continue;
    }

    if (/^\s*\|/.test(line)) {
      flushList();
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        rows.push(lines[i].trim());
        i++;
      }
      const parse = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const isSep = (r) => /^[\s|:-]+$/.test(r);
      const header = parse(rows[0]);
      const bodyRows = rows.slice(1).filter((r) => !isSep(r)).map(parse);
      out.push(
        '<table><thead><tr>' + header.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
        + bodyRows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        + '</tbody></table>'
      );
      continue;
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flushList();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (listType !== 'ul' && listBuf.length) flushList();
      listType = 'ul';
      listBuf.push(li[1]);
      i++;
      continue;
    }

    const oli = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (oli) {
      if (listType !== 'ol' && listBuf.length) flushList();
      listType = 'ol';
      listBuf.push(oli[1]);
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,})\s*$/.test(line)) {
      flushList();
      out.push('<hr>');
      i++;
      continue;
    }

    if (!line.trim()) {
      flushList();
      i++;
      continue;
    }

    flushList();
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  flushList();
  return out.join('\n');
}

async function copyText(text) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

$('btnApiDoc').addEventListener('click', async () => {
  $('docModal').classList.remove('hidden');
  $('docBody').innerHTML = '<p class="hint">加载中…</p>';
  try {
    const data = await api('/api/docs');
    $('docBody').innerHTML = renderMarkdown(data.markdown);
    $('docBody').dataset.raw = data.markdown;
  } catch (err) {
    $('docBody').innerHTML = `<p class="err">文档加载失败：${err.message}</p>`;
  }
});
$('docClose').addEventListener('click', () => $('docModal').classList.add('hidden'));
$('docModal').addEventListener('click', (e) => {
  if (e.target === $('docModal')) $('docModal').classList.add('hidden');
});
$('docCopyAll').addEventListener('click', async () => {
  const raw = $('docBody').dataset.raw || '';
  const ok = await copyText(raw);
  $('docCopyAll').textContent = ok ? '已复制' : '复制失败';
  setTimeout(() => {
    $('docCopyAll').textContent = '复制全文';
  }, 1500);
});
$('docBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('.md-copy');
  if (!btn) return;
  const pre = btn.parentElement.querySelector('.md-code');
  if (!pre) return;
  const ok = await copyText(pre.textContent);
  btn.textContent = ok ? '已复制' : '失败';
  setTimeout(() => {
    btn.textContent = '复制';
  }, 1200);
});

$('newSession').addEventListener('click', async () => {
  try {
    const data = await api('/api/sessions', { method: 'POST', body: '{}' });
    await loadSessions();
    connect(data.session.id);
  } catch (err) {
    setConn(err.message, false);
  }
});

$('refreshSessions').addEventListener('click', loadSessions);

boot();

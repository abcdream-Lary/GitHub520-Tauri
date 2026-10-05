'use strict';
/* ══════════════════════════════════════════════════════════════
   GitHub520 Desktop — 渲染层逻辑
   ══════════════════════════════════════════════════════════════ */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const ICON = {
  warn: '<svg viewBox="0 0 20 20"><path d="M10 3.4 17.4 16.6H2.6L10 3.4Z"/><path d="M10 8.4v3.2M10 14.1v.1"/></svg>',
  info: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.2"/><path d="M10 9.2v4.2M10 6.9v.1"/></svg>',
  ok: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.2"/><path d="M6.9 10.3l2.1 2.1 4.1-4.4"/></svg>',
  bad: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.2"/><path d="M7.4 7.4l5.2 5.2M12.6 7.4l-5.2 5.2"/></svg>',
  search: '<svg viewBox="0 0 20 20"><circle cx="9" cy="9" r="5.1"/><path d="M12.8 12.8l4 4"/></svg>',
  add: '<svg viewBox="0 0 20 20"><path d="M10 4.6v10.8M4.6 10h10.8"/></svg>',
  edit: '<svg viewBox="0 0 20 20"><path d="M13.4 3.9l2.7 2.7L8 14.7l-3.5.8.8-3.5 8.1-8.1Z"/></svg>',
  trash: '<svg viewBox="0 0 20 20"><path d="M4.6 6.2h10.8M8.2 6.2V4.7h3.6v1.5M6.4 6.2l.7 9.1h5.8l.7-9.1"/></svg>',
  bolt: '<svg viewBox="0 0 20 20"><path d="M11.4 2.8 4.9 11h4.2l-.5 6.2L15.1 9h-4.2l.5-6.2Z"/></svg>',
  reload: '<svg viewBox="0 0 20 20"><path d="M16 8.6A6.3 6.3 0 0 0 5.2 6.5M4 11.4a6.3 6.3 0 0 0 10.8 2.1"/><path d="M16.3 5v3.6h-3.6M3.7 15v-3.6h3.6"/></svg>',
  save: '<svg viewBox="0 0 20 20"><path d="M4.7 3.8h8.1l2.5 2.5v9.9H4.7z"/><path d="M7.3 3.8v4h5.4v-4M7.3 16.2v-4.4h5.4v4.4"/></svg>',
  undo: '<svg viewBox="0 0 20 20"><path d="M7.4 6.4H4V3M4.6 6.7a6.3 6.3 0 1 1-1.3 6.4"/></svg>',
  folder: '<svg viewBox="0 0 20 20"><path d="M2.9 5.6h5l1.4 1.8h7.8v7.3a1.4 1.4 0 0 1-1.4 1.4H4.3a1.4 1.4 0 0 1-1.4-1.4V5.6Z"/></svg>',
  empty: '<svg viewBox="0 0 32 32"><path d="M6 9h20v14H6z"/><path d="M6 14h6l2 3h4l2-3h6"/></svg>',
};

/* ---------------- 状态 ---------------- */
const S = {
  info: null,
  hostsPath: '',
  canWrite: false,
  rows: [],
  baseline: [],
  page: 'hosts',
  q: '',
  filter: 'all',
  showRaw: false,
  speed: { running: false, results: [], done: 0, total: 0, scope: 'enabled', samples: '3' },
  sync: { log: [], lastResult: null, running: false },
  rowLat: {},
};

const clone = (v) => JSON.parse(JSON.stringify(v));
const isDirty = () => JSON.stringify(S.rows) !== JSON.stringify(S.baseline);

let _uidSeq = 0;
const uid = () =>
  (window.crypto && window.crypto.randomUUID && window.crypto.randomUUID()) ||
  `id-${Date.now().toString(36)}-${(_uidSeq++).toString(36)}`;

/* ---------------- 焦点保持（整页重渲染时） ---------------- */
function preserveFocus(fn) {
  const el = document.activeElement;
  const id = el && el.id;
  const ss = el && 'selectionStart' in el ? el.selectionStart : null;
  const se = el && 'selectionEnd' in el ? el.selectionEnd : null;
  fn();
  if (id) {
    const next = document.getElementById(id);
    if (next && typeof next.focus === 'function') {
      next.focus();
      try {
        if (ss !== null && next.setSelectionRange) next.setSelectionRange(ss, se);
      } catch (_) {}
    }
  }
}

/* ---------------- Toast ---------------- */
/** 图标必须带上 .ic —— 尺寸/描边都挂在 .toast .ic 上，裸 <svg> 会被填成实心黑块 */
const toastIcon = (type) => (ICON[type] || ICON.info).replace('<svg', '<svg class="ic"');

/** 给路径插入 <wbr> 断点：换行落在分隔符之后，且不像零宽空格那样污染复制内容 */
const softBreakPath = (s) => esc(s).replace(/([\\/])/g, '$1<wbr>');

function toast(type, title, desc = '', ms = 3600) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `${toastIcon(type)}<div class="toast-body"><div class="tt">${esc(title)}</div>${
    desc ? `<div class="td" title="${esc(desc)}">${softBreakPath(desc)}</div>` : ''
  }</div>`;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  }, ms);
}

/* ---------------- 工具 ---------------- */
const pad2 = (n) => String(n).padStart(2, '0');
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}:${pad2(d.getSeconds())}`;
}
/** 相对时间拆成 {数值, 单位}，好在指标卡里用不同字号排版 */
function relParts(ts) {
  if (!ts) return { n: '—', u: '' };
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 10) return { n: '刚刚', u: '' };
  if (s < 60) return { n: String(s), u: '秒前' };
  if (s < 3600) return { n: String(Math.floor(s / 60)), u: '分钟前' };
  if (s < 86400) return { n: String(Math.floor(s / 3600)), u: '小时前' };
  return { n: String(Math.floor(s / 86400)), u: '天前' };
}
function relTime(ts) {
  if (!ts) return '从未';
  const p = relParts(ts);
  return p.u ? `${p.n} ${p.u}` : p.n;
}

/** 倒计时同样拆成 {数值, 单位} */
function countdownParts(left) {
  if (left <= 0) return { n: '即将', u: '开始' };
  const h = Math.floor(left / 3600000);
  const m = Math.floor((left % 3600000) / 60000);
  const s = Math.floor((left % 60000) / 1000);
  if (h) return { n: String(h), u: `小时 ${m} 分后` };
  if (m) return { n: String(m), u: `分 ${s} 秒后` };
  return { n: String(s), u: '秒后' };
}

/** 指标卡统一结构：标签 / 数值+单位 / 单行脚注（超长省略并挂 title） */
function statCard(opt) {
  const tone = opt.tone ? ` ${opt.tone}` : '';
  const dot = opt.dot ? '<span class="sdot"></span>' : '';
  const foot =
    opt.bar != null
      ? `<div class="n nbar"><div class="progress"><i style="width:${Math.max(
          0,
          Math.min(100, opt.bar)
        )}%"></i></div></div>`
      : opt.note !== undefined
        ? `<div class="n${opt.noteMono ? ' mono' : ''}" title="${esc(opt.note)}">${esc(opt.note)}</div>`
        : '';
  return `<div class="stat${tone}">
    <div class="k">${esc(opt.k)}</div>
    <div class="v"${opt.vid ? ` id="${opt.vid}"` : ''}>${dot}<span>${esc(opt.n)}</span>${
      opt.u ? `<small>${esc(opt.u)}</small>` : ''
    }</div>
    ${foot}
  </div>`;
}
function syncLog(type, msg) {
  S.sync.log.unshift({ type, msg, at: Date.now() });
  if (S.sync.log.length > 120) S.sync.log.pop();
}
function latClass(v) {
  if (v == null) return 'bad';
  if (v <= 150) return 'ok';
  if (v <= 400) return 'mid';
  if (v <= 800) return 'slow';
  return 'bad';
}
function entryRows() {
  return S.rows.filter((r) => r.kind === 'entry');
}
function visibleRows() {
  const q = S.q.trim().toLowerCase();
  return S.rows.filter((r) => {
    if (r.kind !== 'entry') return S.showRaw;
    if (q) {
      const hay = `${r.ip} ${r.hosts.join(' ')} ${r.comment || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    switch (S.filter) {
      case 'enabled':
        return r.enabled;
      case 'disabled':
        return !r.enabled;
      case 'managed':
        return !!r.managed;
      case 'user':
        return !r.managed;
      default:
        return true;
    }
  });
}

/* ══════════════════════════════════════════════════════════════
   顶栏状态
   ══════════════════════════════════════════════════════════════ */
function renderChrome() {
  const priv = $('#tbPriv');
  priv.className = 'tb-chip ' + (S.canWrite ? 'ok' : 'warn');
  priv.querySelector('.txt').textContent = S.canWrite ? '可写入 hosts' : '需管理员权限';
  priv.title = S.canWrite
    ? '当前进程具备 hosts 文件写入权限'
    : '写入 hosts 需要管理员权限，应用时会弹出 UAC 授权';

  const sync = $('#tbSync');
  const r = S.sync.lastResult;
  let cls = '';
  let txt = '未同步';
  if (S.sync.running) {
    cls = 'busy';
    txt = '同步中…';
  } else if (r && r.ok && r.needAdmin) {
    cls = 'warn';
    txt = `已同步 · 待应用`;
  } else if (r && r.ok) {
    cls = 'ok';
    txt = `已同步 ${relTime(r.at)}`;
  } else if (r && !r.ok) {
    cls = 'bad';
    txt = '同步失败';
  }
  sync.title = r ? `${r.message || ''}（${fmtTime(r.at)}）` : '自动同步状态';
  sync.className = 'tb-chip ' + cls;
  sync.querySelector('.txt').textContent = txt;

  const en = entryRows().filter((x) => x.enabled).length;
  $('#sideEnabled').textContent = en;
  $('#sideTotal').textContent = entryRows().length;
  $('#sideVer').textContent = 'v' + (S.info?.system?.appVersion || '1.0.0');

  const badge = $('#navBadgeDirty');
  if (isDirty()) {
    badge.textContent = '•';
    badge.classList.add('show');
  } else badge.classList.remove('show');

  const sdot = $('#navSyncDot');
  if (r && !r.ok) {
    sdot.classList.add('show', 'bad');
  } else if (r && r.ok) {
    sdot.classList.add('show');
    sdot.classList.remove('bad');
  } else sdot.classList.remove('show');

  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === S.page));
}

/* ══════════════════════════════════════════════════════════════
   页面渲染
   ══════════════════════════════════════════════════════════════ */
function render() {
  ddClose(); // 整页重渲染会让触发按钮失效，弹层先收起，避免残留悬浮
  const view = $('#viewScroll');
  const y = view.scrollTop;
  const html =
    S.page === 'hosts'
      ? pageHosts()
      : S.page === 'speed'
      ? pageSpeed()
      : S.page === 'sync'
      ? pageSync()
      : pageSettings();
  view.innerHTML = html;
  view.scrollTop = y;
  renderChrome();
  afterRender();
}

/* ── Hosts 管理 ── */
function pageHosts() {
  const rows = visibleRows();
  const ent = entryRows();
  const dirty = isDirty();
  const rawCount = S.rows.filter((r) => r.kind === 'raw').length;

  const list = rows.length
    ? rows.map(rowHosts).join('')
    : `<div class="empty">${ICON.empty}<div class="t">没有匹配的条目</div><div class="d">换个关键词或筛选条件试试，也可以点右上角「新增条目」手动添加。</div></div>`;

  const privBanner = S.canWrite
    ? ''
    : `<div class="banner warn">${ICON.warn}<div class="bt"><b>写入 hosts 需要管理员权限。</b>
        读取与编辑不受影响；点击「应用更改」时会弹出 UAC 授权窗口，授权后由系统完成写入。
        <div class="acts"><button class="btn sm" data-act="recheck">重新检测权限</button></div></div></div>`;

  return `<div class="page">
    <div class="toolbar">
      <div class="tb-title"><h1>Hosts 管理</h1>
        <span class="tb-count">共 ${ent.length} 条 · 启用 ${ent.filter((r) => r.enabled).length} 条</span>
      </div>
      <div class="spacer"></div>
      <div class="search">${ICON.search}<input class="input" id="q" placeholder="搜索 IP / 域名 / 备注" value="${esc(S.q)}"></div>
      ${ddHtml(
        'filter',
        S.filter,
        [
          ['all', '全部'],
          ['enabled', '已启用'],
          ['disabled', '已禁用'],
          ['managed', 'GitHub520'],
          ['user', '我的条目'],
        ],
        118
      )}
      <button class="btn ghost" data-act="backup" title="把当前系统 hosts 文件备份一份">${ICON.save}备份</button>
      <button class="btn ghost" data-act="reload" title="从系统 hosts 文件重新读取">${ICON.reload}重载</button>
      <button class="btn primary" data-act="add">${ICON.add}新增条目</button>
    </div>
    <div class="page-body">
      ${privBanner}
      <div class="card">
        <div class="card-head">
          <h2>条目列表</h2>
          <span class="sub">${rows.length} / ${S.rows.length} 行显示</span>
          <div class="spacer"></div>
          ${
            dirty
              ? `<span class="tag warn">${ent.filter((r) => r.enabled).length} 项待应用</span>
                 <button class="btn sm ghost" data-act="discard">${ICON.undo}放弃</button>
                 <button class="btn sm primary" data-act="apply">${ICON.save}应用更改</button>`
              : `<span class="tag ok">已与系统一致</span>`
          }
          <button class="btn sm ghost" data-act="toggle-raw">${
            S.showRaw ? '隐藏注释行' : `显示注释行 (${rawCount})`
          }</button>
          <button class="btn sm ghost" data-act="all-on">全部启用</button>
          <button class="btn sm ghost" data-act="all-off">全部禁用</button>
        </div>
        <div class="list">${list}</div>
      </div>
      <div class="banner info">${ICON.info}<div class="bt">
        文件位置 <span class="mono">${esc(S.hostsPath)}</span> · 每次应用前会自动备份到程序数据目录（保留最近 20 份）。
        「GitHub520」区块由自动同步维护，手写条目不会被改动。禁用的条目会写成
        <span class="mono"># [off]</span> 注释行；其它软件写入的普通注释原样保留，不会被动。</div></div>
    </div>
  </div>`;
}

function rowHosts(r) {
  if (r.kind === 'raw') {
    let k = '注释';
    const t = r.text.trim();
    if (!t) k = '空行';
    else if (t.startsWith('# >>>')) k = '区块';
    else if (t.startsWith('# <<<')) k = '区块';
    return `<div class="crow"><span class="k">${k}</span><span class="txt">${esc(r.text) || '&nbsp;'}</span></div>`;
  }
  const lat = S.rowLat[r.id];
  let latHtml = '';
  if (lat && lat.pending) latHtml = `<span class="lat muted">测速中…</span>`;
  else if (lat && lat.ok) latHtml = `<span class="lat ${latClass(lat.latency)}">${lat.latency} ms</span>`;
  else if (lat && !lat.ok) latHtml = `<span class="lat bad">超时</span>`;

  return `<div class="erow ${r.enabled ? '' : 'off'}" data-id="${r.id}">
    <button class="switch ${r.enabled ? 'on' : ''}" data-act="toggle" data-id="${r.id}" title="${
    r.enabled ? '点击禁用' : '点击启用'
  }"></button>
    <span class="ip" title="${esc(r.ip)}">${esc(r.ip)}</span>
    <span class="hosts" title="${esc(r.hosts.join(' '))}">${esc(r.hosts.join(' '))}</span>
    ${latHtml}
    <span class="tags">
      ${r.managed ? '<span class="tag accent">GitHub520</span>' : ''}
      ${r.comment && !r.managed ? `<span class="tag ghost">${esc(r.comment)}</span>` : ''}
      ${!r.enabled ? '<span class="tag">已禁用</span>' : ''}
    </span>
    <span class="acts">
      <button class="btn icon" data-act="row-speed" data-id="${r.id}" title="测速">${ICON.bolt}</button>
      <button class="btn icon" data-act="edit" data-id="${r.id}" title="编辑">${ICON.edit}</button>
      <button class="btn icon danger" data-act="del" data-id="${r.id}" title="删除">${ICON.trash}</button>
    </span>
  </div>`;
}

/* ── 延迟测速 ── */
function pageSpeed() {
  const rs = S.speed.results;
  const okList = rs.filter((r) => r.ok);
  const fastest = okList[0];
  const avg = okList.length ? okList.reduce((a, b) => a + b.latency, 0) / okList.length : null;
  const fail = rs.filter((r) => !r.ok).length;
  const pct = S.speed.total ? Math.round((S.speed.done / S.speed.total) * 100) : 0;
  const maxLat = Math.max(200, ...okList.map((r) => r.latency));

  const list = rs.length
    ? rs.map((r) => rowSpeed(r, maxLat)).join('')
    : `<div class="empty">${ICON.bolt}<div class="t">还没有测速结果</div>
        <div class="d">选择测速范围后点击「开始测速」。程序会与目标 IP 的 443 端口建立 TCP 连接并采样 3 次取中位数，无需管理员权限。</div></div>`;

  return `<div class="page">
    <div class="toolbar">
      <div class="tb-title"><h1>延迟测速</h1><span class="tb-count">TCP 443 建连耗时 · 中位数</span></div>
      <div class="spacer"></div>
      ${ddHtml(
        'scope',
        S.speed.scope,
        [
          ['enabled', '仅已启用条目'],
          ['all', '全部条目'],
          ['managed', '仅 GitHub520'],
          ['user', '仅我的条目'],
        ],
        136
      )}
      ${ddHtml(
        'samples',
        S.speed.samples,
        [
          ['1', '1 次采样'],
          ['3', '3 次采样'],
          ['5', '5 次采样'],
        ],
        112
      )}
      <button class="btn primary" data-act="run-speed" ${S.speed.running ? 'disabled' : ''}>${
    ICON.bolt
  }${S.speed.running ? '测速中…' : '开始测速'}</button>
    </div>
    <div class="page-body">
      <div class="stats">
        ${statCard({
          k: '最快',
          n: fastest ? fastest.latency : '—',
          u: 'ms',
          note: fastest ? fastest.host : '等待测速',
          noteMono: true,
        })}
        ${statCard({
          k: '平均延迟',
          n: avg != null ? avg.toFixed(1) : '—',
          u: 'ms',
          note: okList.length ? `基于 ${okList.length} 个可达目标` : '等待测速',
        })}
        ${statCard({
          k: '不可达',
          n: fail,
          u: '个',
          note: rs.length ? `共测 ${rs.length} 个目标` : '等待测速',
          tone: rs.length ? (fail ? 'bad' : 'ok') : '',
          dot: rs.length > 0,
        })}
        ${statCard({
          k: '进度',
          n: S.speed.done,
          u: `/ ${S.speed.total || 0}`,
          bar: pct,
        })}
      </div>
      <div class="card">
        <div class="card-head"><h2>测速结果</h2><span class="sub">按延迟升序 · 越快越靠前</span>
          <div class="spacer"></div>
          <button class="btn sm ghost" data-act="clear-speed">清空结果</button>
        </div>
        <div class="list">${list}</div>
      </div>
    </div>
  </div>`;
}

function rowSpeed(r, maxLat) {
  const cls = r.ok ? latClass(r.latency) : 'bad';
  const w = r.ok ? Math.max(4, Math.min(100, (r.latency / maxLat) * 100)) : 100;
  return `<div class="erow">
    <span class="hosts" title="${esc(r.host)}">${esc(r.host)}</span>
    <span class="ip" title="${esc(r.ip)}">${esc(r.ip)}</span>
    <span class="lbar ${cls === 'ok' ? '' : cls}"><i style="width:${w}%"></i></span>
    <span class="lat ${cls}">${r.ok ? r.latency + ' ms' : '不可达'}</span>
    <span class="tags">${
      r.ok
        ? `<span class="tag ${cls === 'ok' ? 'ok' : cls === 'mid' ? 'warn' : 'bad'}">${
            cls === 'ok' ? '优秀' : cls === 'mid' ? '一般' : '较慢'
          }</span>`
        : `<span class="tag bad" title="${esc(r.error || '')}">${esc(r.error || '不可达')}</span>`
    }</span>
  </div>`;
}

/* ── 自动同步 ── */
function pageSync() {
  const r = S.sync.lastResult;
  const cfg = S.info?.config || {};
  const hours = Number(cfg.syncIntervalHours) || 6;
  const nextAt = cfg.lastSyncAt ? cfg.lastSyncAt + hours * 3600 * 1000 : null;
  const nextP = !cfg.autoSync
    ? { n: '已关闭', u: '' }
    : countdownParts(nextAt ? nextAt - Date.now() : 0);

  const logHtml = S.sync.log.length
    ? S.sync.log
        .slice(0, 60)
        .map(
          (l) =>
            `<div class="log-row ${l.type}"><span class="t">${fmtTime(l.at)}</span><span class="m">${esc(
              l.msg
            )}</span></div>`
        )
        .join('')
    : `<div class="log-row"><span class="m muted">暂无日志，点「立即同步」试一次。</span></div>`;

  return `<div class="page">
    <div class="toolbar">
      <div class="tb-title"><h1>自动同步</h1><span class="tb-count">从远端拉取最新 GitHub IP 并写入 hosts</span></div>
      <div class="spacer"></div>
      <button class="btn primary" data-act="sync-now" ${S.sync.running ? 'disabled' : ''}>${
    ICON.reload
  }${S.sync.running ? '同步中…' : '立即同步'}</button>
    </div>
    <div class="page-body">
      ${
        r && !r.ok
          ? `<div class="banner bad">${ICON.bad}<div class="bt"><b>上次同步失败。</b>${esc(
              r.message
            )}<div class="acts"><button class="btn sm" data-act="sync-now">重试</button>
            <button class="btn sm ghost" data-act="open-sync-cfg">检查同步源</button></div></div></div>`
          : ''
      }
      <div class="stats">
        ${statCard({
          k: '同步状态',
          n: S.sync.running ? '同步中' : r ? (r.ok ? '正常' : '失败') : '尚未同步',
          u: '',
          note: r ? r.message : '本次启动后还未同步',
          tone: S.sync.running ? 'busy' : !r ? '' : r.ok ? 'ok' : 'bad',
          dot: true,
        })}
        ${statCard({
          k: '上次同步',
          n: r ? relParts(r.at).n : '—',
          u: r ? relParts(r.at).u : '',
          note: r ? fmtTime(r.at) : '从未执行',
          noteMono: !!r,
        })}
        ${statCard({
          k: '下次自动同步',
          n: nextP.n,
          u: nextP.u,
          vid: 'nextSync',
          note: cfg.autoSync ? `每 ${hours} 小时一次` : '自动同步已关闭',
        })}
        ${statCard({
          k: '托管条目',
          n: entryRows().filter((x) => x.managed).length,
          u: '条',
          note: '位于 GitHub520 区块',
        })}
      </div>

      <div class="card">
        <div class="card-head"><h2>同步设置</h2><span class="sub">改动即时生效</span></div>
        <div class="setting">
          <div class="meta"><div class="t">开启自动同步</div>
            <div class="d">按下方间隔在后台自动拉取并更新 hosts，程序最小化到托盘时同样生效。</div></div>
          <div class="ctl"><button class="switch ${cfg.autoSync ? 'on' : ''}" data-act="cfg-toggle" data-key="autoSync"></button></div>
        </div>
        <div class="setting">
          <div class="meta"><div class="t">同步间隔</div><div class="d">间隔越短越及时，网络请求也越频繁。</div></div>
          <div class="ctl">
            ${ddHtml('interval', hours, [1, 3, 6, 12, 24].map((h) => [h, `每 ${h} 小时`]), 132)}
          </div>
        </div>
        <div class="setting">
          <div class="meta"><div class="t">同步后自动写入 hosts</div>
            <div class="d">关闭后仅在后台更新配置，需在「Hosts 管理」中手动应用（写入可能需要管理员权限）。</div></div>
          <div class="ctl"><button class="switch ${
            cfg.autoApplyOnSync ? 'on' : ''
          }" data-act="cfg-toggle" data-key="autoApplyOnSync"></button></div>
        </div>
        <div class="setting">
          <div class="meta"><div class="t">同步源地址</div>
            <div class="d">默认使用 hellogithub 官方源；失败时会自动回退到 jsDelivr 与 GitHub Raw 镜像。</div></div>
          <div class="ctl" style="width:340px">
            <input class="input mono grow" id="syncUrl" value="${esc(cfg.syncUrl || '')}" spellcheck="false">
            <button class="btn sm" data-act="save-sync-url">保存</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>同步日志</h2><span class="sub">本次运行期间</span>
          <div class="spacer"></div>
          <button class="btn sm ghost" data-act="clear-log">清空</button></div>
        <div class="log">${logHtml}</div>
      </div>

      <div class="banner info">${ICON.info}<div class="bt">
        同步只重建 hosts 文件中 <span class="mono"># &gt;&gt;&gt; GitHub520 managed</span> 与
        <span class="mono"># &lt;&lt;&lt; GitHub520 managed</span> 之间的区块，你手写的条目和其它注释都会原样保留。
        若某个域名你已在列表中手动禁用，同步后仍会保持禁用。</div></div>
    </div>
  </div>`;
}

/* ── 设置 ── */
function pageSettings() {
  const sys = S.info?.system || {};
  const cfg = S.info?.config || {};
  const auto = !!S.info?.autostart;

  return `<div class="page">
    <div class="toolbar">
      <div class="tb-title"><h1>设置</h1><span class="tb-count">启动项与运行参数</span></div>
      <div class="spacer"></div>
    </div>
    <div class="page-body">
      <div class="card">
        <div class="card-head"><h2>启动</h2></div>
        <div class="setting">
          <div class="meta"><div class="t">开机自动运行</div>
            <div class="d">随系统启动自动运行，后台按设定间隔同步 hosts 配置。</div></div>
          <div class="ctl">
            <span class="tag ${auto ? 'ok' : 'ghost'}" id="autoState">${auto ? '已开启' : '已关闭'}</span>
            <button class="switch ${auto ? 'on' : ''}" data-act="toggle-autostart"></button>
          </div>
        </div>
        <div class="setting">
          <div class="meta"><div class="t">启动时最小化到托盘</div>
            <div class="d">开机自启时不弹出主窗口，仅保留托盘图标与后台同步。</div></div>
          <div class="ctl"><button class="switch ${
            cfg.startMinimized ? 'on' : ''
          }" data-act="cfg-toggle" data-key="startMinimized"></button></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>hosts 文件</h2></div>
        <div class="setting">
          <div class="meta"><div class="t">系统 hosts 路径</div><div class="d">${esc(S.hostsPath)}</div></div>
          <div class="ctl">
            <span class="tag ${S.canWrite ? 'ok' : 'warn'}">${S.canWrite ? '可写入' : '需提权'}</span>
            <button class="btn sm" data-act="recheck">重新检测</button>
          </div>
        </div>
        <div class="setting">
          <div class="meta"><div class="t">备份目录</div>
            <div class="d">${esc(S.info?.userData || '')}${esc('\\backups')} · 最多保留 20 份</div></div>
          <div class="ctl">
            <button class="btn sm" data-act="backup">立即备份</button>
            <button class="btn sm ghost" data-act="open-backup">打开目录</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>测速</h2></div>
        <div class="setting">
          <div class="meta"><div class="t">并发数</div><div class="d">同时进行的测速连接数，过大可能被目标限流。</div></div>
          <div class="ctl">
            ${ddHtml('conc', cfg.speedConcurrency || 8, [4, 8, 12, 16].map((n) => [n, String(n)]), 72)}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>关于</h2></div>
        <div class="card-body">
          <dl class="kv">
            <dt>应用版本</dt><dd>v${esc(sys.appVersion || '')}</dd>
            <dt>运行环境</dt><dd>${esc(sys.webview ? `Tauri · WebView2 ${sys.webview}` : `Electron ${sys.electron || ''} · Node ${sys.node || ''}`)}</dd>
            <dt>系统</dt><dd>${esc((sys.platform || '') + ' ' + (sys.arch || '') + ' · ' + (sys.release || ''))}</dd>
            <dt>运行模式</dt><dd>${sys.packaged ? '已打包' : '开发模式'}</dd>
            <dt>数据来源</dt><dd>521xueweihan/GitHub520</dd>
          </dl>
        </div>
        <div class="setting">
          <div class="meta"><div class="t">退出应用</div><div class="d">完全退出后台进程（关闭窗口只会最小化到托盘）。</div></div>
          <div class="ctl"><button class="btn danger" data-act="quit">退出</button></div>
        </div>
      </div>
    </div>
  </div>`;
}

/* ══════════════════════════════════════════════════════════════
   渲染后处理
   ══════════════════════════════════════════════════════════════ */
let countdownTimer = null;
function afterRender() {
  if (countdownTimer) clearInterval(countdownTimer);
  const nextEl = document.getElementById('nextSync');
  if (nextEl) {
    const cfg = S.info?.config || {};
    const hours = Number(cfg.syncIntervalHours) || 6;
    const tick = () => {
      const el = document.getElementById('nextSync');
      if (!el) return;
      if (!cfg.autoSync) {
        el.textContent = '已关闭';
        return;
      }
      const last = cfg.lastSyncAt || 0;
      const left = last ? last + hours * 3600 * 1000 - Date.now() : 0;
      // 保留 <span>数字</span><small>单位</small> 的双字号结构
      const p = countdownParts(left);
      el.textContent = '';
      const num = document.createElement('span');
      num.textContent = p.n;
      el.appendChild(num);
      if (p.u) {
        const unit = document.createElement('small');
        unit.textContent = p.u;
        el.appendChild(unit);
      }
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }
}

/* ══════════════════════════════════════════════════════════════
   交互
   ══════════════════════════════════════════════════════════════ */
async function loadHosts() {
  const res = await window.api.hosts.read();
  S.hostsPath = res.path;
  S.rows = res.rows;
  S.baseline = clone(res.rows);
  S.rowLat = {};
  return res;
}

async function refreshInfo() {
  const info = await window.api.info();
  S.info = info;
  S.canWrite = info.canWrite;
  if (!S.sync.lastResult && info.config.lastSyncResult) {
    S.sync.lastResult = info.config.lastSyncResult;
  }
  return info;
}

async function boot() {
  await refreshInfo();
  await loadHosts();
  const state = await window.api.win.state();
  document.body.classList.toggle('maximized', !!state.maximized);
  document.body.classList.toggle('focused', !!state.focused);
  syncLog('info', `已读取 ${entryRows().length} 条 hosts 条目`);
  if (!S.canWrite) syncLog('warn', '当前没有 hosts 写入权限，应用更改时会请求提权');
  render();
}

/* ── 应用更改 ── */
async function applyChanges() {
  const rows = S.rows;
  let res = await window.api.hosts.write(rows);
  if (res.needAdmin) {
    const go = await window.api.dialog.confirm({
      title: '需要管理员权限',
      message: '写入系统 hosts 文件需要管理员权限',
      detail: '点击「确定」后会弹出 UAC 授权窗口；授权完成后程序会自动完成写入。',
    });
    if (!go) {
      toast('warn', '已取消', '配置未写入系统 hosts');
      return false;
    }
    res = await window.api.hosts.writeAdmin(rows);
  }
  if (!res.ok) {
    toast('bad', '写入失败', res.message || '未知错误');
    syncLog('bad', `写入 hosts 失败：${res.message || '未知错误'}`);
    return false;
  }
  await loadHosts();
  S.canWrite = true;
  toast('ok', '已应用', `hosts 文件已更新（${entryRows().filter((r) => r.enabled).length} 条生效）`);
  syncLog('ok', '已将配置写入系统 hosts 文件');
  render();
  return true;
}

/* ── 测速 ── */
function pickTargets() {
  let list = entryRows();
  if (S.speed.scope === 'enabled') list = list.filter((r) => r.enabled);
  else if (S.speed.scope === 'managed') list = list.filter((r) => r.managed);
  else if (S.speed.scope === 'user') list = list.filter((r) => !r.managed);
  // 同一 IP 去重（很多 GitHub 域名共用 IP），保留第一个域名
  const seen = new Set();
  const out = [];
  for (const r of list) {
    if (seen.has(r.ip)) continue;
    seen.add(r.ip);
    out.push({ id: r.id, ip: r.ip, host: r.hosts[0], target: r.ip });
  }
  return out;
}

async function runSpeed() {
  const items = pickTargets();
  if (!items.length) {
    toast('warn', '没有可测速的目标', '请先添加条目或调整测速范围');
    return;
  }
  S.speed.running = true;
  S.speed.results = [];
  S.speed.done = 0;
  S.speed.total = items.length;
  render();
  const started = Date.now();
  syncLog('info', `开始测速：${items.length} 个目标，${S.speed.samples} 次采样`);

  try {
    const res = await window.api.speed.run(items, { samples: Number(S.speed.samples) });
    S.speed.results = res;
    S.speed.running = false;
    S.speed.done = items.length;
    const okList = res.filter((r) => r.ok);
    const fastest = okList[0];
    const fail = res.filter((r) => !r.ok).length;
    syncLog(
      fastest ? 'ok' : 'warn',
      `测速完成（${((Date.now() - started) / 1000).toFixed(1)}s）：最快 ${
        fastest ? `${fastest.host} ${fastest.latency}ms` : '无'
      }${fail ? `，${fail} 个不可达` : ''}`
    );
    toast(
      fastest ? 'ok' : 'warn',
      '测速完成',
      fastest ? `最快 ${fastest.host} · ${fastest.latency} ms` : '所有目标均不可达'
    );
  } catch (err) {
    S.speed.running = false;
    syncLog('bad', `测速异常：${err.message}`);
    toast('bad', '测速失败', err.message);
  }
  render();
}

async function speedOne(id) {
  const r = S.rows.find((x) => x.id === id);
  if (!r) return;
  S.rowLat[id] = { pending: true };
  render();
  try {
    const res = await window.api.speed.one(r.ip, { samples: 3 });
    S.rowLat[id] = res;
  } catch (err) {
    S.rowLat[id] = { ok: false, error: err.message };
  }
  render();
}

/* ── 同步 ── */
async function runSync(manual = true) {
  S.sync.running = true;
  renderChrome();
  const btn = $('[data-act="sync-now"]');
  if (btn) btn.disabled = true;
  syncLog('info', manual ? '手动触发同步…' : '自动同步触发…');
  try {
    const res = await window.api.sync.run({});
    S.sync.running = false;
    S.sync.lastResult = res;
    syncLog(res.ok ? (res.needAdmin ? 'warn' : 'ok') : 'bad', res.message);
    if (res.ok) {
      await refreshInfo();
      await loadHosts();
      toast(
        res.needAdmin ? 'warn' : 'ok',
        res.needAdmin ? '同步完成，待手动应用' : '同步完成',
        res.message
      );
    } else {
      toast('bad', '同步失败', res.message);
    }
  } catch (err) {
    S.sync.running = false;
    syncLog('bad', `同步异常：${err.message}`);
    toast('bad', '同步失败', err.message);
  }
  render();
}

/* ── 条目编辑 ── */
function openModal(html) {
  ddClose(); // 有下拉开着时先收掉，避免两层浮层叠在一起
  const root = $('#modalRoot');
  $('#modal').innerHTML = html;
  root.hidden = false;
}
function closeModal() {
  $('#modalRoot').hidden = true;
  $('#modal').innerHTML = '';
}

function entryModal(entry) {
  const isNew = !entry;
  const e = entry || { ip: '', hosts: [], comment: '', enabled: true };
  openModal(`
    <div class="modal-head">
      <h3>${isNew ? '新增 hosts 条目' : '编辑 hosts 条目'}</h3>
      <p>${isNew ? '填写 IP 与主机名，保存后需点击「应用更改」才会写入系统文件。' : '修改后需点击「应用更改」才会写入系统文件。'}</p>
    </div>
    <div class="modal-body">
      <div class="field" id="f-ip">
        <label>IP 地址</label>
        <input class="input mono" id="m-ip" placeholder="例如 140.82.114.4" value="${esc(e.ip)}" spellcheck="false">
        <div class="err">请输入合法的 IPv4 或 IPv6 地址</div>
      </div>
      <div class="field" id="f-host">
        <label>主机名</label>
        <input class="input mono" id="m-host" placeholder="例如 github.com（多个用空格分隔）" value="${esc(
          e.hosts.join(' ')
        )}" spellcheck="false">
        <div class="hint">一行可绑定多个域名，用空格分隔。</div>
        <div class="err">请输入合法的主机名</div>
      </div>
      <div class="field">
        <label>备注</label>
        <input class="input" id="m-comment" placeholder="可选" value="${esc(e.comment || '')}">
      </div>
      <div class="setting" style="padding:0;border:0">
        <div class="meta"><div class="t">启用此条目</div><div class="d">禁用后该行会以 <span class="mono"># [off]</span> 前缀注释保留在 hosts 文件中，可随时重新启用。</div></div>
        <div class="ctl"><button class="switch ${e.enabled ? 'on' : ''}" id="m-enabled"></button></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn" data-close="1">取消</button>
      <button class="btn primary" id="m-save">${isNew ? '添加' : '保存'}</button>
    </div>
  `);

  const ipEl = $('#m-ip');
  const hostEl = $('#m-host');
  const enabledEl = $('#m-enabled');
  enabledEl.addEventListener('click', () => enabledEl.classList.toggle('on'));

  const validators = {
    ip: (v) => /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(v) || (v.includes(':') && /^[0-9A-Fa-f:.]+$/.test(v)),
    host: (v) => v.length > 0 && v.split(/\s+/).every((h) => /^[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?(\.[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?)*$/.test(h)),
  };

  const doSave = () => {
    const ip = ipEl.value.trim();
    const hosts = hostEl.value.trim().split(/\s+/).filter(Boolean);
    const okIp = validators.ip(ip);
    const okHost = validators.host(hosts.join(' '));
    $('#f-ip').classList.toggle('invalid', !okIp);
    $('#f-host').classList.toggle('invalid', !okHost);
    if (!okIp || !okHost) return;

    const enabled = enabledEl.classList.contains('on');
    const comment = $('#m-comment').value.trim();
    if (isNew) {
      S.rows.unshift({ kind: 'entry', id: uid(), ip, hosts, comment, enabled });
    } else {
      const target = S.rows.find((x) => x.id === entry.id);
      Object.assign(target, { ip, hosts, comment, enabled });
    }
    closeModal();
    render();
    toast('info', isNew ? '已添加条目' : '已修改条目', '点击「应用更改」写入系统 hosts');
  };

  $('#m-save').addEventListener('click', doSave);
  [ipEl, hostEl].forEach((el) =>
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') doSave();
    })
  );
  ipEl.focus();
}

/* ── 自绘下拉 ──
   原生 <select> 的弹出列表在 Windows 上由系统渲染，CSS 管不到；
   全部改为自绘：触发按钮复用 .select 外观，弹层挂 body（fixed 定位，
   不受卡片 overflow 裁剪），支持键盘导航与空间不足时向上翻转。 */
const DD_CHEV = '<svg class="dd-chev" viewBox="0 0 12 12"><path d="M3 4.8 6 7.8 9 4.8"/></svg>';
const DD_CK = '<svg class="ck" viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7"/></svg>';

/** 各下拉的定义：options() 返回 [value, label][]，value() 取当前值，change(v) 落选 */
const DDS = {
  filter: {
    options: () => [
      ['all', '全部'],
      ['enabled', '已启用'],
      ['disabled', '已禁用'],
      ['managed', 'GitHub520'],
      ['user', '我的条目'],
    ],
    value: () => S.filter,
    change: (v) => {
      S.filter = v;
      render();
    },
  },
  scope: {
    options: () => [
      ['enabled', '仅已启用条目'],
      ['all', '全部条目'],
      ['managed', '仅 GitHub520'],
      ['user', '仅我的条目'],
    ],
    value: () => S.speed.scope,
    change: (v) => {
      S.speed.scope = v;
      render();
    },
  },
  samples: {
    options: () => [
      ['1', '1 次采样'],
      ['3', '3 次采样'],
      ['5', '5 次采样'],
    ],
    value: () => S.speed.samples,
    change: (v) => {
      S.speed.samples = v;
      render();
    },
  },
  interval: {
    options: () => [1, 3, 6, 12, 24].map((h) => [h, `每 ${h} 小时`]),
    value: () => Number(S.info?.config?.syncIntervalHours) || 6,
    change: async (v) => {
      const cfg = await window.api.config.patch({ syncIntervalHours: Number(v) });
      S.info.config = cfg;
      syncLog('info', `自动同步间隔已设为每 ${v} 小时`);
      toast('ok', '已保存', `同步间隔：每 ${v} 小时`);
      render();
    },
  },
  conc: {
    options: () => [4, 8, 12, 16].map((n) => [n, String(n)]),
    value: () => S.info?.config?.speedConcurrency || 8,
    change: async (v) => {
      const cfg = await window.api.config.patch({ speedConcurrency: Number(v) });
      S.info.config = cfg;
      render();
    },
  },
};

/** 生成下拉触发按钮 HTML（替代原来的 <select>） */
function ddHtml(id, value, options, minWidth) {
  const cur = options.find((o) => String(o[0]) === String(value));
  return `<button type="button" class="select dd" data-dd="${esc(id)}" id="dd-${esc(id)}"${
    minWidth ? ` style="min-width:${minWidth}px"` : ''
  } aria-haspopup="listbox"><span>${esc(cur ? cur[1] : String(value))}</span>${DD_CHEV}</button>`;
}

let ddState = null; // { id, btn, pop, options, hl }

function ddClose() {
  if (!ddState) return;
  ddState.pop.remove();
  ddState.btn.classList.remove('open');
  ddState = null;
}

function ddHighlight() {
  if (!ddState) return;
  Array.from(ddState.pop.children).forEach((el, i) => el.classList.toggle('hl', i === ddState.hl));
  const el = ddState.pop.children[ddState.hl];
  if (el) el.scrollIntoView({ block: 'nearest' });
}

function ddOpen(btn) {
  ddClose();
  const def = DDS[btn.dataset.dd];
  if (!def) return;
  const options = def.options();
  const value = String(def.value());
  const pop = document.createElement('div');
  pop.className = 'dd-pop';
  pop.setAttribute('role', 'listbox');
  pop.innerHTML = options
    .map(
      ([v, t]) =>
        `<div class="dd-opt${String(v) === value ? ' sel' : ''}" role="option" data-v="${esc(
          v
        )}" aria-selected="${String(v) === value}">${DD_CK}<span>${esc(t)}</span></div>`
    )
    .join('');
  document.body.appendChild(pop);

  // 定位：优先向下；底部放不下向上翻；水平贴按钮左缘且不超出窗口
  const r = btn.getBoundingClientRect();
  const pw = Math.max(pop.offsetWidth, r.width);
  const ph = pop.offsetHeight;
  let x = Math.max(8, Math.min(r.left, window.innerWidth - pw - 8));
  let y = r.bottom + 6;
  if (y + ph > window.innerHeight - 8) y = Math.max(8, r.top - ph - 6);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  pop.style.minWidth = r.width + 'px';

  ddState = { id: btn.dataset.dd, btn, pop, options, hl: Math.max(0, options.findIndex(([v]) => String(v) === value)) };
  btn.classList.add('open');
  ddHighlight();
}

async function ddPick(v) {
  const st = ddState;
  if (!st) return;
  const def = DDS[st.id];
  ddClose();
  await def.change(v);
}

/* ── 窗口拖动 ──
   自己实现而不用 -webkit-app-region：拖拽区会吞掉浮层（下拉/模态框）的点击，
   且窗口 hide→show 后拖拽命中区可能失效。

   ⚠ 坐标必须用屏幕绝对坐标（screenX/screenY），不能用 clientX/clientY：
   窗口被移动后，同一个物理光标位置对应的 client 坐标会同步减小，
   而位移又是拿它和按下时的原点相减算的 —— 于是每一帧的位移都被窗口上一帧
   自己的移动量抵消掉，形成反馈环：窗口走一步、退半步，只能走到目标的一半，
   肉眼就是拖动时窗口来回抖、内容重影。
   屏幕坐标不受窗口移动影响，位移恒等于光标在屏幕上的真实位移，闭环消失。

   用 Pointer Events + setPointerCapture 而不是 window 上的 mousemove：
   快速拖动时光标会跑到窗口外，没有指针捕获就收不到事件，窗口会一卡一卡地掉队。 */
function bindWindowDrag() {
  const tb = $('#titlebar');
  tb.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // 标题栏上的按钮（最小化/最大化/关闭、状态胶囊）不触发拖动
    if (e.target.closest('button')) return;
    if (document.body.classList.contains('maximized')) return;
    /* 这里**不能** preventDefault：取消 pointerdown 会连带取消合成出来的
       click / dblclick（Chromium 由 pointerdown→pointerup 合成鼠标事件），
       标题栏双击最大化、以及挂在 document 上的"点空白处收起浮层"都会失效。
       原实现把 preventDefault 放在 mousedown 上没这个问题（mousedown 的默认行为
       只涉及焦点与选中），改用 pointer 事件后必须去掉。
       选中问题由全局 user-select:none 兜住，标题栏里也没有可拖拽的图片/链接。 */

    const pid = e.pointerId;
    // 捕获指针：光标移出窗口也持续收事件（合成事件没有真实指针，捕获会失败，忽略即可）
    try {
      tb.setPointerCapture(pid);
    } catch (_) {}

    /* 每帧最多发一次 IPC：高刷新率鼠标一秒能产生上百个 pointermove，
       逐个 IPC 会让主进程连续移动窗口，重绘跟不上就出残影。 */
    let raf = 0;
    let pending = null;
    const flush = () => {
      raf = 0;
      if (!pending) return;
      const p = pending;
      pending = null;
      window.api.win.dragMove(p.x, p.y);
    };

    window.api.win.dragStart(e.screenX, e.screenY);
    document.body.classList.add('dragging'); // 拖动中：关掉过渡动画，减轻重绘
    const onMove = (ev) => {
      if (ev.pointerId !== pid) return;
      pending = { x: ev.screenX, y: ev.screenY };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onUp = (ev) => {
      if (ev.pointerId !== pid) return;
      if (raf) cancelAnimationFrame(raf);
      // 补发最后一帧：松手太快时 rAF 可能还没跑。屏幕坐标不会因窗口移动而失真，
      // 补发的是真实松手位置，窗口不会停在倒数第二帧。
      flush();
      tb.removeEventListener('pointermove', onMove);
      tb.removeEventListener('pointerup', onUp);
      tb.removeEventListener('pointercancel', onUp);
      try {
        tb.releasePointerCapture(pid);
      } catch (_) {}
      document.body.classList.remove('dragging');
      window.api.win.dragEnd();
    };
    tb.addEventListener('pointermove', onMove);
    tb.addEventListener('pointerup', onUp);
    tb.addEventListener('pointercancel', onUp);
  });
}

/* ── 事件委托 ── */
function bindEvents() {
  bindWindowDrag();
  // 侧栏
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item');
    if (!btn) return;
    S.page = btn.dataset.page;
    render();
  });

  // 窗口按钮
  $('#btnMin').addEventListener('click', () => window.api.win.minimize());
  $('#btnMax').addEventListener('click', () => window.api.win.toggleMax());
  // 标题栏按钮悬停高亮改为 JS 驱动：窗口隐藏期间没有 mousemove 事件，
  // 若用 CSS :hover 会在下次唤起时残留“选中态”（如右上角关闭按钮发红）
  document.addEventListener('mousemove', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('.win-btn') : null;
    $$('.win-btn.is-hover').forEach((b) => {
      if (b !== t) b.classList.remove('is-hover');
    });
    if (t && !t.classList.contains('is-hover')) t.classList.add('is-hover');
  });

  $('#btnClose').addEventListener('click', () => window.api.win.close());
  $('#titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    window.api.win.toggleMax();
  });

  // 滚动 → 顶部浮层
  $('#viewScroll').addEventListener('scroll', () => {
    const el = $('#viewScroll');
    $('#app').classList.toggle('scrolled', el.scrollTop > 2);
  });

  // 搜索框（输入不整页重渲染，只重绘列表）
  $('#viewScroll').addEventListener('input', (e) => {
    if (e.target.id === 'q') {
      S.q = e.target.value;
      preserveFocus(() => render());
    }
  });

  // 自绘下拉：点击触发/选择/关闭（弹层挂在 body 上，委托必须放 document）
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-dd]');
    if (trigger) {
      if (ddState && ddState.btn === trigger) ddClose();
      else ddOpen(trigger);
      return;
    }
    if (!ddState) return;
    const opt = e.target.closest('.dd-opt');
    if (opt && ddState.pop.contains(opt)) {
      ddPick(opt.dataset.v);
      return;
    }
    if (!ddState.pop.contains(e.target)) ddClose();
  });

  // 自绘下拉：键盘操作（↑↓ 移动高亮，Enter 选择，Esc/Tab 关闭；聚焦触发按钮时可直接展开）
  document.addEventListener('keydown', (e) => {
    if (ddState) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        ddState.hl = Math.min(ddState.options.length - 1, ddState.hl + 1);
        ddHighlight();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        ddState.hl = Math.max(0, ddState.hl - 1);
        ddHighlight();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        ddPick(ddState.options[ddState.hl][0]);
        return;
      }
      if (e.key === 'Escape' || e.key === 'Tab') {
        ddClose();
        return;
      }
      return;
    }
    const ae = document.activeElement;
    if (ae && ae.classList && ae.classList.contains('dd')) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        ddOpen(ae);
      }
    }
  });

  // 按钮
  $('#viewScroll').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const id = btn.dataset.id;

    switch (act) {
      case 'toggle': {
        const row = S.rows.find((r) => r.id === id);
        if (row) row.enabled = !row.enabled;
        render();
        break;
      }
      case 'edit': {
        const row = S.rows.find((r) => r.id === id);
        if (row) entryModal(row);
        break;
      }
      case 'del': {
        const row = S.rows.find((r) => r.id === id);
        const go = await window.api.dialog.confirm({
          title: '删除条目',
          message: `确定删除 ${row.hosts.join(', ')} 吗？`,
          detail: '该操作会从 hosts 列表中移除这一行，点击「应用更改」后从系统文件删除。',
        });
        if (go) {
          S.rows = S.rows.filter((r) => r.id !== id);
          render();
          toast('info', '已删除', '点击「应用更改」写入系统 hosts');
        }
        break;
      }
      case 'row-speed':
        speedOne(id);
        break;
      case 'add':
        entryModal(null);
        break;
      case 'apply':
        applyChanges();
        break;
      case 'discard':
        S.rows = clone(S.baseline);
        render();
        toast('info', '已放弃更改', '列表已恢复为系统 hosts 的内容');
        break;
      case 'reload': {
        if (isDirty()) {
          const go = await window.api.dialog.confirm({
            title: '放弃未应用的更改？',
            message: '重新加载会用系统 hosts 文件的内容覆盖当前列表',
            detail: '你尚未点击「应用更改」，未保存的修改会丢失。',
          });
          if (!go) return;
        }
        await loadHosts();
        render();
        toast('ok', '已重新加载', `${entryRows().length} 条条目`);
        break;
      }
      case 'toggle-raw':
        S.showRaw = !S.showRaw;
        render();
        break;
      case 'all-on':
      case 'all-off': {
        const on = act === 'all-on';
        const ids = new Set(visibleRows().filter((r) => r.kind === 'entry').map((r) => r.id));
        S.rows.forEach((r) => {
          if (ids.has(r.id)) r.enabled = on;
        });
        render();
        break;
      }
      case 'backup': {
        const res = await window.api.hosts.backup();
        if (res.ok) {
          toast('ok', '已备份', res.path);
          syncLog('info', `已备份 hosts → ${res.path}`);
        } else toast('bad', '备份失败', res.message);
        break;
      }
      case 'recheck': {
        await refreshInfo();
        render();
        toast(S.canWrite ? 'ok' : 'warn', S.canWrite ? '具备写入权限' : '需要管理员权限');
        break;
      }
      case 'run-speed':
        runSpeed();
        break;
      case 'clear-speed':
        S.speed.results = [];
        S.speed.done = 0;
        S.speed.total = 0;
        render();
        break;
      case 'sync-now':
        runSync(true);
        break;
      case 'open-sync-cfg': {
        S.page = 'sync';
        render();
        break;
      }
      case 'clear-log':
        S.sync.log = [];
        render();
        break;
      case 'save-sync-url': {
        const v = $('#syncUrl').value.trim();
        if (!/^https?:\/\//i.test(v)) {
          toast('warn', '地址无效', '请输入以 http(s):// 开头的地址');
          return;
        }
        const cfg = await window.api.config.patch({ syncUrl: v });
        S.info.config = cfg;
        toast('ok', '已保存', '同步源已更新');
        break;
      }
      case 'cfg-toggle': {
        const key = btn.dataset.key;
        const next = !btn.classList.contains('on');
        const cfg = await window.api.config.patch({ [key]: next });
        S.info.config = cfg;
        btn.classList.toggle('on', next);
        if (key === 'autoSync') render();
        break;
      }
      case 'toggle-autostart': {
        const next = !btn.classList.contains('on');
        const res = await window.api.autostart.set(next);
        S.info.autostart = res.enabled;
        btn.classList.toggle('on', res.enabled);
        $('#autoState').textContent = res.enabled ? '已开启' : '已关闭';
        $('#autoState').className = 'tag ' + (res.enabled ? 'ok' : 'ghost');
        if (res.ok === false) toast('bad', '设置失败', res.message || '');
        else toast('ok', res.enabled ? '已开启开机自启' : '已关闭开机自启');
        break;
      }
      case 'open-backup':
        await window.api.shell.open(S.info.userData + '\\backups');
        break;
      case 'quit': {
        const go = await window.api.dialog.confirm({
          title: '退出 GitHub520',
          message: '确定要退出应用吗？',
          detail: '退出后自动同步将停止；下次开机需手动启动（除非已开启开机自启）。',
        });
        if (go) window.api.quit();
        break;
      }
    }
  });

  // 模态框
  $('#modalRoot').addEventListener('click', (e) => {
    if (e.target.dataset.close) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#modalRoot').hidden) closeModal();
    if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) {
      e.preventDefault();
      loadHosts().then(render);
    }
  });

  // 主进程事件
  window.api.on('win:state', (s) => document.body.classList.toggle('maximized', !!s.maximized));
  window.api.on('win:focus', (s) => {
    document.body.classList.toggle('focused', !!s.focused);
    if (!s.focused) ddClose(); // 失焦时收起下拉，避免回到窗口时残留一个旧弹层
  });
  // 关闭到托盘：收起下拉与模态框，下次显示窗口时界面是干净的
  window.api.on('win:hidden', () => {
    ddClose();
    if (!$('#modalRoot').hidden) closeModal();
  });
  window.api.on('speed:progress', ({ row, prog }) => {
    S.speed.done = prog.finished;
    S.speed.total = prog.total;
    const idx = S.speed.results.findIndex((r) => r.id === row.id);
    if (idx >= 0) S.speed.results[idx] = row;
    else S.speed.results.push(row);
    if (S.page === 'speed') preserveFocus(() => render());
  });
  window.api.on('sync:result', (res) => {
    S.sync.lastResult = res;
    if (S.page === 'sync') render();
    else renderChrome();
  });
  window.api.on('hosts:external-change', async () => {
    if (isDirty()) {
      toast('warn', 'hosts 文件被外部修改', '当前有未应用的更改，已忽略外部变更');
      return;
    }
    await loadHosts();
    render();
    toast('info', 'hosts 文件已更新', '检测到外部修改，已重新加载');
    syncLog('info', '检测到 hosts 文件被外部程序修改，已重新加载');
  });
}

/* ── 启动 ── */
bindEvents();
boot();

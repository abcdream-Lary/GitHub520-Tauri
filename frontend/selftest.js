// 自检断言：由 Rust 的 app_info 下发 selftest 标记触发（--selftest 启动时执行）
// 以普通页面脚本运行，不依赖 eval 注入
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const raw = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const log = (m) => raw('selftest_log', { msg: String(m) }).catch(() => {});
  const out = [];
  const ok = (name, cond, extra) =>
    out.push({ name, pass: !!cond, extra: extra === undefined ? '' : String(extra) });
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  // 回传通道活性诊断：Rust 每 3 秒发一次 diag:tick
  let tickN = -1;
  try {
    window.api.on('diag:tick', (p) => {
      tickN = p && typeof p === 'object' ? p.n : -2;
      log('DIAG_TICK n=' + tickN);
    });
  } catch (e) {
    log('TICK_LISTEN_FAILED ' + ((e && e.message) || String(e)));
  }

  let info;
  log('SELFTEST_INFO_BEGIN');
  try {
    info = await Promise.race([
      window.api.info(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('APP_INFO_TIMEOUT_8S')), 8000)),
    ]);
  } catch (e) {
    log('APP_INFO_FAILED ' + ((e && e.message) || String(e)) + ' TICKS=' + tickN);
    return;
  }
  log('SELFTEST_INFO_OK selftest=' + !!(info && info.selftest));
  if (!info || !info.selftest) return; // 正常启动：不跑断言
  log('SELFTEST_START');
  await sleep(2000); // 等 app.js 的 boot() 完成

  try {
    ok('桥接可用：app_info 返回配置', !!info.config, Object.keys(info.config || {}).length + ' 个配置项');
    ok('hosts 路径已返回', !!info.hostsPath, info.hostsPath);

    const h = await window.api.hosts.read();
    ok('hosts 读取成功且有内容', !!(h && h.rows && h.rows.length), (h.rows || []).length + ' 行');

    ok('页面骨架完整（4 个导航项）', $$('.nav-item').length === 4, $$('.nav-item').length + ' 个');
    ok('hosts 列表已渲染', $$('.erow').length > 0, $$('.erow').length + ' 行');
    ok('侧栏统计已更新', (($('#sideTotal') || {}).textContent || '') !== '–', $('#sideTotal').textContent);

    for (const p of ['sync', 'speed', 'settings', 'hosts']) {
      $(`.nav-item[data-page="${p}"]`).click();
      await sleep(320);
      const act = $('.nav-item.active');
      ok('可切换到「' + p + '」页', !!act && act.dataset.page === p, act && act.dataset.page);
    }

    const rows = $$('.erow').length;
    const sw = $$('.erow .switch')[0];
    if (sw) {
      const before = sw.classList.contains('on');
      sw.click();
      await sleep(260);
      const nowOn = $$('.erow .switch')[0].classList.contains('on');
      ok('启用开关可切换', before !== nowOn, before + ' → ' + nowOn);
      $$('.erow .switch')[0].click();
      await sleep(220);
    } else {
      ok('存在启用开关', false, '未找到 .erow .switch');
    }
    ok('切换后列表行数稳定', $$('.erow').length === rows, $$('.erow').length + '/' + rows + ' 行');

    const q = $('#q');
    if (q) {
      q.value = 'github.com';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(320);
      const filtered = $$('.erow').length;
      ok('搜索过滤生效', filtered >= 1 && filtered <= rows, filtered + ' 行');
      q.value = '';
      q.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(260);
    }

    // 关于页：Tauri 版运行环境应显示 WebView2，不再残留「Electron · Node -」
    $('.nav-item[data-page="settings"]').click();
    await sleep(320);
    const envDt = $$('.kv dt').find((d) => (d.textContent || '').includes('运行环境'));
    const envText = envDt && envDt.nextElementSibling ? envDt.nextElementSibling.textContent : '';
    ok('关于页运行环境显示 WebView2', envText.includes('WebView2') && !envText.includes('Node -'), envText.trim());

    // 本次新增：hosts 检测处「打开目录」入口 + 退出确认框（点取消，不会真的退出）
    ok('hosts 检测处有「打开目录」按钮', !!$('[data-act="open-hosts-dir"]'),
      $('[data-act="open-hosts-dir"]') ? '已渲染' : '未找到');
    $('[data-act="quit"]').click();
    await sleep(250);
    const cmShown = !$('#modalRoot').hidden && !!$('#cm-ok');
    ok('退出确认框正常弹出（自绘模态）', cmShown, cmShown ? '可点取消关闭' : '未弹出');
    if (cmShown) closeModal();
    await sleep(150);

    const st = await window.api.win.state();
    ok('窗口状态可查询', typeof st === 'object' && 'maximized' in st, JSON.stringify(st));

    // 悬停残留回归：模拟「悬停关闭按钮 → 关闭到托盘 → 从后台唤起」
    const closeBtn = $('#btnClose');
    closeBtn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
    await sleep(100);
    ok('悬停高亮由 mousemove 驱动', closeBtn.classList.contains('is-hover'),
      'is-hover=' + closeBtn.classList.contains('is-hover'));
    await window.api.win.close();
    await sleep(400);
    await window.api.win.show();
    await sleep(400);
    const resid = closeBtn.classList.contains('is-hover');
    ok('唤起后关闭按钮无残留高亮', !resid, 'is-hover=' + resid);
  } catch (e) {
    log('EXCEPTION ' + ((e && e.message) || String(e)));
    ok('自检脚本执行异常', false, (e && e.message) || String(e));
  }

  log('SELFTEST_REPORT');
  try {
    await raw('selftest_report', { results: out });
  } catch (e) {
    log('REPORT_FAILED ' + ((e && e.message) || String(e)));
  }
})();

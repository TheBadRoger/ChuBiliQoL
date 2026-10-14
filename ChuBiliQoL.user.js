// ==UserScript==
// @name         ChuBiliQoL
// @namespace    https://github.com/TheBadRoger/ChuBiliQoL
// @version      0.2.0
// @description  关注审核、半年未投稿筛选、断点续扫与安全取关
// @author       TheBadRoger
// @license      MIT
// @homepageURL  https://github.com/TheBadRoger/ChuBiliQoL
// @match        https://www.bilibili.com/*
// @grant        GM.xmlHttpRequest
// @connect      api.bilibili.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  const DAY = 86400000;
  const VALID_REVIEW = new Set(['pending', 'keep', 'remove']);
  const uid = value => {
    const s = String(value);
    if (!/^[1-9]\d{0,15}$/.test(s) || !Number.isSafeInteger(Number(s))) throw new Error('无效 UID');
    return s;
  };
  function cutoff(now = Date.now()) {
    const d = new Date(now);
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - 6);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d.getTime();
  }
  function relation(data) {
    if (!data || ![0, 2, 6, 128].includes(data.attribute) || ![0, 1].includes(data.special)) {
      throw new Error('关注关系字段不完整，已停止');
    }
    return { attribute: data.attribute, special: data.special };
  }
  function latestVideo(data, now = Date.now()) {
    const list = data?.list?.vlist;
    const count = data?.page?.count;
    if (!Array.isArray(list) || !Number.isSafeInteger(count) || count < 0) throw new Error('投稿响应不完整');
    if (!count && !list.length) return { latest: null, status: 'empty' };
    if (!list.length || count < list.length) throw new Error('投稿数量与列表不一致');
    const dates = list.map(v => v.created * 1000);
    if (dates.some(t => !Number.isFinite(t) || t <= 0 || t > now)) throw new Error('投稿时间无效');
    const latest = Math.max(...dates);
    return { latest, status: latest < cutoff(now) ? 'inactive' : 'active' };
  }
  function eligible(row, state) {
    return state.complete && row.status === 'inactive' && row.review === 'remove' &&
      row.attribute === 2 && !state.excluded.includes(row.mid) &&
      (!state.protectSpecial || row.special === 0) &&
      Number.isFinite(row.latest) && row.latest > 0 && row.latest < cutoff();
  }
  function cachedVideo(row, now = Date.now()) {
    const age = now - row.checked;
    if (age < 0 || age >= DAY || !Number.isFinite(row.latest) || row.latest <= 0 || row.latest > now) return null;
    return { latest: row.latest, status: row.latest < cutoff(now) ? 'inactive' : 'active' };
  }
  function mergeReview(state, input) {
    if (input?.format !== 'ChuBiliQoL-review' || input.version !== 1 || input.account !== state.account ||
        !Array.isArray(input.rows) || input.rows.length > 50000 ||
        !Array.isArray(input.excluded) || input.excluded.length > 50000) throw new Error('审核文件格式或账号不匹配');
    const rows = input.rows.map(r => ({ mid: uid(r.mid), review: r.review }));
    if (rows.some(r => !VALID_REVIEW.has(r.review))) throw new Error('审核状态无效');
    const excluded = input.excluded.map(uid);
    const decisions = new Map(rows.map(r => [r.mid, r.review]));
    // Imported removal decisions always require a new local review.
    for (const row of state.rows) {
      const decision = decisions.get(row.mid);
      if (decision) row.review = decision === 'keep' ? 'keep' : 'pending';
    }
    state.excluded = [...new Set([...state.excluded, ...excluded])];
    return state;
  }

  // RFC 1321 arithmetic; MD5 is used only for the platform's WBI request signature.
  function md5(value) {
    const bytes = new TextEncoder().encode(value);
    const size = Math.ceil((bytes.length + 9) / 64) * 64;
    const buffer = new ArrayBuffer(size);
    const view = new DataView(buffer);
    new Uint8Array(buffer).set(bytes);
    view.setUint8(bytes.length, 128);
    view.setUint32(size - 8, bytes.length * 8, true);
    view.setUint32(size - 4, Math.floor(bytes.length / 0x20000000), true);
    const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
    for (let offset = 0; offset < size; offset += 64) {
      let [a, b, c, d] = h;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = (b & c) | (~b & d); g = i; }
        else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
        else { f = c ^ (b | ~d); g = (7 * i) % 16; }
        const x = (a + f + Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) + view.getUint32(offset + g * 4, true)) | 0;
        const shift = shifts[Math.floor(i / 16) * 4 + i % 4];
        [a, b, c, d] = [d, (b + ((x << shift) | (x >>> (32 - shift)))) | 0, b, c];
      }
      [a, b, c, d].forEach((v, i) => { h[i] = (h[i] + v) | 0; });
    }
    return h.map(v => [0, 8, 16, 24].map(s => ((v >>> s) & 255).toString(16).padStart(2, '0')).join('')).join('');
  }
  function wbiKey(img) {
    const keys = [img?.img_url, img?.sub_url].map(u => {
      const match = typeof u === 'string' && u.match(/\/([a-f0-9]{32})\.[a-z]+(?:\?.*)?$/i);
      if (!match) throw new Error('WBI 密钥格式变化');
      return match[1];
    }).join('');
    const order = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];
    return order.map(i => keys[i]).join('');
  }
  function sign(params, key, now = Date.now()) {
    const all = { ...params, wts: Math.floor(now / 1000) };
    const query = Object.keys(all).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(all[k]).replace(/[!'()*]/g, ''))}`).join('&');
    return `${query}&w_rid=${md5(query + key)}`;
  }
  function parseResponse(response, allowEmpty = false) {
    if (response.status !== 200) throw new Error(`HTTP ${response.status}：请求已暂停，不自动重试`);
    let body;
    try { body = JSON.parse(response.responseText); } catch { throw new Error('服务器返回非 JSON，已暂停'); }
    if (body.code !== 0) throw new Error(`API ${body.code}：请求已暂停，不自动重试`);
    if (allowEmpty && body.data == null) return null;
    if (!body.data || typeof body.data !== 'object') throw new Error('API 数据缺失');
    return body.data;
  }
  function freshState(account) {
    return { version: 1, account, rows: [], excluded: [], protectSpecial: true, scanConcurrency: 1,
      page: 1, total: null, listed: false, complete: false, cursor: 0, message: '尚未扫描' };
  }

  function requestGate({ interval, wait, check, now = Date.now }) {
    let tail = Promise.resolve(), last = -Infinity;
    return () => {
      const slot = tail.then(async () => {
        check();
        await wait(Math.max(0, last + interval() - now()));
        check();
        last = now();
      });
      tail = slot.catch(() => {});
      return slot;
    };
  }
  async function scanRows(state, concurrency, io) {
    let next = state.cursor, failure, commits = Promise.resolve();
    const finished = new Set();
    async function worker() {
      while (!failure) {
        try {
          io.checkStop();
          const index = next++;
          if (index >= state.rows.length) return;
          const patch = await io.inspect(state.rows[index]);
          commits = commits.then(async () => {
            Object.assign(state.rows[index], patch);
            finished.add(index);
            // Only advance past contiguous results: an earlier failed row must remain resumable.
            while (finished.delete(state.cursor)) state.cursor++;
            await io.save();
            io.progress();
          });
          await commits;
        } catch (error) { failure ||= error; io.stop(error); }
      }
    }
    await Promise.all(Array.from({ length: concurrency === 2 ? 2 : 1 }, worker));
    if (failure) throw failure;
  }

  async function removeOne(row, state, io) {
    io.checkStop();
    await io.identity();
    Object.assign(row, await io.video(row.mid), { checked: Date.now() });
    Object.assign(row, relation(await io.relation(row.mid)));
    if (row.attribute === 6 && !state.excluded.includes(row.mid)) state.excluded.push(row.mid);
    if (!eligible(row, state)) {
      row.review = 'keep';
      await io.save(); await io.log(row.mid, 'skipped-protected-or-active');
      return;
    }
    io.checkStop();
    const operation = io.operation();
    // Persist intent before sending: a timeout/reload must never cause an automatic replay.
    row.status = 'uncertain'; row.review = 'keep';
    await io.save();
    await io.log(row.mid, 'intent', operation);
    try {
      await io.write(row.mid);
      row.status = 'removed';
      await io.save(); await io.log(row.mid, 'success', operation);
    } catch (error) {
      row.status = 'uncertain';
      await io.save(); await io.log(row.mid, 'uncertain', operation);
      throw error;
    }
  }

  // The exact same functions are exercised by Node's dependency-free test runner.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { uid, cutoff, relation, latestVideo, eligible, cachedVideo, mergeReview, md5, wbiKey, sign, parseResponse, freshState, removeOne, requestGate, scanRows };
    return;
  }
  if (window.top !== window.self) return;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const cookie = name => document.cookie.split('; ').find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
  let db, state, root, busy = false, stopping = false, scanning = false, requestError, identityTask, key = '', keyTime = 0;
  const selected = new Set();
  let query = '', filter = 'inactive', sort = 'latest', page = 0, moreOpen = false;
  const labels = { inactive: '半年未投稿', active: '近期投稿', empty: '无可见视频（人工判断）',
    protected: '受保护', pending: '未扫描', removed: '已取关', uncertain: '操作结果待核实' };

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('ChuBiliQoL', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('state', { keyPath: 'account' });
        request.result.createObjectStore('logs', { keyPath: 'id', autoIncrement: true });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('无法打开本地数据库'));
      request.onblocked = () => reject(new Error('数据库被其他页面占用，请关闭其他 Bilibili 标签页'));
    });
  }
  function store(name, mode, action) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, mode);
      const request = action(tx.objectStore(name));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error('本地数据保存失败；已停止操作'));
    });
  }
  const save = () => store('state', 'readwrite', s => s.put(state));
  const log = (mid, result, operation) => store('logs', 'readwrite', s => s.add({
    account: state.account, mid, result, operation, time: new Date().toISOString()
  }));
  function assertAccount() {
    if (cookie('DedeUserID') !== state.account) throw new Error('登录账号已变化，请刷新页面');
  }
  function checkStop() {
    assertAccount();
    if (requestError) throw requestError;
    if (stopping) throw new Error('已手动暂停，可继续扫描；取关需要重新确认');
  }
  const waitRequest = requestGate({ interval: () => scanning && state.scanConcurrency === 2 ? 1500 : 2500,
    wait: sleep, check: checkStop });
  async function api(path, params = {}, body) {
    try {
      await waitRequest();
      checkStop();
      const qs = typeof params === 'string' ? params : new URLSearchParams(params).toString();
      const response = await new Promise((resolve, reject) => {
        GM.xmlHttpRequest({ method: body ? 'POST' : 'GET',
          url: `https://api.bilibili.com${path}${qs ? `?${qs}` : ''}`, timeout: 20000,
          headers: body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {},
          data: body?.toString(), anonymous: false,
          onload: resolve, onerror: () => reject(new Error('网络错误，已暂停，不重试')),
          ontimeout: () => reject(new Error('请求超时，已暂停；取关结果可能不确定')),
          onabort: () => reject(new Error('请求中止，已暂停')) });
      });
      assertAccount();
      return parseResponse(response, Boolean(body));
    } catch (error) { requestError ||= error; throw error; }
  }
  async function identity() {
    if (identityTask) return identityTask;
    identityTask = (async () => {
      const nav = await api('/x/web-interface/nav');
      if (!nav.isLogin || uid(nav.mid) !== state.account) throw new Error('账号验证失败，请重新登录并刷新');
      key = wbiKey(nav.wbi_img);
      keyTime = Date.now();
    })().finally(() => { identityTask = null; });
    return identityTask;
  }
  async function video(mid) {
    if (!key || Date.now() - keyTime > 30000) await identity();
    return latestVideo(await api('/x/space/wbi/arc/search', sign({ mid, pn: 1, ps: 30, order: 'pubdate' }, key)));
  }
  function rememberMutual(row) {
    if (row.attribute === 6 && !state.excluded.includes(row.mid)) state.excluded.push(row.mid);
  }
  async function scan(reset = false) {
    await identity();
    if (reset) {
      if (!confirm('重新获取全部关注并扫描？保留名单与互粉排除会保留，待取关审核会重置。')) return;
      state.rows = state.rows.map(r => ({ ...r, review: r.review === 'keep' ? 'keep' : 'pending' }));
      state.page = 1; state.total = null; state.listed = false; state.complete = false; state.cursor = 0;
      state.previous = state.rows;
      state.rows = [];
      selected.clear();
      await save();
    }
    while (!state.listed) {
      checkStop();
      const data = await api('/x/relation/followings', { vmid: state.account, pn: state.page, ps: 50, order: 'desc' });
      if (!Array.isArray(data.list) || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > 50000) throw new Error('关注列表响应无效');
      if (state.total !== null && state.total !== data.total) throw new Error('扫描期间关注总数变化，请重新扫描');
      const seen = new Set(state.rows.map(r => r.mid));
      const previous = new Map((state.previous || []).map(r => [r.mid, r]));
      const additions = data.list.map(item => {
        const mid = uid(item.mid);
        if (seen.has(mid)) throw new Error('关注分页重复，请重新扫描');
        seen.add(mid);
        const rel = relation(item);
        const old = previous.get(mid);
        return { mid, name: String(item.uname || mid).slice(0, 100), ...rel,
          review: old?.review === 'keep' ? 'keep' : 'pending', status: 'pending',
          latest: old?.latest ?? null, checked: old?.checked ?? 0 };
      });
      if (state.rows.length + additions.length > data.total || (!additions.length && state.rows.length < data.total)) throw new Error('关注分页不完整，请重新扫描');
      state.total = data.total;
      state.rows.push(...additions);
      state.rows.forEach(rememberMutual);
      state.page++;
      state.listed = state.rows.length === state.total;
      state.message = `已获取 ${state.rows.length} / ${state.total} 个关注`;
      await save(); render();
    }
    scanning = true;
    try {
      await scanRows(state, state.scanConcurrency, { checkStop,
        inspect: async row => {
          if (state.excluded.includes(row.mid) || (state.protectSpecial && row.special === 1)) return { status: 'protected' };
          const cached = cachedVideo(row);
          return cached || { ...await video(row.mid), checked: Date.now() };
        },
        save: async () => { state.message = `已扫描 ${state.cursor} / ${state.rows.length}`; await save(); },
        progress: render, stop: error => { requestError ||= error; }
      });
    } finally { scanning = false; }
    state.complete = true;
    delete state.previous;
    state.message = '扫描完成，请人工审核；缓存有效期 24 小时';
    await save();
  }
  async function removeReviewed() {
    const targets = state.rows.filter(r => selected.has(r.mid) && eligible(r, state));
    if (!targets.length) throw new Error('请选择已人工标记为待取关的半年未投稿账号');
    if (!confirm(`将取关选中的 ${targets.length} 个账号。操作不可自动撤销，请先核对投稿页与保留名单。`)) return;
    if (prompt(`二次确认：请输入“取关 ${targets.length}”继续`) !== `取关 ${targets.length}`) return;
    for (const row of targets) {
      await removeOne(row, state, { checkStop, identity, video, save, log,
        relation: mid => api('/x/relation', { fid: mid }), operation: () => crypto.randomUUID(),
        write: mid => {
          const csrf = cookie('bili_jct');
          if (!csrf || !/^[a-f0-9]{32}$/i.test(csrf)) throw new Error('CSRF 校验字段缺失，请重新登录');
          return api('/x/relation/modify', {}, new URLSearchParams({ fid: mid, act: 2, re_src: 11, csrf }));
        } });
      if (row.status === 'removed') selected.delete(row.mid);
      render();
    }
    state.message = '本批次结束；跳过项与操作结果已记录';
    await save();
  }
  async function exclusive(action) {
    if (busy) return;
    if (!navigator.locks) { alert('浏览器不支持 Web Locks，请升级浏览器'); return; }
    try {
      await navigator.locks.request('ChuBiliQoL-operation', { ifAvailable: true }, async lock => {
        if (!lock) throw new Error('其他页面正在操作，请等待或关闭该页面');
        busy = true; stopping = false; requestError = null;
        try {
          assertAccount();
          state = await store('state', 'readonly', s => s.get(state.account)) || state;
          render();
          await action();
        } catch (error) {
          state.message = error.message;
          try { await save(); } catch { state.message += '；本地保存失败，请立即导出并停止使用'; }
        } finally { busy = false; render(); }
      });
    } catch (error) { alert(error.message); }
  }
  function download(value, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function reviewExport() {
    return { format: 'ChuBiliQoL-review', version: 1, account: state.account,
      exported: new Date().toISOString(), excluded: state.excluded,
      rows: state.rows.map(({ mid, name, review }) => ({ mid, name, review })) };
  }
  function visibleRows() {
    const q = query.toLocaleLowerCase();
    return state.rows.filter(r => (!q || `${r.name} ${r.mid}`.toLocaleLowerCase().includes(q)) &&
      (filter === 'all' || (filter === 'keep' || filter === 'remove' ? r.review === filter : r.status === filter)))
      .sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'zh-CN') :
        sort === 'uid' ? Number(a.mid) - Number(b.mid) : (a.latest ?? Infinity) - (b.latest ?? Infinity));
  }
  function el(tag, text, props = {}) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    Object.assign(node, props);
    return node;
  }
  function button(text, fn, disabled = busy) {
    const node = el('button', text, { type: 'button', disabled });
    node.onclick = fn;
    return node;
  }
  function render() {
    if (!root) return;
    const focus = root.activeElement?.id;
    const position = root.activeElement?.selectionStart;
    root.replaceChildren();
    const style = el('style', `:host([hidden]){display:none}:host{all:initial;font:13px/1.5 system-ui;color:#e7edf6}*{box-sizing:border-box}section{position:fixed;right:24px;bottom:76px;width:min(860px,calc(100vw - 32px));height:min(620px,calc(100vh - 100px));background:#141c2b;border:1px solid #53647e;border-radius:12px;box-shadow:0 12px 48px #0007;display:flex;flex-direction:column;padding:16px;z-index:2147483647}h2{margin:0;font-size:18px}header,.tools,footer{display:flex;gap:6px;flex-wrap:wrap;align-items:center}header{justify-content:space-between}.tools{margin:7px 0}button,input,select{font:inherit;color:inherit;background:#24334b;border:1px solid #61718b;border-radius:6px;padding:5px 8px}button,summary{cursor:pointer}button:disabled{opacity:.4;cursor:default}input[type=checkbox]{accent-color:#62c8ff}input[type=search]{flex:1;min-width:130px}a{color:#80d4ff;text-decoration:none}a:hover{text-decoration:underline}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:7px;border-bottom:1px solid #33435b}th{position:sticky;top:0;background:#1e2b40}td:nth-child(2){max-width:220px;overflow-wrap:anywhere}td small{display:block}small{color:#a8b9d0}.scroll{overflow:auto;flex:1;min-height:80px}.notice{padding:7px 9px;background:#223148;border-radius:6px;margin:7px 0;max-height:64px;overflow:auto}footer{margin-top:8px}footer span{margin-right:auto}label{display:flex;align-items:center;gap:4px}.danger{background:#793742}details{border-top:1px solid #33435b;margin-top:8px;padding-top:6px;max-height:150px;overflow:auto}summary{color:#a8b9d0;width:max-content}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid #80d4ff}@media(max-width:650px){section{right:8px;bottom:64px;width:calc(100vw - 16px);height:calc(100dvh - 80px);padding:10px}td,th{padding:5px;font-size:12px}h2{font-size:16px}}`);
    root.append(style);
    const panel = el('section', undefined, { role: 'dialog', ariaLabel: 'ChuBiliQoL 关注管理' });
    const header = el('header');
    const headerActions = el('div', undefined, { className: 'tools' });
    headerActions.append(button(busy ? '暂停' : '继续扫描', () => {
      if (busy) { stopping = true; state.message = '正在暂停，等待已发出的请求结束'; render(); }
      else exclusive(() => scan());
    }, busy && stopping), button('收起', () => { root.host.hidden = true; }, false));
    header.append(el('h2', 'ChuBiliQoL · 关注审核'), headerActions);
    panel.append(header, el('small', `UID ${state.account} · 互粉保护 ${state.excluded.length} 个 · ${state.scanConcurrency === 2 ? '双路扫描' : '串行扫描'}`));
    const more = el('details', undefined, { open: moreOpen });
    more.append(el('summary', '更多'));
    more.ontoggle = () => { moreOpen = more.open; };
    const tools = el('div', undefined, { className: 'tools' });
    tools.append(button('重新扫描', () => exclusive(() => scan(true))));
    const protect = el('input', undefined, { type: 'checkbox', checked: state.protectSpecial, disabled: busy });
    protect.onchange = () => exclusive(async () => {
      if (!protect.checked && !confirm('关闭特别关注保护？互粉保护仍永久生效。修改后需要重新扫描。')) return;
      state.protectSpecial = protect.checked;
      state.complete = false;
      state.cursor = 0;
      await save();
    });
    const label = el('label'); label.append(protect, el('span', '保护特别关注')); tools.append(label);
    const parallel = el('input', undefined, { type: 'checkbox', checked: state.scanConcurrency === 2, disabled: busy });
    parallel.onchange = () => exclusive(async () => { state.scanConcurrency = parallel.checked ? 2 : 1; await save(); });
    const parallelLabel = el('label', undefined, { title: '最多两路查询，至少间隔 1.5 秒发送；遇到限制即暂停。取关始终串行。' });
    parallelLabel.append(parallel, el('span', '双路并行扫描')); tools.append(parallelLabel);
    more.append(tools);
    panel.append(el('div', state.message, { className: 'notice', role: 'status', ariaLive: 'polite' }));
    const searchTools = el('div', undefined, { className: 'tools' });
    const search = el('input', undefined, { id: 'search', type: 'search', placeholder: '搜索昵称 / UID', value: query, ariaLabel: '搜索昵称或 UID' });
    search.oninput = () => { query = search.value; page = 0; render(); };
    const makeSelect = (options, value, callback, title) => {
      const select = el('select', undefined, { ariaLabel: title });
      for (const [key, name] of options) select.append(el('option', name, { value: key, selected: key === value }));
      select.onchange = () => { callback(select.value); page = 0; render(); };
      return select;
    };
    searchTools.append(search, makeSelect([['inactive', '半年未投稿'], ['all', '全部关注'], ['protected', '受保护'], ['empty', '无可见视频'], ['pending', '未扫描'], ['keep', '已保留'], ['remove', '待取关'], ['uncertain', '待核实'], ['removed', '已取关']], filter, v => { filter = v; }, '筛选'),
      makeSelect([['latest', '投稿时间：旧 → 新'], ['name', '昵称'], ['uid', 'UID']], sort, v => { sort = v; }, '排序'));
    panel.append(searchTools);
    const visible = visibleRows();
    page = Math.min(page, Math.max(0, Math.ceil(visible.length / 50) - 1));
    const current = visible.slice(page * 50, page * 50 + 50);
    const batch = el('div', undefined, { className: 'tools' });
    const setReview = review => exclusive(async () => {
      for (const row of state.rows) if (selected.has(row.mid)) {
        if (review !== 'remove' || (row.status === 'inactive' && row.attribute === 2 &&
          !state.excluded.includes(row.mid) && (!state.protectSpecial || !row.special))) row.review = review;
      }
      await save();
    });
    batch.append(button('选择本页', () => { current.forEach(r => selected.add(r.mid)); render(); }),
      button('批量保留', () => setReview('keep')), button('标记待取关', () => setReview('remove')));
    tools.append(button('清空选择', () => { selected.clear(); render(); }), button('恢复待审核', () => setReview('pending')));
    const remove = button('取关选中审核项', () => exclusive(removeReviewed), busy || !state.complete);
    remove.className = 'danger'; batch.append(remove); panel.append(batch);
    const scroll = el('div', undefined, { className: 'scroll' });
    const table = el('table'); const head = el('tr');
    ['选择', 'UP 主 ↗ 投稿', '最近视频', '状态', '审核'].forEach(t => head.append(el('th', t)));
    const thead = el('thead'); thead.append(head); table.append(thead);
    const body = el('tbody');
    for (const row of current) {
      const tr = el('tr'); const selectCell = el('td');
      const cb = el('input', undefined, { type: 'checkbox', checked: selected.has(row.mid), disabled: busy, ariaLabel: `选择 ${row.name}` });
      cb.onchange = () => { if (cb.checked) selected.add(row.mid); else selected.delete(row.mid); render(); };
      selectCell.append(cb);
      const name = el('td');
      name.append(el('a', row.name, { href: `https://space.bilibili.com/${row.mid}/upload/video`, target: '_blank', rel: 'noopener noreferrer', ariaLabel: `打开 ${row.name} 投稿页` }), el('small', row.mid));
      tr.append(selectCell, name, el('td', row.latest ? new Date(row.latest).toLocaleDateString() : '—'),
        el('td', state.excluded.includes(row.mid) ? '互粉永久排除' : labels[row.status] || row.status),
        el('td', { pending: '待审核', keep: '保留', remove: '待取关' }[row.review]));
      body.append(tr);
    }
    table.append(body); scroll.append(table); panel.append(scroll);
    const footer = el('footer');
    footer.append(el('span', `匹配 ${visible.length} / 总计 ${state.rows.length} · 已选 ${selected.size} · 第 ${page + 1} 页`),
      button('上一页', () => { page--; render(); }, page <= 0), button('下一页', () => { page++; render(); }, (page + 1) * 50 >= visible.length));
    const files = el('div', undefined, { className: 'tools' });
    files.append(button('导出审核名单', () => exclusive(async () => download(reviewExport(), `ChuBiliQoL-review-${state.account}.json`))),
      button('导入审核名单', () => { file.click(); }),
      button('导出操作记录', () => exclusive(async () => {
        const logs = await store('logs', 'readonly', s => s.getAll());
        download(logs.filter(l => l.account === state.account), `ChuBiliQoL-operations-${state.account}.json`);
      })));
    const file = el('input', undefined, { type: 'file', accept: 'application/json,.json', hidden: true });
    file.onchange = () => exclusive(async () => {
      if (!file.files[0]) return;
      if (file.files[0].size > 5 * 1024 * 1024) throw new Error('文件超过 5 MB');
      mergeReview(state, JSON.parse(await file.files[0].text()));
      await save(); state.message = '已合并保留和排除名单；导入的待取关项需要重新人工审核'; await save();
    });
    files.append(file); more.append(files); panel.append(footer, more); root.append(panel);
    if (focus === 'search') {
      const searchBox = root.getElementById('search'); searchBox.focus();
      if (position !== null) searchBox.setSelectionRange(position, position);
    }
  }
  async function boot() {
    const account = cookie('DedeUserID');
    if (!account) { alert('请先登录 Bilibili，再打开关注管理'); return; }
    db ||= await openDB();
    state = await store('state', 'readonly', s => s.get(uid(account))) || freshState(uid(account));
    if (!root) {
      const host = el('div'); document.body.append(host); root = host.attachShadow({ mode: 'closed' });
    }
    root.host.hidden = false;
    render();
  }
  const entry = el('button', '关注管理 · ChuBiliQoL', { type: 'button' });
  entry.style.cssText = 'position:fixed;right:20px;bottom:25px;z-index:2147483646;background:#173450;color:#fff;border:1px solid #80d4ff;border-radius:22px;padding:10px 16px;cursor:pointer;font:14px system-ui';
  entry.onclick = () => {
    if (root) { root.host.hidden = !root.host.hidden; return; }
    boot().catch(e => alert(e.message));
  };
  document.body.append(entry);
})();

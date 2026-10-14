'use strict';
// Optional browser smoke test. All API traffic is synthetic; no real account is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.CHUBILI_PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch(process.env.CHUBILI_BROWSER_PATH ?
    { executablePath: process.env.CHUBILI_BROWSER_PATH, headless: true } : { channel: 'msedge', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.route('**/*', route => route.request().url() === 'https://www.bilibili.com/' ?
      route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>ChuBiliQoL offline test</title><body>Offline fixture</body>' }) : route.abort());
    await context.addCookies([{ name: 'DedeUserID', value: '123', domain: '.bilibili.com', path: '/' },
      { name: 'bili_jct', value: '0'.repeat(32), domain: '.bilibili.com', path: '/' }]);
    await context.addInitScript(() => {
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) { return attach.call(this, { ...init, mode: 'open' }); };
      const timeout = window.setTimeout;
      window.setTimeout = (fn, ms, ...args) => timeout(fn, Math.min(ms, 5), ...args);
      window.fixture = { fail: true, writes: [], requests: [] };
      window.GM = { xmlHttpRequest(options) {
        const url = new URL(options.url);
        const f = window.fixture; f.requests.push(url.pathname);
        let data;
        const rel = (mid, attribute = 2, special = 0) => ({ mid, uname: `测试 UP ${mid}`, attribute, special });
        if (url.pathname === '/x/web-interface/nav') data = { isLogin: true, mid: 123,
          wbi_img: { img_url: `https://i.test/${'a'.repeat(32)}.png`, sub_url: `https://i.test/${'b'.repeat(32)}.png` } };
        else if (url.pathname === '/x/relation/followings') data = { total: 5,
          list: [rel(456), rel(457, 6), rel(458, 2, 1), rel(459), rel(460)] };
        else if (url.pathname === '/x/space/wbi/arc/search') {
          const mid = url.searchParams.get('mid');
          if (f.fail && mid === '459') { options.onload({ status: 412, responseText: '<html>limited</html>' }); return; }
          data = mid === '460' ? { page: { count: 0 }, list: { vlist: [] } } :
            { page: { count: 1 }, list: { vlist: [{ created: mid === '459' ? Math.floor(Date.now() / 1000) - 86400 : 1577836800 }] } };
        } else if (url.pathname === '/x/relation') data = rel(Number(url.searchParams.get('fid')));
        else if (url.pathname === '/x/relation/modify') {
          f.writes.push(new URLSearchParams(options.data).get('fid')); data = null;
        } else throw new Error(`Unexpected API: ${url.pathname}`);
        options.onload({ status: 200, responseText: JSON.stringify({ code: 0, data }) });
      } };
    });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', async dialog => {
      if (dialog.type() === 'prompt') await dialog.accept('取关 1'); else await dialog.accept();
    });
    const source = fs.readFileSync(path.join(__dirname, '..', 'ChuBiliQoL.user.js'), 'utf8');
    const load = async () => {
      await page.goto('https://www.bilibili.com/');
      await page.addScriptTag({ content: source });
      await page.getByRole('button', { name: '关注管理 · ChuBiliQoL', exact: true }).click();
    };
    const status = page.getByRole('status');
    await load();
    await page.getByRole('button', { name: '继续扫描', exact: true }).click();
    await status.filter({ hasText: 'HTTP 412' }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.requests.filter(p => p === '/x/space/wbi/arc/search').length), 2);
    // Reload exercises the real browser IndexedDB checkpoint rather than an in-memory fake.
    await load();
    await status.filter({ hasText: 'HTTP 412' }).waitFor();
    await page.evaluate(() => { window.fixture.fail = false; });
    await page.getByRole('button', { name: '继续扫描', exact: true }).click();
    await status.filter({ hasText: '扫描完成' }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.requests.filter(p => p === '/x/space/wbi/arc/search').length), 2);
    await page.getByRole('combobox', { name: '筛选', exact: true }).selectOption('all');
    assert.equal(await page.getByText('互粉永久排除', { exact: true }).count(), 1);
    await page.getByRole('searchbox', { name: '搜索昵称或 UID' }).fill('456');
    assert.equal(await page.getByRole('link', { name: '打开投稿', exact: true }).count(), 1);
    await page.getByRole('checkbox', { name: '选择 测试 UP 456', exact: true }).check();
    await page.getByRole('button', { name: '标记待取关', exact: true }).click();
    await page.getByRole('button', { name: '取关选中审核项', exact: true }).click();
    await status.filter({ hasText: '本批次结束' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixture.writes), ['456']);
    await page.getByRole('searchbox', { name: '搜索昵称或 UID' }).fill('');
    await page.getByRole('button', { name: '收起', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: 'ChuBiliQoL · 关注审核' }).isVisible(), false);
    await page.getByRole('button', { name: '关注管理 · ChuBiliQoL', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: 'ChuBiliQoL · 关注审核' }).isVisible(), true);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出操作记录', exact: true }).click();
    const file = await download;
    const logs = JSON.parse(fs.readFileSync(await file.path(), 'utf8'));
    assert.deepEqual(logs.map(l => l.result), ['intent', 'success']);
    assert.equal(JSON.stringify(logs).includes('csrf'), false);
    assert.deepEqual(errors, []);
    fs.mkdirSync(path.join(__dirname, '..', 'artifacts'), { recursive: true });
    await page.screenshot({ path: path.join(__dirname, '..', 'artifacts', 'panel.png') });
    console.log('PASS: offline browser scan, 412 pause, IndexedDB reload/resume, protections, search, review, confirmed removal, log export and collapse.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });

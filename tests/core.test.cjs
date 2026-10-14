'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { cutoff, uid, relation, latestVideo, accountStatus, eligible, cachedVideo, mergeReview, md5, wbiKey, sign, parseResponse, freshState, upgradeScan, inspectRow, removeOne, requestGate, scanRows } = require('../ChuBiliQoL.user.js');

const oldDate = Date.UTC(2020, 0, 1);
function fixture() {
  const state = freshState('123'); state.complete = true;
  const row = { mid: '456', name: 'UP', attribute: 2, special: 0, latest: oldDate, status: 'inactive', review: 'remove' };
  state.rows.push(row);
  const events = [];
  const io = {
    checkStop() {}, identity: async () => events.push('identity'),
    account: async () => ({ banned: false, banChecked: Date.now() }),
    video: async () => ({ latest: oldDate, status: 'inactive' }),
    relation: async () => ({ attribute: 2, special: 0 }),
    operation: () => 'operation-1',
    save: async () => events.push(`save:${row.status}`),
    log: async (mid, result) => events.push(`log:${result}`),
    write: async () => events.push('write')
  };
  return { row, state, io, events };
}

test('six calendar months clamp month ends and keep time; strict older-than boundary', () => {
  assert.equal(cutoff(Date.UTC(2024, 7, 31, 12)), Date.UTC(2024, 1, 29, 12));
  assert.equal(cutoff(Date.UTC(2025, 7, 31)), Date.UTC(2025, 1, 28));
  const now = Date.UTC(2026, 9, 14);
  const data = created => ({ list: { vlist: [{ created }] }, page: { count: 1 } });
  assert.equal(latestVideo(data(cutoff(now) / 1000), now).status, 'active');
  assert.equal(latestVideo(data(cutoff(now) / 1000 - 1), now).status, 'inactive');
  assert.equal(latestVideo({ list: { vlist: [] }, page: { count: 0 } }, now).status, 'empty');
  assert.throws(() => latestVideo({ list: { vlist: [] }, page: { count: 1 } }));
  assert.throws(() => latestVideo(data(now / 1000 + 1), now));
  assert.throws(() => latestVideo(data('garbage'), now));
});

test('eligibility fails closed for mutuals, special, incomplete, unknown and missing review', () => {
  const { row, state } = fixture();
  assert.equal(eligible(row, state), true);
  for (const patch of [{ attribute: 6 }, { special: 1 }, { status: 'empty' }, { status: 'uncertain' },
    { review: 'pending' }, { latest: NaN }, { latest: Date.now() }]) {
    assert.equal(eligible({ ...row, ...patch }, state), false);
  }
  state.protectSpecial = false;
  assert.equal(eligible({ ...row, special: 1 }, state), true);
  state.excluded.push(row.mid);
  assert.equal(eligible(row, state), false);
  state.excluded = []; state.complete = false;
  assert.equal(eligible(row, state), false);
});

test('cache expires from original check time, rejects clock rollback and recomputes calendar eligibility', () => {
  const now = Date.UTC(2026, 9, 14);
  const row = { checked: now - 1000, latest: oldDate };
  assert.deepEqual(cachedVideo(row, now), { latest: oldDate, status: 'inactive' });
  assert.equal(row.checked, now - 1000);
  assert.equal(cachedVideo(row, row.checked + 86400000), null);
  assert.equal(cachedVideo(row, row.checked - 1), null);
  assert.equal(cachedVideo({ ...row, latest: NaN }, now), null);
});

test('untrusted UID and relationship fields are rejected', () => {
  for (const value of ['0', '-1', '1<script>', '9007199254740992', '1e3', '__proto__']) assert.throws(() => uid(value));
  assert.equal(uid(12345), '12345');
  assert.throws(() => relation({ attribute: 2 }));
  assert.throws(() => relation({ attribute: 99, special: 0 }));
});

test('review import merges protection, downgrades removals and validates entire input before mutation', () => {
  const { row, state } = fixture(); state.excluded = ['789'];
  const input = { format: 'ChuBiliQoL-review', version: 1, account: '123', excluded: ['456'], rows: [{ mid: '456', review: 'remove' }] };
  mergeReview(state, input);
  assert.equal(row.review, 'pending');
  assert.deepEqual(state.excluded, ['789', '456']);
  mergeReview(state, { ...input, rows: [{ mid: '456', review: 'keep' }], excluded: [] });
  assert.equal(row.review, 'keep'); assert.deepEqual(state.excluded, ['789', '456']);
  const before = JSON.stringify(state);
  assert.throws(() => mergeReview(state, { ...input, account: '999' }));
  assert.throws(() => mergeReview(state, { ...input, excluded: ['bad'] }));
  assert.equal(JSON.stringify(state), before);
});

test('MD5 and WBI signing match independent hash and known key vector', () => {
  for (const value of ['', 'abc', '中文', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'a'.repeat(5000)]) {
    assert.equal(md5(value), createHash('md5').update(value).digest('hex'));
  }
  const key = wbiKey({ img_url: 'https://i.test/7cd084941338484aae1ad9425b84077c.png', sub_url: 'https://i.test/4932caff0ff746eab6f01bf08b70ac45.png' });
  assert.equal(key, 'ea1db124af3c7062474693fa704f4ff8');
  const query = 'a=x%20y&b=hello&wts=1702204169';
  assert.equal(sign({ b: "h!e'l(l)o*", a: 'x y' }, key, 1702204169000), `${query}&w_rid=${createHash('md5').update(query + key).digest('hex')}`);
  assert.throws(() => wbiKey({}));
});

test('HTTP/API limits and malformed responses throw; mutation may return null data', () => {
  const response = body => ({ status: 200, responseText: JSON.stringify(body) });
  for (const status of [412, 429, 403, 500]) assert.throws(() => parseResponse({ status, responseText: '<html>' }), /HTTP/);
  for (const code of [-412, -352, -101, -403, 22015]) assert.throws(() => parseResponse(response({ code })), /API/);
  assert.throws(() => parseResponse({ status: 200, responseText: '<html>' }));
  assert.throws(() => parseResponse(response({ code: 0, data: null })));
  assert.equal(parseResponse(response({ code: 0, data: null }), true), null);
});

test('removal persists intent before writing and records success after durable result', async () => {
  const { row, state, io, events } = fixture();
  await removeOne(row, state, io);
  assert.deepEqual(events, ['identity', 'save:uncertain', 'log:intent', 'write', 'save:removed', 'log:success']);
  assert.equal(row.status, 'removed'); assert.equal(row.review, 'keep');
});

test('new mutual, new special, unfollowed or newly active accounts never reach write', async () => {
  for (const change of ['mutual', 'special', 'unfollowed', 'active']) {
    const { row, state, io, events } = fixture();
    io.relation = async () => ({ attribute: change === 'mutual' ? 6 : change === 'unfollowed' ? 0 : 2, special: change === 'special' ? 1 : 0 });
    if (change === 'active') io.video = async () => ({ latest: Date.now(), status: 'active' });
    await removeOne(row, state, io);
    assert.equal(events.includes('write'), false, change);
    assert.equal(row.review, 'keep');
    if (change === 'mutual') assert.ok(state.excluded.includes(row.mid));
  }
});

test('412 during revalidation halts with no write; write timeout is not replayable', async () => {
  const first = fixture();
  first.io.relation = async () => { throw new Error('HTTP 412'); };
  await assert.rejects(removeOne(first.row, first.state, first.io), /412/);
  assert.equal(first.events.includes('write'), false);
  const second = fixture(); let writes = 0;
  second.io.write = async () => { writes++; throw new Error('timeout'); };
  await assert.rejects(removeOne(second.row, second.state, second.io), /timeout/);
  assert.equal(writes, 1); assert.equal(second.row.status, 'uncertain');
  assert.equal(eligible(second.row, second.state), false);
  assert.ok(second.events.includes('log:uncertain'));
});

test('storage failure, identity change and pause each prevent destructive requests', async () => {
  for (const failure of ['storage', 'identity', 'pause']) {
    const { row, state, io, events } = fixture();
    if (failure === 'storage') io.save = async () => { throw new Error('disk'); };
    if (failure === 'identity') io.identity = async () => { throw new Error('account'); };
    if (failure === 'pause') io.checkStop = () => { throw new Error('pause'); };
    await assert.rejects(removeOne(row, state, io));
    assert.equal(events.includes('write'), false);
  }
});

const flush = () => new Promise(setImmediate);
test('parallel scanning is bounded and never checkpoints over an unfinished earlier row', async () => {
  const state = freshState('123'); state.rows = [0, 1, 2, 3].map(mid => ({ mid }));
  const pending = state.rows.map(() => Promise.withResolvers());
  const calls = [], cursors = [];
  const task = scanRows(state, 2, {
    checkStop() {}, stop() {}, progress() {},
    inspect: row => { calls.push(row.mid); return pending[row.mid].promise; },
    save: async () => cursors.push(state.cursor)
  });
  assert.deepEqual(calls, [0, 1]);
  pending[1].resolve({ status: 'active' }); await flush();
  assert.deepEqual(calls, [0, 1, 2]); assert.equal(state.cursor, 0);
  pending[0].resolve({ status: 'active' }); await flush();
  assert.equal(state.cursor, 2); assert.deepEqual(calls, [0, 1, 2, 3]);
  pending[3].resolve({ status: 'empty' }); await flush();
  assert.equal(state.cursor, 2);
  pending[2].resolve({ status: 'inactive' }); await task;
  assert.equal(state.cursor, 4); assert.deepEqual(cursors, [0, 2, 2, 4]);
});

test('parallel failure drains active work, preserves later cached results, and resumes the failed gap', async () => {
  const state = freshState('123'); state.rows = [0, 1, 2, 3].map(mid => ({ mid }));
  const pending = state.rows.map(() => Promise.withResolvers());
  let failure; const calls = [];
  const io = { checkStop() { if (failure) throw failure; }, stop(e) { failure ||= e; },
    save: async () => {}, progress() {}, inspect(row) { calls.push(row.mid); return pending[row.mid].promise; } };
  let settled = false;
  const task = scanRows(state, 2, io);
  const rejected = assert.rejects(task, /412/).then(() => { settled = true; });
  pending[1].resolve({ latest: oldDate, checked: Date.now(), status: 'inactive' }); await flush();
  pending[0].reject(new Error('HTTP 412')); await flush();
  assert.equal(settled, false); assert.deepEqual(calls, [0, 1, 2]);
  pending[2].resolve({ latest: oldDate, checked: Date.now(), status: 'inactive' }); await rejected;
  assert.equal(state.cursor, 0); assert.equal(state.rows[2].status, 'inactive');
  failure = undefined; const fetched = [];
  io.inspect = async row => cachedVideo(row) || (fetched.push(row.mid), { latest: oldDate, checked: Date.now(), status: 'inactive' });
  await scanRows(state, 2, io);
  assert.deepEqual(fetched.sort(), [0, 3]); assert.equal(state.cursor, 4);
});

test('parallel scan stops on pause or storage failure and does not dispatch more work', async () => {
  for (const kind of ['pause', 'storage']) {
    const state = freshState('123'); state.rows = [0, 1, 2, 3].map(mid => ({ mid }));
    const pending = [Promise.withResolvers(), Promise.withResolvers()];
    let failure; const calls = [];
    const task = scanRows(state, 2, {
      checkStop() { if (failure) throw failure; }, stop(e) { failure ||= e; }, progress() {},
      inspect: row => { calls.push(row.mid); return pending[row.mid].promise; },
      save: async () => { if (kind === 'storage') throw new Error('storage'); }
    });
    const rejected = assert.rejects(task, new RegExp(kind));
    if (kind === 'pause') failure = new Error('pause');
    pending[0].resolve({ status: 'active' }); await flush();
    pending[1].resolve({ status: 'active' }); await rejected;
    assert.deepEqual(calls, [0, 1]);
  }
});

test('one shared request gate spaces concurrent starts and cancels queued work after 412', async () => {
  let clock = 0, failure;
  const starts = [];
  const check = () => { if (failure) throw failure; };
  const gate = requestGate({ now: () => clock, interval: () => 1500, check,
    wait: async ms => { clock += ms; } });
  await Promise.all(Array.from({ length: 4 }, async () => { await gate(); starts.push(clock); }));
  assert.deepEqual(starts, [0, 1500, 3000, 4500]);
  const held = Promise.withResolvers();
  const limited = requestGate({ now: () => 0, interval: () => 1500, check,
    wait: ms => ms ? held.promise : Promise.resolve() });
  await limited();
  const queued = [limited(), limited()];
  const results = Promise.allSettled(queued);
  await flush(); failure = new Error('HTTP 412'); held.resolve();
  assert.deepEqual((await results).map(r => r.status), ['rejected', 'rejected']);
});

test('only a matching UID and explicit silence flag identify banned accounts', () => {
  assert.deepEqual(accountStatus({ mid: 456, silence: 1 }, '456', 1000), { banned: true, banChecked: 1000 });
  assert.equal(accountStatus({ mid: 456, silence: 0, sys_notice: { content: '封禁' } }, '456').banned, false);
  for (const data of [{ mid: 456 }, { mid: 789, silence: 1 }, { mid: 456, silence: '1' }, { mid: 456, silence: 2 }]) {
    assert.throws(() => accountStatus(data, '456'));
  }
});

test('banned accounts enter removal review without video queries while keep and protections survive', async () => {
  for (const protection of ['none', 'keep', 'mutual', 'special', 'excluded']) {
    const { row, state } = fixture(); row.status = 'active'; row.latest = Date.now(); row.review = 'pending';
    if (protection === 'keep') row.review = 'keep';
    if (protection === 'mutual') row.attribute = 6;
    if (protection === 'special') row.special = 1;
    if (protection === 'excluded') state.excluded.push(row.mid);
    let videos = 0;
    Object.assign(row, await inspectRow(row, state, {
      account: async () => accountStatus({ mid: 456, silence: 1 }, row.mid),
      video: async () => { videos++; throw new Error('must not query banned videos'); }
    }));
    assert.equal(row.status, 'banned'); assert.equal(row.latest, null); assert.equal(videos, 0);
    assert.equal(row.review, protection === 'none' ? 'remove' : 'keep');
    assert.equal(eligible(row, state), protection === 'none');
  }
});

test('ban cache expires without sliding lifetime and unbanned scans reset automatic removal review', async () => {
  const { row, state } = fixture();
  const now = Date.now(); Object.assign(row, { banned: true, banChecked: now - 100, status: 'banned', latest: null });
  let calls = 0;
  const io = { account: async () => { calls++; return accountStatus({ mid: 456, silence: 0 }, row.mid); },
    video: async () => ({ latest: oldDate, status: 'inactive' }) };
  const cached = await inspectRow(row, state, io, now);
  assert.equal(cached.banChecked, now - 100); assert.equal(calls, 0);
  const refreshed = await inspectRow(row, state, io, now + 86400000);
  assert.equal(calls, 1); assert.equal(refreshed.banned, false); assert.equal(refreshed.review, 'pending');
});

test('removal freshly rechecks banned status and never writes after unban, protection or profile failure', async () => {
  for (const outcome of ['banned', 'unbanned', 'mutual', 'special', 'error']) {
    const { row, state, io, events } = fixture();
    Object.assign(row, { status: 'banned', banned: true, banChecked: Date.now(), latest: null });
    io.account = async () => {
      if (outcome === 'error') throw new Error('HTTP 412');
      return accountStatus({ mid: 456, silence: outcome === 'unbanned' ? 0 : 1 }, row.mid);
    };
    io.video = async () => ({ latest: oldDate, status: 'inactive' });
    io.relation = async () => ({ attribute: outcome === 'mutual' ? 6 : 2, special: outcome === 'special' ? 1 : 0 });
    if (outcome === 'error') await assert.rejects(removeOne(row, state, io), /412/);
    else await removeOne(row, state, io);
    assert.equal(events.includes('write'), outcome === 'banned', outcome);
    if (outcome === 'unbanned') assert.ok(events.includes('log:skipped-unbanned'));
  }
});

test('old checkpoints preserve lists and reviews while requiring a full ban check, only once', () => {
  const { state, row } = fixture(); state.cursor = 1; delete state.scanRules; state.savedAt = 1000;
  assert.equal(upgradeScan(state), true);
  assert.equal(state.cursor, 0); assert.equal(state.complete, false); assert.equal(state.rows[0], row);
  assert.equal(row.review, 'remove'); assert.equal(state.savedAt, 1000);
  state.cursor = 1;
  assert.equal(upgradeScan(state), false); assert.equal(state.cursor, 1);
});

test('404 is skippable only when explicitly allowed; limits and other failures still stop', () => {
  const responses = [{ status: 404, responseText: '<html>missing</html>' },
    { status: 200, responseText: '{"code":-404}' }, { status: 200, responseText: '{"code":404}' }];
  for (const response of responses) {
    assert.deepEqual(parseResponse(response, false, true), { unavailable: true });
    assert.throws(() => parseResponse(response));
  }
  assert.throws(() => parseResponse({ status: 412, responseText: '{}' }, false, true), /412/);
  assert.throws(() => parseResponse({ status: 500, responseText: '{"code":-404}' }, false, true), /500/);
  assert.throws(() => parseResponse({ status: 200, responseText: '{"code":-352}' }, false, true), /352/);
});

test('404 results advance serial and parallel checkpoints without becoming removal candidates', async () => {
  for (const concurrency of [1, 2]) {
    const state = freshState('123'); state.rows = ['456', '457', '458'].map(mid => ({ mid, attribute: 2, special: 0, review: 'remove' }));
    let saves = 0;
    await scanRows(state, concurrency, { checkStop() {}, stop(e) { throw e; }, progress() {},
      save: async () => { saves++; }, inspect: row => inspectRow(row, state, {
        account: async mid => mid === '456' ? { unavailable: true } : { banned: false, banChecked: Date.now() },
        video: async mid => mid === '457' ? { status: 'unavailable', latest: null } : { status: 'inactive', latest: oldDate }
      }) });
    state.complete = true;
    assert.equal(state.cursor, 3); assert.equal(saves, 3);
    assert.deepEqual(state.rows.map(r => r.status), ['unavailable', 'unavailable', 'inactive']);
    assert.deepEqual(state.rows.map(r => eligible(r, state)), [false, false, true]);
  }
});

test('404 during removal revalidation skips the account without writing', async () => {
  for (const stage of ['account', 'video']) {
    const { row, state, io, events } = fixture();
    if (stage === 'account') io.account = async () => ({ unavailable: true });
    else io.video = async () => ({ status: 'unavailable', latest: null });
    await removeOne(row, state, io);
    assert.equal(row.status, 'unavailable'); assert.equal(row.review, 'keep');
    assert.equal(events.includes('write'), false); assert.ok(events.includes('log:skipped-unavailable'));
  }
});

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { cutoff, uid, relation, latestVideo, eligible, cachedVideo, mergeReview, md5, wbiKey, sign, parseResponse, freshState, removeOne } = require('../ChuBiliQoL.user.js');

const oldDate = Date.UTC(2020, 0, 1);
function fixture() {
  const state = freshState('123'); state.complete = true;
  const row = { mid: '456', name: 'UP', attribute: 2, special: 0, latest: oldDate, status: 'inactive', review: 'remove' };
  state.rows.push(row);
  const events = [];
  const io = {
    checkStop() {}, identity: async () => events.push('identity'),
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

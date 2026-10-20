import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROXIES } from '../site/proxies.js';
import { parseLink, proxyLink, telegramLink, selectProxies, probe, formatAddedDate } from '../site/core.js';

test('All 32 original links round-trip without modifying their secrets', () => {
  assert.equal(DEFAULT_PROXIES.length, 32);
  assert.equal(new Set(DEFAULT_PROXIES.map(p => p.server)).size, 32);
  for (const p of DEFAULT_PROXIES) assert.deepEqual(parseLink(proxyLink(p)), p);
});
test('Connection launches the Telegram WebProxy handler with the original server and secret', () => {
  for (const proxy of DEFAULT_PROXIES) {
    const url = new URL(telegramLink(proxy));
    assert.equal(url.protocol, 'tg:');
    assert.equal(url.hostname, 'webproxy');
    assert.equal(url.searchParams.get('server'), proxy.server);
    assert.equal(url.searchParams.get('secret'), proxy.secret);
    assert.deepEqual([...url.searchParams.keys()], ['server', 'secret']);
  }
});
test('Imported URLs reject scripts, foreign sites, local addresses and invalid secrets', () => {
  for (const url of ['javascript:alert(1)', 'https://evil.com/webproxy?server=a.com&secret=123456789abcdef0', 'https://t.me/webproxy?server=localhost&secret=123456789abcdef0', 'https://t.me/webproxy?server=127.0.0.1&secret=123456789abcdef0', 'https://t.me/webproxy?server=a.local&secret=123456789abcdef0', 'https://t.me/webproxy?server=a.com&secret=<script>']) assert.throws(() => parseLink(url));
});

test('WebProxy deep links retain server spelling and secret, and reject duplicate parameters', () => {
  const secret = 'Dd0123456789abcdef0123456789ABCDEF';
  assert.deepEqual(parseLink(`tg://webproxy?server=Web.Example.org&secret=${secret}`), { server: 'Web.Example.org', secret });
  assert.throws(() => parseLink(`https://t.me/webproxy?server=a.com&secret=${secret}&secret=${secret}`));
});

test('Addition dates use the site timezone and handle missing legacy dates', () => {
  assert.equal(formatAddedDate('2026-10-13T12:02:57Z'), '13.10.2026');
  assert.equal(formatAddedDate('2026-10-13T23:30:00Z'), '14.10.2026');
  assert.equal(formatAddedDate(null), null);
  assert.equal(formatAddedDate('not-a-date'), null);
});
test('Search, status filters and latency sorting preserve source order and put failed checks last', () => {
  const rows = [{ server: 'b.com', status: 'reachable', latency: 250 }, { server: 'a.com', status: 'unreachable', latency: null }, { server: 'c.com', status: 'reachable', latency: 90 }];
  assert.deepEqual(selectProxies(rows, { sort: 'latency' }).map(p => p.server), ['c.com', 'b.com', 'a.com']);
  assert.deepEqual(selectProxies(rows, { search: ' B.COM ', filter: 'reachable' }), [rows[0]]);
  assert.deepEqual(selectProxies(rows, { filter: 'unreachable' }), [rows[1]]);
  assert.equal(rows[0].server, 'b.com');
});
test('Probe checks the HTTPS host without secret and treats opaque replies only as transport reachability', async () => {
  let ticks = 0;
  const result = await probe('example.com', { now: () => ticks++ * 120, fetchFn: async (url, options) => {
    assert.equal(url, 'https://example.com/');
    assert.equal(options.mode, 'no-cors');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.referrerPolicy, 'no-referrer');
    return { type: 'opaque', status: 0 };
  } });
  assert.equal(result.status, 'reachable');
  assert.equal(result.latency, 120);
});
test('Network failure is a no-response result, never a fabricated latency', async () => {
  const result = await probe('example.com', { fetchFn: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(result.status, 'unreachable');
  assert.equal(result.latency, null);
});
test('Timeout aborts the request and reports no response', async () => {
  const result = await probe('example.com', { timeout: 10, fetchFn: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  assert.equal(result.status, 'unreachable');
});
test('User cancellation produces no failure result', async () => {
  const controller = new AbortController();
  const pending = probe('example.com', { signal: controller.signal, fetchFn: (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  controller.abort();
  assert.equal(await pending, null);
});

test('Descending latency keeps missing measurements last and equal measurements stable', () => {
  const rows = [{ server: 'a.com', status: 'unreachable' }, { server: 'b.com', status: 'reachable', latency: 100 }, { server: 'c.com', status: 'reachable', latency: 800 }, { server: 'd.com', status: 'unknown' }, { server: 'e.com', status: 'reachable', latency: 100 }];
  assert.deepEqual(selectProxies(rows, { sort: 'latency', direction: 'desc' }).map(p => p.server), ['c.com', 'b.com', 'e.com', 'a.com', 'd.com']);
  assert.deepEqual(selectProxies(rows, { sort: 'default', direction: 'desc' }).map(p => p.server), ['e.com', 'd.com', 'c.com', 'b.com', 'a.com']);
});
test('Name and status sorting support both directions', () => {
  const rows = [{ server: 'b.com', status: 'unknown' }, { server: 'a.com', status: 'reachable' }, { server: 'c.com', status: 'unreachable' }];
  assert.deepEqual(selectProxies(rows, { sort: 'name', direction: 'desc' }).map(p => p.server), ['c.com', 'b.com', 'a.com']);
  assert.deepEqual(selectProxies(rows, { sort: 'status' }).map(p => p.server), ['a.com', 'b.com', 'c.com']);
  assert.deepEqual(selectProxies(rows, { sort: 'status', direction: 'desc', search: '.com' }).map(p => p.server), ['c.com', 'b.com', 'a.com']);
});
test('History sorts by response share and places empty history last in both directions', () => {
  const rows = [{ server: 'a.com', history: [] }, { server: 'b.com', history: ['reachable', 'unreachable'] }, { server: 'c.com', history: ['reachable', 'reachable'] }, { server: 'd.com', history: ['unreachable'] }];
  assert.deepEqual(selectProxies(rows, { sort: 'history' }).map(p => p.server), ['d.com', 'b.com', 'c.com', 'a.com']);
  assert.deepEqual(selectProxies(rows, { sort: 'history', direction: 'desc' }).map(p => p.server), ['c.com', 'b.com', 'd.com', 'a.com']);
});

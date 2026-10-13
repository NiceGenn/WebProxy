import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PROXIES } from '../site/proxies.js';
import { parseLink, proxyLink, telegramLink, selectProxies, probe } from '../site/core.js';

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

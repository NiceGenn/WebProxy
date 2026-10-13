export function parseLink(value) {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.hostname !== 't.me' || url.pathname !== '/webproxy' || url.port || url.username || url.password) throw new Error('Нужна ссылка https://t.me/webproxy?server=…&secret=…');
  const server = url.searchParams.get('server')?.toLowerCase();
  const secret = url.searchParams.get('secret');
  if (!server || server.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(server) || /\.(local|localhost|internal|test|invalid)$/.test(server)) throw new Error('Укажите публичное доменное имя сервера');
  if (!secret || !/^[a-f0-9]{16,512}$/i.test(secret)) throw new Error('Параметр secret должен содержать шестнадцатеричные символы');
  return { server, secret };
}
export function proxyLink(proxy) {
  const url = new URL('https://t.me/webproxy');
  url.searchParams.set('server', proxy.server);
  url.searchParams.set('secret', proxy.secret);
  return url.href;
}
export function telegramLink(proxy) {
  return 'tg://webproxy' + new URL(proxyLink(proxy)).search;
}
export function selectProxies(proxies, { search = '', filter = 'all', sort = 'default', direction = 'asc' } = {}) {
  const rows = proxies.filter(p => p.server.includes(search.toLowerCase().trim()) && (filter === 'all' || p.status === filter));
  const order = new Map(proxies.map((p, index) => [p, index]));
  const statusOrder = { reachable: 0, checking: 1, unknown: 2, unreachable: 3 };
  const value = p => {
    if (sort === 'name') return p.server;
    if (sort === 'status') return statusOrder[p.status] ?? statusOrder.unknown;
    if (sort === 'latency') return p.status === 'reachable' && Number.isFinite(p.latency) ? p.latency : null;
    if (sort === 'history') {
      const history = (p.history || []).filter(h => h === 'reachable' || h === 'unreachable');
      return history.length ? history.filter(h => h === 'reachable').length / history.length : null;
    }
    return order.get(p);
  };
  rows.sort((a, b) => {
    const left = value(a), right = value(b);
    // Missing measurements stay at the bottom in both directions.
    if (left === null || right === null) return left === right ? order.get(a) - order.get(b) : left === null ? 1 : -1;
    const compared = typeof left === 'string' ? left.localeCompare(right) : left - right;
    return compared ? compared * (direction === 'desc' ? -1 : 1) : order.get(a) - order.get(b);
  });
  return rows;
}
export async function probe(server, { signal, timeout = 8000, fetchFn = fetch, now = () => performance.now() } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeout);
  const start = now();
  try {
    // An opaque response establishes transport reachability only, not HTTP status or proxy authentication.
    await fetchFn(`https://${server}/`, { mode: 'no-cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal });
    return { status: 'reachable', latency: Math.max(1, Math.round(now() - start)), checkedAt: Date.now() };
  } catch {
    if (signal?.aborted) return null;
    return { status: 'unreachable', latency: null, checkedAt: Date.now() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

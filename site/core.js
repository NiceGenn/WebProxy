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
export function selectProxies(proxies, { search = '', filter = 'all', sort = 'default' } = {}) {
  const rows = proxies.filter(p => p.server.includes(search.toLowerCase().trim()) && (filter === 'all' || p.status === filter));
  if (sort === 'latency') rows.sort((a, b) => (a.status === 'reachable' ? a.latency : Infinity) - (b.status === 'reachable' ? b.latency : Infinity));
  if (sort === 'name') rows.sort((a, b) => a.server.localeCompare(b.server));
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

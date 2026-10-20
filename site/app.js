import { DEFAULT_PROXIES } from './proxies.js?v=20261020-6';
import { parseLink, proxyLink, telegramLink, selectProxies, probe, formatAddedDate } from './core.js?v=20261020-6';

const $ = selector => document.querySelector(selector);
const STORAGE_KEY = 'webproxy-monitor-v1';
const keyOf = p => `${p.server}\u0000${p.secret}`;
const DEFAULT_ADDED_AT = '2026-10-13T12:02:57Z';
let saved = {};
try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { /* Storage may be unavailable. */ }
const custom = [];
for (const item of (Array.isArray(saved.custom) ? saved.custom.slice(0, 68) : [])) {
  try {
    const parsed = parseLink(proxyLink(item));
    if (!DEFAULT_PROXIES.some(p => keyOf(p) === keyOf(parsed)) && !custom.some(p => keyOf(p) === keyOf(parsed))) custom.push({ ...parsed, addedAt: formatAddedDate(item.addedAt) ? item.addedAt : null });
  } catch { /* Ignore malformed storage entries. */ }
}
const proxies = [...DEFAULT_PROXIES.map(p => ({ ...p, addedAt: DEFAULT_ADDED_AT })), ...custom].map(p => {
  const result = saved.results?.[p.server];
  const valid = result && ['reachable', 'unreachable'].includes(result.status) && Number.isFinite(result.checkedAt) && (result.status !== 'reachable' || (Number.isFinite(result.latency) && result.latency > 0));
  return { ...p, status: valid ? result.status : 'unknown', latency: valid ? result.latency : null, checkedAt: valid ? result.checkedAt : null, history: Array.isArray(result?.history) ? result.history.filter(h => ['reachable', 'unreachable'].includes(h)).slice(-12) : [] };
});
let collectionStatus = 'Источник: резервный список';
let filter = 'all';
let sort = 'default';
let direction = 'asc';
let running = false;
let roundController;
let completed = 0;
let toastTimer;
let lastFinished = Number.isFinite(saved.lastFinished) ? saved.lastFinished : null;
const labels = { reachable: 'Ответ получен', unreachable: 'Нет ответа', unknown: 'Не проверен', checking: 'Проверяем' };

function notify(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3500);
}
function persist() {
  const results = {};
  for (const p of proxies) if (p.status !== 'checking' && p.checkedAt) results[p.server] = { status: p.status, latency: p.latency, checkedAt: p.checkedAt, history: p.history };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ custom, results, lastFinished })); } catch { notify('Хранилище браузера недоступно. Данные останутся до закрытия вкладки.'); }
}
function visibleRows() { return selectProxies(proxies, { search: $('#search').value, filter, sort, direction }); }
function render() {
  $('#sort').value = sort + (direction === 'desc' ? '-desc' : '');
  for (const button of document.querySelectorAll('.column-sort')) {
    const active = button.dataset.sort === sort;
    button.closest('th').setAttribute('aria-sort', active ? direction === 'asc' ? 'ascending' : 'descending' : 'none');
    button.querySelector('.sort-indicator').textContent = active ? direction === 'asc' ? '↑' : '↓' : '↕';
    const nextDirection = active && direction === 'asc' ? 'убыванию' : 'возрастанию';
    const label = `Сортировать: ${button.dataset.label}, по ${nextDirection}`;
    button.setAttribute('aria-label', label);
    button.title = label;
  }
  const visible = visibleRows();
  const fragment = document.createDocumentFragment();
  for (const p of visible) {
    const row = document.createElement('tr');
    row.innerHTML = `<td class="number"></td><td><div class="server-cell"><span class="server-avatar"><svg><use href="#i-globe"/></svg></span><div class="server-details"><span class="server-name"></span><span class="server-added"></span></div></div></td><td><span class="status"><span class="dot"></span><span class="status-label"></span></span></td><td class="latency"></td><td class="history-cell"><div class="history"></div></td><td class="actions-cell"><div class="row-actions"><button class="copy-button"><svg><use href="#i-copy"/></svg></button><button type="button" class="connect-button">Подключить <svg><use href="#i-arrow"/></svg></button></div></td>`;
    row.querySelector('.number').textContent = String(proxies.indexOf(p) + 1).padStart(2, '0');
    row.querySelector('.server-name').textContent = p.server;
    const addedDate = formatAddedDate(p.addedAt);
    row.querySelector('.server-added').textContent = addedDate ? `Добавлен: ${addedDate}` : 'Дата добавления не сохранена';
    const status = row.querySelector('.status');
    status.classList.add(p.status);
    status.title = p.checkedAt ? `Последняя проверка: ${new Date(p.checkedAt).toLocaleString('ru-RU')}` : 'Нажмите «Проверить серверы»';
    row.querySelector('.status-label').textContent = labels[p.status];
    const latency = row.querySelector('.latency');
    latency.textContent = p.status === 'reachable' ? p.latency.toLocaleString('ru-RU') : '—';
    if (p.status === 'reachable') {
      const unit = document.createElement('span'); unit.textContent = 'мс'; latency.append(unit);
    }
    const history = row.querySelector('.history');
    history.setAttribute('role', 'img');
    history.setAttribute('aria-label', `История: ${p.history.length} проверок, с ответом ${p.history.filter(h => h === 'reachable').length}`);
    for (const value of [...Array(12 - p.history.length).fill('unknown'), ...p.history]) {
      const bar = document.createElement('span'); bar.className = `history-bar ${value}`; bar.title = value === 'unknown' ? 'Нет данных' : labels[value]; history.append(bar);
    }
    const connect = row.querySelector('.connect-button');
    connect.addEventListener('click', () => showConnection(p));
    connect.setAttribute('aria-label', `Подключить ${p.server} в Telegram`);
    const copy = row.querySelector('.copy-button');
    copy.setAttribute('aria-label', `Скопировать ссылку ${p.server}`);
    copy.title = 'Скопировать ссылку';
    copy.addEventListener('click', () => copyLink(p));
    fragment.append(row);
  }
  $('#rows').replaceChildren(fragment);
  $('#empty').hidden = visible.length !== 0;
  $('#shown-count').textContent = `Показано ${visible.length} из ${proxies.length}`;
  for (const id of ['#total-count', '#heading-count', '#tab-all', '#network-count']) $(id).textContent = proxies.length;
  const reachable = proxies.filter(p => p.status === 'reachable');
  const unreachable = proxies.filter(p => p.status === 'unreachable');
  const hasChecks = proxies.some(p => p.checkedAt);
  $('#reachable-count').textContent = hasChecks ? reachable.length : '—';
  $('#unreachable-count').textContent = hasChecks ? unreachable.length : '—';
  $('#average').replaceChildren(document.createTextNode(reachable.length ? Math.round(reachable.reduce((sum, p) => sum + p.latency, 0) / reachable.length).toLocaleString('ru-RU') + ' ' : '— '));
  const unit = document.createElement('small'); unit.textContent = 'мс'; $('#average').append(unit);
  $('#last-check').textContent = running ? `Проверено ${completed} / ${proxies.length}` : lastFinished ? `Проверка: ${new Date(lastFinished).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}` : 'Ещё не проверяли';
  $('#collection-status').textContent = collectionStatus;
  $('#check-all span').textContent = running ? 'Остановить проверку' : 'Проверить серверы';
  $('#check-all').setAttribute('aria-busy', String(running));
}
let selectedConnection;
function showConnection(p) {
  selectedConnection = p;
  $('#connection-server').textContent = p.server;
  $('#connection-secret').textContent = p.secret;
  $('#telegram-command').value = telegramLink(p);
  $('#connection-dialog').showModal();
}
$('#launch-telegram').addEventListener('click', () => {
  if (!selectedConnection) return;
  try {
    // Navigate directly during the user gesture; do not pass a tg: anchor through link-click handlers.
    window.location.assign(telegramLink(selectedConnection));
  } catch {
    notify('Браузер заблокировал запуск. Скопируйте прямую ссылку и откройте её через Win+R.');
  }
});
$('#connection-copy').addEventListener('click', () => { if (selectedConnection) copyText(telegramLink(selectedConnection), 'Прямая ссылка tg:// скопирована'); });
$('#telegram-command').addEventListener('click', event => event.target.select());
async function copyLink(p) {
  return copyText(proxyLink(p), 'Ссылка для чата скопирована');
}
async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); notify(message); }
  catch {
    // Fallback is useful for local HTTP or restricted clipboard access.
    const area = document.createElement('textarea'); area.value = text; area.style.position = 'fixed'; area.style.opacity = '0'; document.body.append(area); area.select();
    const copied = document.execCommand('copy'); area.remove(); notify(copied ? message : 'Копирование недоступно. Выделите и скопируйте прямую ссылку в окне подключения.');
  }
}
async function checkAll() {
  if (running) { roundController.abort(); return; }
  running = true; completed = 0;
  roundController = new AbortController();
  const signal = roundController.signal;
  const pending = [...proxies];
  $('#progress-bar').style.width = '0%';
  render();
  async function worker() {
    while (pending.length && !signal.aborted) {
      const p = pending.shift();
      const previous = p.status;
      p.status = 'checking'; render();
      const result = await probe(p.server, { signal });
      if (!result) { p.status = previous; render(); break; }
      Object.assign(p, result);
      p.history = [...p.history, result.status].slice(-12);
      completed++;
      $('#progress-bar').style.width = `${completed / proxies.length * 100}%`;
      render();
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
  running = false;
  if (!signal.aborted) lastFinished = Date.now();
  persist(); render();
  notify(signal.aborted ? 'Проверка остановлена. Полученные результаты сохранены.' : `Проверка завершена: ответили ${proxies.filter(p => p.status === 'reachable').length} из ${proxies.length}`);
}
$('#check-all').addEventListener('click', checkAll);
$('#search').addEventListener('input', render);
$('#sort').addEventListener('change', () => {
  const selection = $('#sort').value;
  direction = selection.endsWith('-desc') ? 'desc' : 'asc';
  sort = direction === 'desc' ? selection.slice(0, -5) : selection;
  render();
});
for (const button of document.querySelectorAll('.column-sort')) button.addEventListener('click', () => {
  direction = sort === button.dataset.sort && direction === 'asc' ? 'desc' : 'asc';
  sort = button.dataset.sort;
  render();
});
for (const tab of document.querySelectorAll('.tab')) tab.addEventListener('click', () => {
  filter = tab.dataset.filter;
  for (const other of document.querySelectorAll('.tab')) { const active = other === tab; other.classList.toggle('active', active); other.setAttribute('aria-pressed', String(active)); }
  render();
});
$('#auto').addEventListener('change', () => { if ($('#auto').checked && !running) checkAll(); });
setInterval(() => { if ($('#auto').checked && !running && !document.hidden) checkAll(); }, 60000);
document.addEventListener('visibilitychange', () => { if (document.hidden && $('#auto').checked && running) roundController.abort(); });
$('#export').addEventListener('click', () => {
  const rows = visibleRows();
  if (!rows.length) { notify('Нет ссылок для экспорта'); return; }
  const url = URL.createObjectURL(new Blob([rows.map(proxyLink).join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = 'webproxy-links.txt'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(`Экспортировано ссылок: ${rows.length}`);
});
$('#about-open').addEventListener('click', () => $('#about-dialog').showModal());
$('#add-open').addEventListener('click', () => { $('#add-error').textContent = ''; $('#add-dialog').showModal(); });
for (const button of document.querySelectorAll('.close-dialog')) button.addEventListener('click', () => button.closest('dialog').close());
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
$('#add-form').addEventListener('submit', event => {
  event.preventDefault();
  if (running) { $('#add-error').textContent = 'Дождитесь завершения проверки или остановите её.'; return; }
  const lines = $('#links').value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const parsed = [];
  try {
    for (let i = 0; i < lines.length; i++) {
      let p; try { p = parseLink(lines[i]); } catch (error) { throw new Error(`Строка ${i + 1}: ${error.message}`); }
      if (!proxies.some(old => keyOf(old) === keyOf(p)) && !parsed.some(old => keyOf(old) === keyOf(p))) parsed.push({ ...p, addedAt: new Date().toISOString() });
    }
    if (proxies.length + parsed.length > 100) throw new Error('Можно хранить не больше 100 серверов.');
    if (!parsed.length) throw new Error('Новых серверов нет: эти домены уже в списке.');
  } catch (error) { $('#add-error').textContent = error.message; return; }
  custom.push(...parsed);
  proxies.push(...parsed.map(p => ({ ...p, status: 'unknown', latency: null, checkedAt: null, history: [] })));
  persist(); render(); $('#links').value = ''; $('#add-dialog').close(); notify(`Добавлено серверов: ${parsed.length}`);
});
render();
async function loadCollected() {
  try {
    const response = await fetch('./webproxy.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP');
    const data = await response.json();
    if (data.schema_version !== 1 || !Array.isArray(data.proxies) || !Number.isFinite(Date.parse(data.collected_at))) throw new Error('Invalid data');
    const seen = new Set(proxies.map(keyOf));
    let added = 0;
    for (const item of data.proxies) {
      try {
        const parsed = parseLink(proxyLink(item));
        if (seen.has(keyOf(parsed))) continue;
        seen.add(keyOf(parsed));
        const result = saved.results?.[parsed.server];
        const valid = result && ['reachable', 'unreachable'].includes(result.status) && Number.isFinite(result.checkedAt) && (result.status !== 'reachable' || (Number.isFinite(result.latency) && result.latency > 0));
        proxies.push({ ...parsed, addedAt: formatAddedDate(item.first_seen) ? item.first_seen : null, status: valid ? result.status : 'unknown', latency: valid ? result.latency : null, checkedAt: valid ? result.checkedAt : null, history: Array.isArray(result?.history) ? result.history.filter(h => ['reachable', 'unreachable'].includes(h)).slice(-12) : [] });
        added++;
      } catch { /* Invalid remote entry cannot affect the fallback list. */ }
    }
    collectionStatus = `Последний успешный опубликованный сбор: ${new Date(data.collected_at).toLocaleString('ru-RU')} · Добавлено из канала: ${added}`;
  } catch {
    collectionStatus = 'Источник: резервный список · обновления недоступны';
  }
  render();
}
loadCollected();

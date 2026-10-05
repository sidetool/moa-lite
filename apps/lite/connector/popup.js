// SPDX-License-Identifier: GPL-3.0-or-later
import { appOrigin, sourceUrl } from './policy.js';
const api = globalThis.browser ?? chrome;
const $ = id => document.getElementById(id);
// The same page runs as the toolbar popup and as the tab opened right after install.
const page = location.pathname.endsWith('setup.html');
if (page) document.body.classList.add('page');
let current, saved, editing = false;
const originOf = url => { try { const value = new URL(url); return ['http:', 'https:'].includes(value.protocol) ? value.origin : undefined; } catch { return undefined; } };
function button(text, className, onclick) { const element = document.createElement('button'); element.type = 'button'; element.textContent = text; if (className) element.className = className; element.onclick = onclick; return element; }
async function candidates() {
  // Popup: the active tab first. Setup tab: recently used http(s) tabs (the app tab the ZIP came from is usually first).
  const tabs = await api.tabs.query(page ? {} : { active: true, currentWindow: true });
  const list = [];
  for (const tab of tabs.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))) {
    const origin = originOf(tab.url);
    if (!origin || list.some(item => item.origin === origin)) continue;
    try { appOrigin(origin); } catch { continue; }
    list.push({ origin, title: tab.title ?? '' });
  }
  return list.slice(0, page ? 3 : 1);
}
async function render() {
  const { appOrigin: origin, loginOrigins = [] } = await api.storage.local.get(['appOrigin', 'loginOrigins']);
  saved = origin;
  const [tab] = page ? [] : await api.tabs.query({ active: true, currentWindow: true });
  current = originOf(tab?.url);
  const setup = !origin || editing;
  $('setup').hidden = !setup;
  $('connected').hidden = setup;
  $('cancel-edit').hidden = !(origin && editing);
  $('heading').textContent = setup ? 'moa-lite 앱 주소 연결' : 'moa-lite 연결 확장';
  if (setup) {
    const list = await candidates();
    $('candidates-wrap').hidden = !list.length;
    $('divider').hidden = !list.length;
    $('candidates').replaceChildren(...list.map((item, index) => {
      const row = document.createElement('div'), name = document.createElement('span'), title = document.createElement('em');
      row.className = 'candidate'; name.textContent = item.origin.replace(/^https?:\/\//, ''); title.textContent = item.title; if (item.title) name.append(title);
      row.append(name, button(item.origin === saved ? '현재 주소' : '이 주소로 연결', index === 0 ? 'primary' : '', () => save(item.origin)));
      return row;
    }));
  }
  $('app-origin').textContent = origin?.replace(/^https?:\/\//, '') ?? '';
  const open = (await api.tabs.query({})).some(item => originOf(item.url) === origin);
  $('connection-status').textContent = open ? '앱 탭에 연결됨' : '앱 탭이 열려 있지 않아요';
  $('connection-dot').className = open ? 'dot ok' : 'dot';
  $('connected-card').className = open ? 'card ok' : 'card';
  const permitted = await api.permissions.contains({ origins: ['https://*/*'] });
  $('grant-permission').hidden = permitted;
  if (!permitted) $('status').textContent = '사이트 접근 권한이 꺼져 있어요. 권한을 허용해야 소스를 연결할 수 있어요.';
  $('login-section').hidden = !origin || setup;
  let loginSite; try { if (current && current !== origin) loginSite = sourceUrl(current).origin; } catch {}
  $('login-toggle-label').hidden = !loginSite;
  $('login-origin').textContent = loginSite?.replace(/^https?:\/\//, '') ?? '';
  $('login-toggle').checked = loginOrigins.includes(loginSite);
  $('login-sites').replaceChildren(...loginOrigins.map(site => {
    const li = document.createElement('li'), name = document.createElement('span'); name.textContent = site.replace(/^https?:\/\//, '');
    li.append(name, button('로그인 탭', 'text', () => api.runtime.sendMessage({ type: 'open-auth', origin: site }).then(result => { if (result?.error) $('status').textContent = '로그인 탭을 열지 못했어요.'; })), button('삭제', 'text', () => setLogin(site, false)));
    return li;
  }));
}
async function save(value) {
  try {
    const origin = appOrigin(value.trim());
    await api.storage.local.set({ appOrigin: origin });
    editing = false; $('status').textContent = '';
    await render();
    if (page) { const [app] = (await api.tabs.query({})).filter(item => originOf(item.url) === origin); if (app?.id !== undefined) { await api.tabs.update(app.id, { active: true }); window.close(); } }
  } catch { $('status').textContent = 'https://로 시작하는 주소를 경로 없이 입력해 주세요. 로컬 주소만 http를 쓸 수 있어요.'; }
}
async function setLogin(origin, enabled) {
  const { loginOrigins = [], authTabs = {} } = await api.storage.local.get(['loginOrigins', 'authTabs']);
  if (!enabled) delete authTabs[origin];
  await api.storage.local.set({ loginOrigins: enabled ? [...new Set([...loginOrigins, sourceUrl(origin).origin])] : loginOrigins.filter(item => item !== origin), authTabs });
  await render();
}
$('address-form').onsubmit = event => { event.preventDefault(); void save($('address').value); };
$('use-current').onclick = () => save(current);
$('change-address').onclick = () => { editing = true; $('address').value = saved ?? ''; void render(); };
$('cancel-edit').onclick = () => { editing = false; void render(); };
$('open-app').onclick = async () => { const [app] = (await api.tabs.query({})).filter(item => originOf(item.url) === saved); if (app?.id !== undefined) await api.tabs.update(app.id, { active: true }); else await api.tabs.create({ url: saved }); window.close(); };
$('login-toggle').onchange = () => setLogin(current, $('login-toggle').checked);
$('grant-permission').onclick = () => { api.permissions.request({ origins: ['https://*/*'] }).then(() => { $('status').textContent = ''; return render(); }).catch(() => { $('status').textContent = '권한을 허용하지 못했어요.'; }); };
render().catch(() => { $('status').textContent = '설정을 읽지 못했어요.'; });

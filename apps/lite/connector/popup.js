// SPDX-License-Identifier: GPL-3.0-or-later
import { appOrigin, sourceUrl } from './policy.js';
const api = globalThis.browser ?? chrome;
const $ = id => document.getElementById(id);
let current, saved, editing = false;
async function render() {
  const { appOrigin: origin, loginOrigins = [] } = await api.storage.local.get(['appOrigin', 'loginOrigins']);
  saved = origin;
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  current = undefined;
  try { const url = new URL(tab.url); if (['http:', 'https:'].includes(url.protocol)) current = url.origin; } catch {}
  $('setup').hidden = !!origin && !editing;
  $('connected').hidden = !origin || editing;
  $('heading').textContent = origin && !editing ? 'moa-lite 앱 연결' : 'moa-lite 앱 주소 연결';
  $('current-origin').textContent = current ?? '';
  $('use-current').hidden = !current;
  $('app-origin').textContent = origin ?? '';
  const tabs = await api.tabs.query({});
  $('connection-status').textContent = tabs.some(tab => { try { return new URL(tab.url).origin === origin; } catch { return false; } }) ? '앱 탭 연결됨' : '앱 탭 없음';
  const permitted = await api.permissions.contains({ origins: ['https://*/*'] });
  $('grant-permission').hidden = permitted;
  if (!permitted) $('status').textContent = '사이트 접근 권한이 없습니다. 권한을 허용하세요. (host_permission_missing)';
  $('login-section').hidden = !origin;
  let loginSite; try { if (current !== origin) loginSite = sourceUrl(current).origin; } catch {}
  $('login-toggle-label').hidden = !loginSite;
  $('login-origin').textContent = loginSite ?? '';
  $('login-toggle').checked = loginOrigins.includes(loginSite);
  $('login-sites').replaceChildren();
  for (const site of loginOrigins) {
    const li = document.createElement('li'), name = document.createElement('span'); name.textContent = site; li.append(name);
    const remove = document.createElement('button'); remove.textContent = '삭제'; remove.onclick = () => setLogin(site, false); li.append(remove);
    const open = document.createElement('button'); open.textContent = '원본 로그인 탭';
    open.onclick = () => api.runtime.sendMessage({ type: 'open-auth', origin: site }).then(result => { if (result?.error) $('status').textContent = '로그인 탭을 열지 못했습니다.'; }); li.append(open);
    $('login-sites').append(li);
  }
}
async function save(value) {
  try { const origin = appOrigin(value.trim()); await api.storage.local.set({ appOrigin: origin }); editing = false; $('status').textContent = '주소를 저장했습니다.'; await render(); }
  catch { $('status').textContent = '경로와 끝 슬래시 없이 HTTPS 주소를 입력하세요. 로컬 주소만 HTTP를 사용할 수 있습니다.'; }
}
async function setLogin(origin, enabled) {
  const { loginOrigins = [], authTabs = {} } = await api.storage.local.get(['loginOrigins', 'authTabs']);
  if (!enabled) delete authTabs[origin];
  await api.storage.local.set({ loginOrigins: enabled ? [...new Set([...loginOrigins, sourceUrl(origin).origin])] : loginOrigins.filter(item => item !== origin), authTabs });
  await render();
}
$('address-form').onsubmit = event => { event.preventDefault(); void save($('address').value); };
$('use-current').onclick = () => save(current);
$('change-address').onclick = () => { editing = true; $('address').value = saved; void render(); };
$('open-app').onclick = () => api.tabs.create({ url: saved });
$('login-toggle').onchange = () => setLogin(current, $('login-toggle').checked);
$('grant-permission').onclick = () => { api.permissions.request({ origins: ['https://*/*'] }).then(() => { $('status').textContent = ''; return render(); }).catch(() => { $('status').textContent = '권한을 허용하지 못했습니다.'; }); };
render().catch(() => { $('status').textContent = '설정을 읽지 못했습니다.'; });

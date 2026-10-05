// SPDX-License-Identifier: GPL-3.0-or-later
const api = globalThis.browser ?? chrome;
const status = document.querySelector('#status');
async function render() {
  const { pending = {} } = await api.storage.local.get('pending');
  const origins = Object.keys(pending);
  const root = document.querySelector('#sites'); root.replaceChildren();
  if (!origins.length) {
    const empty = document.createElement('p');
    empty.textContent = '아직 연결을 요청한 사이트가 없습니다. 리더에서 소스를 열면 필요한 사이트가 여기에 표시됩니다.';
    root.append(empty);
  }
  for (const origin of origins) {
    const row = document.createElement('section'), name = document.createElement('div'); name.textContent = origin; row.append(name);
    const allowed = await api.permissions.contains({ origins: [origin + '/*'] });
    if (pending[origin]?.denied) { const note = document.createElement('small'); note.textContent = '접근이 거부됐습니다. 원본 사이트 접속을 확인하세요.'; row.append(note); }
    const button = document.createElement('button'); button.textContent = allowed ? '허용 취소' : '사이트 허용';
    button.onclick = () => {
      // Must start synchronously in the actual popup user gesture (Safari/Firefox requirement).
      const operation = allowed ? api.permissions.remove({ origins: [origin + '/*'] }) : api.permissions.request({ origins: [origin + '/*'] });
      operation.then(() => render()).catch(error => { status.textContent = '권한을 변경하지 못했습니다.'; });
    };
    row.append(button);
    if (allowed) {
      const open = document.createElement('button'); open.textContent = '사이트 열기';
      open.onclick = () => api.runtime.sendMessage({ type: 'open-auth', origin }).then(result => { if (result?.error) status.textContent = '사이트를 열지 못했습니다.'; });
      row.append(open);
    }
    root.append(row);
  }
}
render().catch(() => { status.textContent = '설정을 읽지 못했습니다.'; });

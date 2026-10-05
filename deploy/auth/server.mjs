import http from 'node:http';
import { openState, setupCode } from './state.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { migrateAccounts, accountsService, fail, transaction } from './accounts.mjs';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DAY = 86400000;
const PREFIX = '/__moa/';
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => {
  const left = Buffer.from(a ?? '');
  const right = Buffer.from(b ?? '');
  return left.length === right.length && timingSafeEqual(left, right);
};
const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createAuthServer({ credentials, database, origin, allowedOrigins = [origin], secure = true, allowAnyHost = false, trustProxy = false, connectorSecretFile, now = Date.now, serverless = false }) {
  const context = new AsyncLocalStorage();
  const isSecure = () => context.getStore()?.secure ?? secure;
  const cookieName = kind => `${isSecure() ? '__Host-' : ''}moa_${kind}`;
  const requestOrigin = req => {
    const host = req.headers.host;
    if (typeof host !== 'string' || !/^[a-zA-Z0-9.:[\]-]+$/.test(host)) return null;
    try { const url = new URL(`${isSecure() ? 'https' : 'http'}://${host}`); return url.host === host.toLowerCase() ? url.origin : null; } catch { return null; }
  };
  const cookieValue = (req, kind) => cookies(req)[cookieName(kind)] ?? cookies(req)[`${isSecure() ? '' : '__Host-'}moa_${kind}`];
  const publicUrl = new URL(origin);
  const origins = new Set([publicUrl.origin, ...allowedOrigins.map(value => new URL(value).origin)]);
  const hosts = new Set([...origins].map(value => new URL(value).host));
  const template = readFileSync(new URL('./login.html', import.meta.url), 'utf8');
  const setupTemplate = readFileSync(new URL('./setup.html', import.meta.url), 'utf8');
  const joinTemplate = readFileSync(new URL('./join.html', import.meta.url), 'utf8');
  const assets = new Map(['login.css', 'login.js', 'icon.svg'].map(name => [name, readFileSync(new URL(`./${name}`, import.meta.url))]));
  migrateAccounts(database, credentials, now);
  setupCode(database);
  const needsSetup = () => !database.prepare('SELECT 1 FROM accounts LIMIT 1').get();
  const accounts = accountsService(database, publicUrl.origin, now);
  database.prepare('DELETE FROM sessions WHERE expires <= ?').run(now());
  const findSession = database.prepare(`SELECT s.*,a.id,a.username,a.role,a.salt,a.hash FROM sessions s JOIN accounts a ON a.id=s.account_id
    WHERE token_hash=? AND expires>? AND a.disabled=0`);
  const rates = new Map();
  let verifying = 0;

  function cookie(name, value, maxAge) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax${isSecure() ? '; Secure' : ''}${maxAge == null ? '' : `; Max-Age=${maxAge}`}`;
  }
  function cookies(req) {
    return Object.fromEntries((req.headers.cookie ?? '').split(';').map(item => {
      const index = item.indexOf('=');
      return index < 0 ? [] : [item.slice(0, index).trim(), item.slice(index + 1).trim()];
    }).filter(pair => pair.length === 2));
  }
  function session(req) {
    const token = cookieValue(req, 'session');
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return findSession.get(hash(token), now()) ?? null;
  }
  function target(value) {
    if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || value.startsWith('//') || /[\\\x00-\x1f]/.test(value)) return '/';
    const url = new URL(value, publicUrl);
    if (url.origin !== publicUrl.origin || url.pathname.startsWith(PREFIX)) return '/';
    return url.pathname + url.search + url.hash;
  }
  function csrfToken() {
    const payload = `${now()}.${randomBytes(24).toString('base64url')}`;
    return `${payload}.${createHmac('sha256', credentials.csrfSecret).update(payload).digest('base64url')}`;
  }
  function csrfFailure(req, form) {
    const token = form.get('csrf');
    if (!token) return 'L01';
    const stored = cookieValue(req, 'csrf');
    if (!stored) return 'L02';
    if (!equal(token, stored)) return 'L03';
    const parts = token.split('.');
    if (parts.length !== 3 || !/^\d{13}$/.test(parts[0])) return 'L04';
    const age = now() - Number(parts[0]);
    if (age < 0 || age >= 3600000) return 'L05';
    const expected = createHmac('sha256', credentials.csrfSecret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    if (!equal(expected, parts[2])) return 'L04';
    const requestOrigin = req.headers.origin;
    const sameOrigin = !requestOrigin || requestOrigin === context.getStore()?.origin;
    return sameOrigin ? null : 'L06';
  }
  function validCsrf(req, form) { return csrfFailure(req, form) === null; }
  function loginDiagnostic(req, code) {
    // Never record credentials, cookies, CSRF values, account names or full request URLs.
    const ua = req.headers['user-agent'] || '';
    const chromium = ua.match(/(?:Chrome|Chromium)\/(\d+)/)?.[1];
    const tizen = ua.match(/Tizen[ /]([\d.]+)/i)?.[1];
    console.info(JSON.stringify({event:'login-result', code, tv:/SMART-TV|Tizen|Web0S|WebOS/i.test(ua), chromium, tizen}));
  }
  function send(res, code, body = '', headers = {}) {
    res.writeHead(code, {
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy': "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'Content-Type': 'text/html; charset=utf-8',
      ...headers,
    });
    res.end(body);
  }
  function redirect(res, path, headers = {}) {
    send(res, 303, '', { Location: path, ...headers });
  }
  function page(res, { next = '/', error = '', code = 200, account = null, joining = false, settingUp = false, errorCode = '', inviteCode = '', username = '' } = {}) {
    const csrf = csrfToken();
    const fields = {
      ERROR_CODE: errorCode, CODE: inviteCode, CSRF: csrf, NEXT: target(next), ERROR: error,
      USERNAME: account?.username ?? username,
      TITLE: account ? '로그인한 브라우저' : 'MOA에 로그인',
      DESCRIPTION: account ? '이 브라우저의 로그인 상태를 관리하세요.' : '기존 아이디와 비밀번호로 접속하세요.',
      LOGIN_HIDDEN: account ? 'hidden' : '', ACCOUNT_HIDDEN: account ? '' : 'hidden',
    };
    const html = (settingUp ? setupTemplate : joining ? joinTemplate : template).replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => escapeHtml(fields[key] ?? ''));
    send(res, code, html, { 'Set-Cookie': cookie(cookieName('csrf'), csrf, 3600) });
  }
  async function body(req, json = false) {
    if ((req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== (json ? 'application/json' : 'application/x-www-form-urlencoded')) throw Object.assign(new Error('form'), { status: 415 });
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8192) throw Object.assign(new Error('body'), { status: 413 });
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    if (!json) return new URLSearchParams(text);
    try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid-request'); return value; }
    catch { fail(400, 'invalid-request'); }
  }

  function rateLimit(req) {
    const ip = req.headers['x-real-ip'] ?? req.socket.remoteAddress;
    let rate = rates.get(ip);
    if (!rate || now() >= rate.until) { rate = { count: 0, until: now() + 15 * 60000 }; rates.set(ip, rate); }
    if (rate.count >= 8 || verifying >= 4) fail(429, 'too-many-attempts');
    rate.count++;
    return ip;
  }
  function issueSession(req, res, user, next, remember) {
    const token = transaction(database, () => {
      const current = accounts.get(user.id);
      if (!current || current.disabled || current.hash !== user.hash) fail(401, 'login-required');
      const old = session(req);
      if (old) database.prepare('DELETE FROM sessions WHERE token_hash=?').run(old.token_hash);
      const token = randomBytes(32).toString('base64url');
      database.prepare('INSERT INTO sessions VALUES(?,?,?,?,?)').run(hash(token), user.id, now() + (remember ? 365 * DAY : DAY / 2), now(), Number(remember));
      database.prepare('UPDATE accounts SET last_login_at=? WHERE id=?').run(now(), user.id);
      return token;
    });
    return redirect(res, `${PREFIX}continue?next=${encodeURIComponent(target(next))}`, { 'Set-Cookie': [cookie(cookieName('session'), token, remember ? 365 * 86400 : null), cookie(cookieName('csrf'), '', 0)] });
  }

  const handle = (req, res) => context.run({ secure: trustProxy ? req.headers['x-forwarded-proto'] === 'https' : secure }, async () => {
    try {
      const url = new URL(req.url, publicUrl);
      if (url.pathname === '/healthz' && req.method === 'GET') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
      if (url.pathname === '/internal/remote-access-safety' && connectorSecretFile && req.method === 'GET') {
        const secret = readFileSync(connectorSecretFile, 'utf8').trim();
        if (!secret || !equal(req.headers.authorization, `Bearer ${secret}`)) return send(res, 401);
        return send(res, 200, JSON.stringify({ adminExists: !!database.prepare("SELECT 1 FROM accounts WHERE role='admin' AND disabled=0 LIMIT 1").get() }), { 'Content-Type': 'application/json' });
      }
      context.getStore().origin = requestOrigin(req);
      if (!context.getStore().origin || (!trustProxy && !allowAnyHost && !hosts.has(req.headers.host))) return send(res, 400, '잘못된 접속 주소입니다.');
      if (url.pathname === `${PREFIX}check` && req.method === 'GET') {
        const current = session(req);
        if (!current) return send(res, 401);
        const headers = { 'X-Moa-Account': current.id, 'X-Moa-Role': current.role, 'X-Moa-Username': encodeURIComponent(current.username) };
        if (current.remember && now() - current.refreshed >= DAY) {
          database.prepare('UPDATE sessions SET expires = ?, refreshed = ? WHERE token_hash = ?').run(now() + 365 * DAY, now(), current.token_hash);
          headers['Set-Cookie'] = cookie(cookieName('session'), cookieValue(req, 'session'), 365 * 86400);
        }
        return send(res, 204, '', headers);
      }
      if (url.pathname.startsWith(`${PREFIX}api/`)) {
        let current = session(req);
        if (!current) fail(401, 'login-required');
        let data = {};
        if (!['GET', 'HEAD'].includes(req.method)) {
          if (req.headers['x-moa-request'] !== '1' || req.headers.origin !== context.getStore()?.origin) fail(403, 'csrf-required');
          data = await body(req, true);
          // Body arrival can overlap a disable, role change, reset or logout.
          current = session(req);
          if (!current) fail(401, 'login-required');
        }
        const path = url.pathname.slice(`${PREFIX}api/`.length);
        if (path === 'logout' && req.method === 'POST') {
          database.prepare('DELETE FROM sessions WHERE token_hash=?').run(current.token_hash);
          return send(res, 204, '', { 'Set-Cookie': cookie(cookieName('session'), '', 0) });
        }
        const expensive = req.method === 'POST' && (path === 'password' || path.endsWith('/reset-password'));
        if (expensive) { rateLimit(req); verifying++; }
        let result;
        try { result = await accounts.api(req.method, path, current, data, context.getStore().origin); }
        finally { if (expensive) verifying--; }
        return send(res, result === null ? 204 : path === 'invites' && req.method === 'POST' ? 201 : 200,
          result === null ? '' : JSON.stringify(result), { 'Content-Type': 'application/json; charset=utf-8',
          ...(path === 'password' ? { 'Set-Cookie': cookie(cookieName('session'), '', 0) } : {}) });
      }
      if (url.pathname === `${PREFIX}setup`) {
        if (!needsSetup()) return send(res, 404, '설정이 이미 완료되었습니다.');
        if (req.method === 'GET') return page(res, { settingUp: true });
        if (req.method === 'POST') {
          const form = await body(req);
          const show = (code, errorCode, error) => page(res, { settingUp: true, username: form.get('username') ?? '', code, errorCode, error });
          if (!validCsrf(req, form)) return show(403, 'csrf-required', '설정 화면을 다시 열고 시도해 주세요.');
          try {
            rateLimit(req);
            if (form.get('password') !== form.get('confirm')) fail(400, 'password-mismatch');
            verifying++;
            let user;
            try { user = await accounts.setup(form.get('code'), form.get('username'), form.get('password')); }
            finally { verifying--; }
            return issueSession(req, res, user, '/', form.get('remember') === 'on');
          } catch (error) {
            if (!error.status) throw error;
            if (error.status === 429) res.setHeader('Retry-After', '900');
            const messages = { 'invalid-setup-code': '설정 코드를 확인해 주세요.', 'invalid-username': '아이디는 영문, 숫자, 점, 밑줄, 하이픈 2~32자로 입력하세요.',
              'invalid-password': '비밀번호는 8~1024자로 입력하세요.', 'password-mismatch': '비밀번호 확인이 일치하지 않습니다.',
              'already-set-up': '설정이 이미 완료되었습니다.', 'too-many-attempts': '시도가 너무 많습니다. 15분 후 다시 시도하세요.' };
            return show(error.status, error.message, messages[error.message] ?? '다시 시도해 주세요.');
          }
        }
      }
      if (url.pathname === `${PREFIX}login` && needsSetup()) return redirect(res, `${PREFIX}setup`);
      if (url.pathname === `${PREFIX}join` && req.method === 'GET') return page(res, { joining: true, inviteCode: url.searchParams.get('code') ?? '' });
      if (url.pathname === `${PREFIX}join` && req.method === 'POST') {
        const form = await body(req);
        const show = (code, error) => page(res, { joining: true, inviteCode: form.get('code'), username: form.get('username') ?? '', code, error });
        if (!validCsrf(req, form)) return show(403, '가입 화면을 다시 열고 시도해 주세요.');
        try {
          rateLimit(req);
          if (form.get('password') !== form.get('confirm')) fail(400, 'password-mismatch');
          verifying++;
          let user;
          try { user = await accounts.join(form.get('code'), form.get('username'), form.get('password')); }
          finally { verifying--; }
          return issueSession(req, res, user, '/', form.get('remember') === 'on');
        } catch (error) {
          if (!error.status) throw error;
          const messages = { 'invalid-invite': '초대 코드가 만료되었거나 사용할 수 없습니다.', 'username-taken': '이미 사용 중인 아이디입니다.',
            'invalid-username': '아이디는 영문 소문자, 숫자, 점, 밑줄, 하이픈 2~32자로 입력하세요.', 'invalid-password': '비밀번호는 8~1024자로 입력하세요.',
            'password-mismatch': '비밀번호 확인이 일치하지 않습니다.', 'too-many-attempts': '시도가 너무 많습니다. 15분 후 다시 시도하세요.' };
          return show(error.status, messages[error.message] ?? '다시 시도해 주세요.');
        }
      }
      if (url.pathname === `${PREFIX}required` && req.method === 'GET') {
        const next = target(req.headers['x-original-uri']);
        const isApi = next.startsWith('/api/') || !['GET', 'HEAD'].includes(req.headers['x-original-method'] ?? 'GET');
        if (isApi) return send(res, 401, JSON.stringify({ ok: false, error: 'login-required', loginUrl: `${PREFIX}login` }), { 'Content-Type': 'application/json; charset=utf-8' });
        return redirect(res, `${PREFIX}login?next=${encodeURIComponent(next)}`);
      }
      const asset = url.pathname.slice(PREFIX.length);
      if (req.method === 'GET' && url.pathname.startsWith(PREFIX) && assets.has(asset)) {
        return send(res, 200, assets.get(asset), { 'Content-Type': asset.endsWith('.css') ? 'text/css; charset=utf-8' : asset.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'image/svg+xml' });
      }
      if (url.pathname === `${PREFIX}continue` && req.method === 'GET') {
        const next = target(url.searchParams.get('next'));
        if (session(req)) return redirect(res, next);
        // Verify the browser returned the newly issued cookie before entering the app.
        // Otherwise an apparently successful login silently loops back to the form.
        const reason = cookieValue(req, 'session') ? 'L08' : 'L07';
        loginDiagnostic(req, reason);
        return page(res, { next, code: 403, error: `로그인 상태를 확인하지 못했습니다. 브라우저의 쿠키 허용 설정을 확인하고, 비공개 모드를 끈 뒤 다시 시도해 주세요. (확인 코드: ${reason})` });
      }
      if (url.pathname === `${PREFIX}login` && req.method === 'GET') {
        if (session(req)) return redirect(res, target(url.searchParams.get('next')));
        return page(res, { next: url.searchParams.get('next') });
      }
      if (url.pathname === `${PREFIX}account` && req.method === 'GET') {
        const current = session(req);
        return current ? page(res, { account: current }) : redirect(res, `${PREFIX}login`);
      }
      if (url.pathname === `${PREFIX}login` && req.method === 'POST') {
        const form = await body(req);
        const next = target(form.get('next'));
        const reason = csrfFailure(req, form);
        if (reason) {
          loginDiagnostic(req, reason);
          const hint = reason === 'L02' ? '로그인 확인용 쿠키가 전달되지 않았습니다. 브라우저의 쿠키 허용 설정을 확인해 주세요.' : '로그인 화면을 다시 열고 시도해 주세요.';
          return page(res, { next, code: 403, error: `${hint} (확인 코드: ${reason})` });
        }
        let ip;
        try { ip = rateLimit(req); } catch {
          res.setHeader('Retry-After', '900');
          return page(res, { next, code: 429, error: '시도가 너무 많습니다. 잠시 후 다시 로그인해 주세요.' });
        }
        const username = (form.get('username') ?? '').trim();
        const user = database.prepare('SELECT * FROM accounts WHERE username=?').get(username);
        verifying++;
        let valid;
        try { valid = await accounts.verify(user, form.get('password')); } finally { verifying--; }
        if (!valid) { loginDiagnostic(req, 'credentials'); return page(res, { next, code: 401, error: '아이디 또는 비밀번호를 확인해 주세요.' }); }
        loginDiagnostic(req, 'issued');
        rates.delete(ip);
        return issueSession(req, res, user, next, form.get('remember') === 'on');
      }
      if (url.pathname === `${PREFIX}logout` && req.method === 'POST') {
        const form = await body(req);
        if (!validCsrf(req, form)) return send(res, 403, '로그인 화면을 다시 열어 주세요.');
        const current = session(req);
        if (current) database.prepare('DELETE FROM sessions WHERE token_hash = ?').run(current.token_hash);
        return redirect(res, `${PREFIX}login`, { 'Set-Cookie': [cookie(cookieName('session'), '', 0), cookie(cookieName('csrf'), '', 0)] });
      }
      return send(res, 404, '페이지를 찾을 수 없습니다.');
    } catch (error) {
      if (!res.headersSent) send(res, error.status ?? 500, JSON.stringify({ error: error.status ? error.message : 'internal-error' }), { 'Content-Type': 'application/json; charset=utf-8' });
      else res.destroy();
      if (!error.status) console.error('Authentication request failed:', error.name);
    }
  });
  if (serverless) return { handle };
  const server = http.createServer(handle);
  server.requestTimeout = 15000;
  const cleanup = setInterval(() => {
    database.prepare('DELETE FROM sessions WHERE expires <= ?').run(now());
    for (const [ip, rate] of rates) if (now() >= rate.until) rates.delete(ip);
  }, 60000).unref();
  server.on('close', () => clearInterval(cleanup));
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { database, credentials } = openState();
  const code = setupCode(database);
  if (code) console.log(`\n========== MOA FIRST SETUP ==========\nSetup code: ${code}\nOpen /__moa/setup to create your administrator.\nShow again: docker compose exec moa-auth moa-setup-code\n=====================================\n`);
  const origin = process.env.PUBLIC_ORIGIN || 'http://localhost:8796';
  const server = createAuthServer({ credentials, database, origin, allowAnyHost: !process.env.PUBLIC_ORIGIN,
    secure: new URL(origin).protocol === 'https:',
    trustProxy: process.env.MOA_TRUST_GATEWAY === '1', connectorSecretFile: process.env.MOA_CONNECTOR_SECRET_FILE,
    allowedOrigins: process.env.PUBLIC_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean) });
  server.listen(Number(process.env.PORT ?? 8789), '0.0.0.0', () => console.log('MOA login ready'));
  process.on('SIGTERM', () => server.close(() => { database.close(); process.exit(0); }));
}

// End-to-end verification of the REAL content.js auto-login flow.
// Three scenarios, each proving the flow needs exactly ONE menu pick:
//   A) wizard WITH MFA   username -> next -> password -> next -> OTP -> confirm
//   B) wizard WITHOUT MFA  username -> next -> password -> login
//   C) single form WITHOUT MFA  username+password -> login
// Usage: node scripts/test-auto-login.cjs

const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
];

const CONTENT_JS = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');

function findChrome() {
  for (const candidate of CHROME_PATHS) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome not found');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WIZARD_MFA_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/></head><body>
  <div id="step1">
    <input id="username" name="accountName" type="text" placeholder="请输入账号" autocomplete="username" />
    <button id="next1" type="button">下一步</button>
  </div>
  <div id="step2" style="display:none">
    <input id="password" name="password" type="password" placeholder="请输入密码" autocomplete="current-password" />
    <button id="next2" type="button">下一步</button>
  </div>
  <div id="step3" style="display:none">
    <input id="otp" name="verifyCode" type="text" maxlength="6" placeholder="请输入6位验证码" />
    <button id="login" type="button">登录</button>
  </div>
  <script>
    window.__wizard = { next1: 0, next2: 0, login: 0, loggedIn: false };
    const show = (id) => ['step1','step2','step3'].forEach((s) => { document.getElementById(s).style.display = s === id ? '' : 'none'; });
    document.getElementById('next1').addEventListener('click', () => {
      if (!document.getElementById('username').value) return;
      window.__wizard.next1 += 1; show('step2');
    });
    document.getElementById('next2').addEventListener('click', () => {
      if (!document.getElementById('password').value) return;
      window.__wizard.next2 += 1; show('step3');
    });
    document.getElementById('login').addEventListener('click', () => {
      if (!document.getElementById('otp').value) return;
      window.__wizard.login += 1; window.__wizard.loggedIn = true;
    });
  </script>
</body></html>`;

const WIZARD_NO_MFA_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/></head><body>
  <div id="step1">
    <input id="username" name="accountName" type="text" placeholder="请输入账号" autocomplete="username" />
    <button id="next1" type="button">下一步</button>
  </div>
  <div id="step2" style="display:none">
    <input id="password" name="password" type="password" placeholder="请输入密码" autocomplete="current-password" />
    <button id="loginBtn" type="button">登录</button>
  </div>
  <script>
    window.__wizard = { next1: 0, login: 0, loggedIn: false };
    const show = (id) => ['step1','step2'].forEach((s) => { document.getElementById(s).style.display = s === id ? '' : 'none'; });
    document.getElementById('next1').addEventListener('click', () => {
      if (!document.getElementById('username').value) return;
      window.__wizard.next1 += 1; show('step2');
    });
    document.getElementById('loginBtn').addEventListener('click', () => {
      if (!document.getElementById('password').value) return;
      window.__wizard.login += 1; window.__wizard.loggedIn = true;
    });
  </script>
</body></html>`;

const SINGLE_FORM_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/></head><body>
  <form id="loginForm">
    <input id="username" name="accountName" type="text" placeholder="请输入账号" autocomplete="username" />
    <input id="password" name="password" type="password" placeholder="请输入密码" autocomplete="current-password" />
    <button id="loginBtn" type="button">登录</button>
  </form>
  <script>
    window.__wizard = { login: 0, loggedIn: false };
    document.getElementById('loginBtn').addEventListener('click', () => {
      if (!document.getElementById('username').value || !document.getElementById('password').value) return;
      window.__wizard.login += 1; window.__wizard.loggedIn = true;
    });
  </script>
</body></html>`;

const CHROME_STUB = `
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, callback) => {
        let response = { ok: true };
        if (message && message.type === 'getCredentials') {
          response = { ok: true, payload: { status: 'ok', items: [window.__testItem] } };
        }
        setTimeout(() => callback(response), 0);
      },
      onMessage: { addListener: () => {} },
    },
  };
`;

const withOtps = (count) => ({ totp_code: count ? '123456' : null, totp_remaining_seconds: count ? 20 : null });
const baseItem = () => ({ id: 'test-1', title: '测试账号', username: 'zhangcy', password: 'Secret!123' });

async function runScenario(browser, route, html, item, verify, shouldHaveMfa) {
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[FlyPassword]')) logs.push(text);
  });
  page.on('pageerror', (err) => logs.push(`[PAGEERROR] ${err.message}`));
  await page.goto(`http://127.0.0.1:8977${route}`, { waitUntil: 'networkidle0' });
  await page.evaluate(CHROME_STUB);
  await page.evaluate((item) => {
    window.__testItem = item;
  }, item);
  await page.evaluate(CONTENT_JS);

  // Single pick via the real shadow-DOM menu (pointerdown path).
  await page.focus('#username');
  await sleep(700);
  await sleep(400);
  const hit = await page.evaluate(() => {
    const host = document.getElementById('fly-password-fill-host');
    if (!host) return null;
    return {
      x: parseFloat(host.style.left || '0') + 40,
      y: parseFloat(host.style.top || '0') + 26,
    };
  });
  if (!hit) {
    await page.close();
    return { page, ok: false, logs, reason: 'menu never appeared' };
  }
  await page.mouse.click(hit.x, hit.y);

  let ok = false;
  try {
    ok = await page.waitForFunction(verify, { timeout: 10000 });
  } catch {
    ok = false;
  }
  const state = await page.evaluate(() => JSON.parse(JSON.stringify(window.__wizard)));
  await page.close();
  return { page: null, ok, logs, state, reason: ok ? '' : `verify failed: ${state ? JSON.stringify(state) : 'n/a'}` };
}

async function main() {
  const server = http.createServer((req, res) => {
    const html =
      req.url === '/no-mfa' ? WIZARD_NO_MFA_HTML : req.url === '/single' ? SINGLE_FORM_HTML : WIZARD_MFA_HTML;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  await new Promise((resolve) => server.listen(8977, '127.0.0.1', resolve));

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'],
    defaultViewport: { width: 900, height: 700 },
  });

  const results = {};
  const allLogs = {};

  // A) wizard with MFA
  {
    const r = await runScenario(
      browser,
      '/',
      WIZARD_MFA_HTML,
      { ...baseItem(), ...withOtps(1) },
      `window.__wizard.loggedIn === true && document.getElementById('otp').value === '123456'`,
    );
    results.A_wizard_with_mfa = r.ok;
    allLogs.A = r.logs;
    if (!r.ok) console.log('[A] FAIL', r.reason);
  }

  // B) wizard without MFA: password step must end with auto login
  {
    const r = await runScenario(
      browser,
      '/no-mfa',
      WIZARD_NO_MFA_HTML,
      { ...baseItem(), ...withOtps(0) },
      `window.__wizard.loggedIn === true && document.getElementById('password').value === 'Secret!123'`,
    );
    results.B_wizard_no_mfa = r.ok;
    allLogs.B = r.logs;
    if (!r.ok) console.log('[B] FAIL', r.reason);
  }

  // C) single form without MFA
  {
    const r = await runScenario(
      browser,
      '/single',
      SINGLE_FORM_HTML,
      { ...baseItem(), ...withOtps(0) },
      `window.__wizard.loggedIn === true && document.getElementById('username').value === 'zhangcy' && document.getElementById('password').value === 'Secret!123'`,
    );
    results.C_single_form_no_mfa = r.ok;
    allLogs.C = r.logs;
    if (!r.ok) console.log('[C] FAIL', r.reason);
  }

  console.log('\n=== 验收结果（全站三场景，一次点击全程自动） ===');
  let pass = true;
  Object.entries(results).forEach(([name, ok]) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) pass = false;
  });
  for (const key of ['A', 'B', 'C']) {
    console.log(`\n--- 场景 ${key} 日志 ---`);
    (allLogs[key] || []).forEach((line) => console.log('   ', line));
  }
  console.log(pass ? '=== ALL PASS ===' : '=== TEST FAILED ===');
  await browser.close();
  server.close();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
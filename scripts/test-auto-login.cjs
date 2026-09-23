// End-to-end verification of the REAL content.js auto-login flow.
// Runs a three-step wizard (username -> password -> MFA) with a stubbed
// chrome.runtime and asserts that a SINGLE menu pick fills every step and
// clicks every continue button without further interaction.
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

const WIZARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8" /><title>三步登录向导测试</title></head>
<body>
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
    const show = (id) => { ['step1','step2','step3'].forEach((s) => { document.getElementById(s).style.display = s === id ? '' : 'none'; }); };
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
</body>
</html>`;

const CHROME_STUB = `
  window.chrome = {
    runtime: {
      lastError: null,
      sendMessage: (message, callback) => {
        let response = { ok: true };
        if (message && message.type === 'getCredentials') {
          response = {
            ok: true,
            payload: {
              status: 'ok',
              items: [{
                id: 'test-1',
                title: '测试账号',
                username: 'zhangcy',
                password: 'Secret!123',
                totp_code: '123456',
                totp_remaining_seconds: 20,
              }],
            },
          };
        }
        setTimeout(() => callback(response), 0);
      },
      onMessage: { addListener: () => {} },
    },
  };
`;

async function main() {
  // Serve over real HTTP: sessionStorage is unavailable on opaque origins
  // (about:blank), which is what previously kept the auto plan from arming.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(WIZARD_HTML);
  });
  await new Promise((resolve) => server.listen(8977, '127.0.0.1', resolve));

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'],
    defaultViewport: { width: 900, height: 700 },
  });
  const page = await browser.newPage();
  const pageLogs = [];
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[FlyPassword]') || text.includes('[测试]')) pageLogs.push(text);
  });
  page.on('pageerror', (err) => pageLogs.push(`[PAGEERROR] ${err.message}`));
  await page.goto('http://127.0.0.1:8977/', { waitUntil: 'networkidle0' });
  // Install the chrome.runtime stub in the same world the content script runs
  // in (main world), then inject the real content.js.
  await page.evaluate(CHROME_STUB);
  await page.evaluate(CONTENT_JS);

  const checks = {};

  // Step 1: focus username -> menu appears -> click the menu item.
  await page.focus('#username');
  await sleep(700);
  const menuShown = await page.evaluate(() => {
    const host = document.getElementById('fly-password-fill-host');
    if (!host) return false;
    return host.style.top !== '' && host.style.left !== '';
  });
  checks.menuShown = menuShown;

  const hit = await page.evaluate(() => {
    const host = document.getElementById('fly-password-fill-host');
    return {
      x: parseFloat(host.style.left || '0') + 40,
      y: parseFloat(host.style.top || '0') + 26,
    };
  });

  // Wait a moment so the (async stub) payload resolves and the menu renders.
  await sleep(400);
  await page.mouse.click(hit.x, hit.y);
  console.log('[测试] 已点击菜单项 @', hit);

  const step1Ok = await page.evaluate(() => {
    const username = document.getElementById('username').value;
    return username === 'zhangcy';
  });
  checks.usernameFilled = step1Ok;

  // Step 2 auto: password fill + next2 click by the watcher.
  const step2Ok = await page.waitForFunction(
    () => window.__wizard.next2 >= 1 && document.getElementById('password').value === 'Secret!123',
    { timeout: 10000 },
  ).then(() => true).catch(() => false);
  checks.passwordFilledAndAdvanced = step2Ok;

  // Step 3 auto: OTP fill + login click by the watcher.
  const step3Ok = await page.waitForFunction(
    () => window.__wizard.loggedIn === true && document.getElementById('otp').value === '123456',
    { timeout: 10000 },
  ).then(() => true).catch(() => false);
  checks.mfaFilledAndLoggedIn = step3Ok;

  await sleep(300);
  const wizardState = await page.evaluate(() => JSON.parse(JSON.stringify(window.__wizard)));
  console.log('[测试] 向导状态', JSON.stringify(wizardState));
  console.log('[测试] 页面日志');
  pageLogs.forEach((line) => console.log('   ', line));

  const pass = Object.values(checks).every(Boolean);
  console.log('\n=== 验收结果 ===');
  Object.entries(checks).forEach(([name, ok]) => console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${ok}`));
  console.log(pass ? '=== ALL PASS ===' : '=== TEST FAILED ===');
  await browser.close();
  server.close();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
// Regenerates the README screenshots in docs/screenshots/ from the live UI.
// Usage: node scripts/update-screenshots.js
// Requires Chrome installed at the default location and deps from npm i.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const puppeteer = require('puppeteer-core');

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
];

const OUT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
const DEV_URL = 'http://127.0.0.1:1420';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findChrome() {
  for (const candidate of CHROME_PATHS) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome not found');
}

function devServerRunning() {
  return new Promise((resolve) => {
    http.get(`${DEV_URL}/`, (res) => {
      res.resume();
      resolve(true);
    }).on('error', () => resolve(false));
  });
}

async function waitForDevUrl(page, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      await page.goto(DEV_URL, { waitUntil: 'networkidle0', timeout: 5000 });
      return;
    } catch {
      await sleep(500);
    }
  }
  throw new Error('dev server did not come up');
}

const type = (page, selector, value) =>
  page.type(selector, value, { delay: 5 });

async function screenshot(page, name) {
  await sleep(450);
  await page.screenshot({ path: path.join(OUT_DIR, name) });
  console.log('saved', name);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const executablePath = findChrome();
  const alreadyRunning = await devServerRunning();
  let devProcess = null;
  if (!alreadyRunning) {
    devProcess = spawn('npm', ['run', 'dev'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'ignore',
      shell: true,
    });
  }

  try {
    const browser = await puppeteer.launch({
      executablePath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'],
      defaultViewport: { width: 1220, height: 800, deviceScaleFactor: 2 },
    });
    const page = await browser.newPage();

    // --- setup screen ---
    await waitForDevUrl(page);
    await sleep(600);
    const authInputs = await page.$$('.auth-field input');
    await authInputs[0].type('zhangcy', { delay: 5 });
    await authInputs[1].type('demo-password-1', { delay: 5 });
    await authInputs[2].type('demo-password-1', { delay: 5 });
    await screenshot(page, 'setup.png');

    // --- unlock screen ---
    await page.goto(`${DEV_URL}/?seed=1`, { waitUntil: 'networkidle0' });
    await page.evaluate(() => localStorage.clear());
    // Recreate the profile only (no items) so the app shows the locked screen
    // is not possible in browser preview; skip unlock.png when unavailable.
    await page.evaluate(() => {
      localStorage.setItem('fly.browserVaultProfile', JSON.stringify({ name: 'zhangcy', avatar: 'z' }));
    });

    // --- main detail (seeded vault) ---
    await page.goto(`${DEV_URL}/?seed=1`, { waitUntil: 'networkidle0' });
    await sleep(900);
    // Make sure the favorite seeded entry is selected (first row).
    const rows = await page.$$('.item-row');
    if (rows.length > 0) await rows[0].click();
    await sleep(900);
    await screenshot(page, 'main-detail.png');

    // --- edit pane ---
    const editButtons = await page.$$('.detail-action');
    for (const button of editButtons) {
      const label = await button.evaluate((el) => el.textContent);
      if (label && label.includes('编辑')) {
        await button.click();
        break;
      }
    }
    await sleep(500);
    await screenshot(page, 'edit-item.png');

    // --- new item type picker ---
    await page.keyboard.press('Escape').catch(() => {});
    await page.goto(`${DEV_URL}/?seed=1`, { waitUntil: 'networkidle0' });
    await sleep(800);
    await page.click('.new-item');
    await sleep(500);
    await screenshot(page, 'new-item.png');

    // --- password generator ---
    const loginCard = await page.$$('.type-card');
    for (const card of loginCard) {
      const label = await card.evaluate((el) => el.textContent);
      if (label && label.includes('登录信息')) {
        await card.click();
        break;
      }
    }
    await sleep(400);
    await page.click('.password-edit-field input');
    await sleep(300);
    const genChip = await page.$('.generate-chip');
    if (genChip) {
      await genChip.click();
      await sleep(600);
      await screenshot(page, 'password-generator.png');
    }

    // --- quick search window (compact floating window, ~380px wide) ---
    await page.goto(`${DEV_URL}/?seed=1&window=quick-search`, { waitUntil: 'networkidle0' });
    await page.setViewport({ width: 380, height: 190, deviceScaleFactor: 2 });
    await sleep(900);
    await screenshot(page, 'quick-search-empty.png');

    await type(page, '.quick-search-box input', 'jump');
    await sleep(700);
    await page.setViewport({ width: 380, height: 250, deviceScaleFactor: 2 });
    await sleep(200);
    const quickRows = await page.$$('.quick-result-row');
    await screenshot(page, 'quick-search-results.png');
    if (quickRows.length > 0) {
      await quickRows[0].click();
      await page.setViewport({ width: 380, height: 470, deviceScaleFactor: 2 });
      await sleep(900);
      await screenshot(page, 'quick-search-detail.png');
    }

    await browser.close();
    console.log('All screenshots regenerated in', OUT_DIR);
  } finally {
    if (devProcess) {
      devProcess.kill();
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/IM', 'node.exe', '/FI', `WINDOWTITLE eq npm*`], { stdio: 'ignore', shell: true });
      }
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

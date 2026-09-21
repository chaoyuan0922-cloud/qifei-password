// Renders docs/FlyPassword-使用说明.html into a PDF using headless Chrome.
// Usage: node scripts/generate-manual.cjs

const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
];

const OUT = path.join(__dirname, '..', 'docs', 'FlyPassword-使用说明.pdf');

function findChrome() {
  for (const candidate of CHROME_PATHS) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome not found');
}

(async () => {
  const htmlPath = path.join(__dirname, '..', 'docs', 'FlyPassword-使用说明.html');
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN'],
  });
  const page = await browser.newPage();
  await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'networkidle0' });
  await page.pdf({
    path: OUT,
    format: 'A4',
    printBackground: true,
    margin: { top: '18mm', bottom: '16mm', left: '16mm', right: '16mm' },
    displayHeaderFooter: true,
    headerTemplate: '<div></div>',
    footerTemplate:
      '<div style="width:100%;text-align:center;font-size:9px;color:#9a9da6;font-family:sans-serif;">起飞密码箱 · 使用与安装说明 · 第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</div>',
  });
  await browser.close();
  const size = fs.statSync(OUT).size;
  console.log(`PDF generated: ${OUT} (${(size / 1024).toFixed(1)} KB)`);
})();

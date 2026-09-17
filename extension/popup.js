// CaptainPassword browser extension - popup.

const statusEl = document.getElementById('status');
const pairBox = document.getElementById('pairBox');
const tokenInput = document.getElementById('tokenInput');
const pairButton = document.getElementById('pairButton');
const itemsEl = document.getElementById('items');
const refreshButton = document.getElementById('refreshButton');
const forgetButton = document.getElementById('forgetButton');

const send = (message) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      void chrome.runtime.lastError;
      resolve(response ?? { ok: false, error: 'no response' });
    });
  });

const activeTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const setStatus = (text, tone = '') => {
  statusEl.textContent = text;
  statusEl.className = `status ${tone}`;
};

const renderItems = (items, tabId) => {
  itemsEl.replaceChildren();
  if (!items || items.length === 0) {
    return;
  }
  for (const item of items) {
    const button = document.createElement('button');
    button.className = 'item';
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = (item.title || '?').slice(0, 1).toUpperCase();
    const text = document.createElement('span');
    text.className = 'text';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = item.title || item.username || '登录信息';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = item.username || '';
    text.append(title, sub);
    button.append(avatar, text);
    if (item.totp_code) {
      const badge = document.createElement('span');
      badge.className = 'badge totp-code';
      badge.textContent = item.totp_code;
      button.appendChild(badge);
    }
    button.addEventListener('click', async () => {
      const response = await send({ type: 'fillCredential', tabId, item });
      if (!response.ok) {
        setStatus(`填充失败：${response.error ?? '未知错误'}`, 'error');
      } else {
        window.close();
      }
    });
    itemsEl.appendChild(button);
  }
};

let countdownTimer = null;

const startCountdown = (seconds) => {
  if (countdownTimer) window.clearInterval(countdownTimer);
  countdownTimer = window.setInterval(() => {
    const badge = document.querySelector('.badge.totp-code');
    if (!badge) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
      return;
    }
    seconds -= 1;
    if (seconds <= 0) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
      void refresh();
    }
  }, 1000);
};

const refresh = async () => {
  pairBox.style.display = 'none';
  itemsEl.replaceChildren();

  const status = await send({ type: 'getStatus' });
  const payload = status.payload ?? {};
  if (!payload.connected) {
    if (payload.unauthorized) {
      setStatus('令牌无效，请重新粘贴应用中的桥接令牌。', 'error');
      pairBox.style.display = 'flex';
    } else if (payload.paired === false) {
      setStatus('尚未连接桌面应用。', 'warn');
      pairBox.style.display = 'flex';
    } else {
      setStatus('无法连接起飞密码箱，请确认应用已启动。', 'error');
    }
    return;
  }
  if (payload.vault !== 'unlocked') {
    setStatus('保险库已锁定，请先在应用中解锁。', 'warn');
    return;
  }

  const tab = await activeTab();
  const origin = tab?.url ? new URL(tab.url).origin : '';
  if (!/^https?:/.test(tab?.url ?? '')) {
    setStatus('当前页面不支持自动填充。', 'warn');
    return;
  }

  const response = await send({ type: 'getCredentials', origin });
  if (!response.ok) {
    setStatus(`连接失败：${response.error ?? '未知错误'}`, 'error');
    return;
  }
  const data = response.payload ?? {};
  if (data.status === 'locked') {
    setStatus('保险库已锁定，请先在应用中解锁。', 'warn');
    return;
  }
  if (data.status === 'denied') {
    setStatus('该网站尚未授权，请在应用「设置 → 浏览器扩展」中允许。', 'warn');
    return;
  }
  if (data.status !== 'ok') {
    setStatus(`读取失败：${data.status ?? '未知状态'}`, 'error');
    return;
  }

  const items = data.items ?? [];
  setStatus(`已连接，找到 ${items.length} 条匹配凭据。`, items.length > 0 ? 'ok' : '');
  renderItems(items, tab.id);
  const withTotp = items.find((item) => item.totp_code);
  if (withTotp?.totp_remaining_seconds) {
    startCountdown(withTotp.totp_remaining_seconds);
  }
};

pairButton.addEventListener('click', async () => {
  pairButton.disabled = true;
  const response = await send({ type: 'saveToken', token: tokenInput.value });
  pairButton.disabled = false;
  if (response.ok) {
    tokenInput.value = '';
    await refresh();
  } else {
    setStatus(response.error ?? '保存失败', 'error');
  }
});

tokenInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    pairButton.click();
  }
});

refreshButton.addEventListener('click', () => void refresh());

forgetButton.addEventListener('click', async () => {
  await send({ type: 'clearToken' });
  await refresh();
});

void refresh();

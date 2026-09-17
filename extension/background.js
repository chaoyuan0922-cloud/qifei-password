// FlyPassword browser extension - background service worker.
// Bridges content scripts / popup to the desktop app's local HTTP bridge.

const PORT_CANDIDATES = Array.from({ length: 40 }, (_, index) => 27124 + index);
const HOST_CANDIDATES = ['http://127.0.0.1', 'http://localhost'];

const lastFilledByTab = new Map();

const storageGet = (keys) => chrome.storage.local.get(keys);
const storageSet = (values) => chrome.storage.local.set(values);

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  return { ok: response.ok, status: response.status, data };
}

async function bridgeRequest(path, { method = 'GET', body } = {}) {
  const { bridgeToken } = await storageGet(['bridgeToken']);
  if (!bridgeToken) {
    throw new Error('NOT_PAIRED');
  }
  const { bridgePort, bridgeHost } = await storageGet(['bridgePort', 'bridgeHost']);

  const buildCandidates = () => {
    const entries = [];
    for (const host of HOST_CANDIDATES) {
      if (bridgePort) entries.push(`${host}:${bridgePort}`);
      for (const port of PORT_CANDIDATES) {
        entries.push(`${host}:${port}`);
      }
    }
    return [...new Set(entries)];
  };

  const cached = bridgePort ? `${bridgeHost || HOST_CANDIDATES[0]}:${bridgePort}` : null;
  const candidates = cached ? [cached, ...buildCandidates().filter((entry) => entry !== cached)] : buildCandidates();

  let lastError = null;
  let sawUnauthorized = false;
  for (const entry of candidates) {
    try {
      const result = await fetchJson(`http://${entry.startsWith('http') ? entry.slice(7) : entry}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bridgeToken}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (result.status === 401) {
        // Another app instance with a different token may own this port;
        // keep scanning for the one that matches our token.
        sawUnauthorized = true;
        continue;
      }
      const [host, port] = entry.replace(/^https?:\/\//, '').split(':');
      await storageSet({ bridgePort: Number(port), bridgeHost: `http://${host}` });
      return result;
    } catch (err) {
      if (err.message === 'NOT_PAIRED') throw err;
      lastError = err;
    }
  }
  if (sawUnauthorized) throw new Error('UNAUTHORIZED');
  throw lastError || new Error('BRIDGE_UNREACHABLE');
}

async function getCredentials(origin) {
  const result = await bridgeRequest('/logins', { method: 'POST', body: { origin } });
  return result.data ?? { status: 'error' };
}

async function getStatus() {
  try {
    const result = await bridgeRequest('/status');
    return { connected: true, vault: result.data.status ?? 'locked' };
  } catch (err) {
    if (err.message === 'NOT_PAIRED') return { connected: false, paired: false };
    if (err.message === 'UNAUTHORIZED') return { connected: false, paired: true, unauthorized: true };
    return { connected: false, paired: true };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case 'getCredentials': {
          const origin = message.origin || sender.origin || '';
          sendResponse({ ok: true, payload: await getCredentials(origin) });
          return;
        }
        case 'getStatus': {
          sendResponse({ ok: true, payload: await getStatus() });
          return;
        }
        case 'saveToken': {
          const token = String(message.token || '').trim();
          if (!token) {
            sendResponse({ ok: false, error: '令牌不能为空' });
            return;
          }
          await storageSet({ bridgeToken: token, bridgePort: null, bridgeHost: null });
          sendResponse({ ok: true });
          return;
        }
        case 'clearToken': {
          await storageSet({ bridgeToken: null, bridgePort: null, bridgeHost: null });
          sendResponse({ ok: true });
          return;
        }
        case 'fillCredential': {
          // Sent by the popup to fill a credential into the active tab.
          const tabId = message.tabId;
          if (typeof tabId !== 'number') {
            sendResponse({ ok: false, error: '缺少标签页' });
            return;
          }
          const response = await chrome.tabs.sendMessage(tabId, {
            type: 'performFill',
            item: message.item,
          });
          if (response?.ok) {
            lastFilledByTab.set(tabId, message.item);
          }
          sendResponse(response ?? { ok: false, error: '页面未响应' });
          return;
        }
        case 'fillOtp': {
          const tabId = message.tabId;
          const itemId = message.itemId;
          const origin = message.origin;
          // Refresh credentials so the code is current, then fill the OTP field.
          const payload = await getCredentials(origin);
          const item = (payload.items ?? []).find((entry) => entry.id === itemId);
          if (!item?.totp_code) {
            sendResponse({ ok: false, error: '该条目没有可用验证码' });
            return;
          }
          const response = await chrome.tabs.sendMessage(tabId, {
            type: 'performOtpFill',
            code: item.totp_code,
          });
          sendResponse(response ?? { ok: false, error: '页面未响应' });
          return;
        }
        case 'markLastFilled': {
          const tabId = sender.tab?.id;
          if (typeof tabId === 'number' && message.item) {
            lastFilledByTab.set(tabId, message.item);
          }
          sendResponse({ ok: true });
          return;
        }
        case 'getLastFilled': {
          sendResponse({ ok: true, item: lastFilledByTab.get(message.tabId) ?? null });
          return;
        }
        default:
          sendResponse({ ok: false, error: '未知消息类型' });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true;
});

// FlyPassword browser extension - content script.
// Detects login / OTP fields and fills credentials from the desktop app.

(() => {
  'use strict';

  if (window.__flyPasswordInjected) return;
  window.__flyPasswordInjected = true;
  console.log('[FlyPassword] 内容脚本已加载 · build v11');

  const OTP_NAME_PATTERN = /(otp|onetime|one-time|totp|verif|authcode|2fa|mfa|twofactor|two-factor|dynamic)/i;
  const CREDENTIALS_CACHE_TTL = 20000;

  let credentialsCache = { origin: '', fetchedAt: 0, payload: null, promise: null };
  let lastFilledItem = null;
  let pendingOtpItem = null;

  const runtimeSend = (message) =>
    new Promise((resolve) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, error: 'background timeout' });
      }, 6000);
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError;
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(response ?? { ok: false, error: 'no response' });
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve({ ok: false, error: String(err) });
      }
    });

  const isVisible = (element) => {
    if (!(element instanceof HTMLElement) || element.disabled || element.readOnly) return false;
    if (element.type === 'hidden') return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(element);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };

  const fieldKey = (element) => (element ? `${element.name || ''}|${element.id || ''}|${element.type || ''}` : '');

  const isUsernameCandidate = (element) => {
    if (!(element instanceof HTMLInputElement)) return false;
    const type = (element.type || 'text').toLowerCase();
    return ['text', 'email', 'tel', 'username', ''].includes(type);
  };

  const autocompleteHint = (element) => (element.getAttribute('autocomplete') || '').toLowerCase().trim();

  const looksLikeSearchField = (element) => {
    const hints = `${element.name || ''} ${element.id || ''} ${element.placeholder || ''} ${element.getAttribute('aria-label') || ''}`;
    return /search|查询|搜索|q\b/i.test(hints) && element.type !== 'password';
  };

  const findUsernameField = (passwordField) => {
    const scope = passwordField.form || document;
    const candidates = Array.from(scope.querySelectorAll('input')).filter(
      (element) => isUsernameCandidate(element) && isVisible(element) && !looksLikeSearchField(element),
    );
    if (candidates.length === 0) return null;
    const byAutocomplete = candidates.find((element) => autocompleteHint(element).includes('username'));
    if (byAutocomplete) return byAutocomplete;
    if (passwordField.form) {
      const beforePassword = candidates.filter((element) => element.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (beforePassword.length > 0) return beforePassword[beforePassword.length - 1];
    }
    const global = Array.from(document.querySelectorAll('input'))
      .filter((element) => isUsernameCandidate(element) && isVisible(element) && !looksLikeSearchField(element))
      .filter((element) => element.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING);
    return global[global.length - 1] ?? candidates[0];
  };

  const findPasswordField = () => {
    const fields = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible);
    return fields[fields.length - 1] ?? null;
  };

  const isOtpField = (element) => {
    if (!(element instanceof HTMLInputElement)) return false;
    if (!isVisible(element)) return false;
    if (autocompleteHint(element) === 'one-time-code') return true;
    const hints = `${element.name || ''} ${element.id || ''} ${element.getAttribute('aria-label') || ''} ${element.placeholder || ''}`;
    const numericish = element.type === 'text' || element.type === 'tel' || element.type === 'number' || element.type === 'password' || element.type === '';
    const limited = element.maxLength === -1 || element.maxLength <= 8;
    return OTP_NAME_PATTERN.test(hints) && numericish && limited && !/search/i.test(hints);
  };

  const setNativeValue = (input, value) => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  // Some SPA frameworks (antd/Vue/React variants) reset programmatic value
  // changes; retype the text as if the user typed it until it sticks.
  const forceFill = (input, value) => {
    setNativeValue(input, value);
    if (input.value === value) return true;
    try {
      input.focus();
      document.execCommand('selectAll', false, null);
      if (!document.execCommand('insertText', false, value)) {
        throw new Error('insertText rejected');
      }
    } catch {
      setNativeValue(input, value);
    }
    return input.value === value;
  };

  const fillCredential = (item) => {
    const passwordField = findPasswordField();
    let filled = false;
    if (passwordField) {
      filled = forceFill(passwordField, item.password ?? '');
      const usernameField = findUsernameField(passwordField);
      if (usernameField && item.username) {
        forceFill(usernameField, item.username);
      }
    } else {
      // No password field on this step. If the focused field is an OTP box,
      // fill the verification code; otherwise treat it as a username step.
      const focused = document.activeElement;
      if (focused && isOtpField(focused) && item.totp_code) {
        filled = forceFill(focused, item.totp_code);
      } else if (focused && isUsernameCandidate(focused) && !isOtpField(focused)) {
        filled = forceFill(focused, item.username ?? '');
      } else {
        const usernameField = Array.from(document.querySelectorAll('input')).find(
          (element) => isUsernameCandidate(element) && !isOtpField(element) && isVisible(element) && !looksLikeSearchField(element),
        );
        if (usernameField && item.username) {
          filled = forceFill(usernameField, item.username);
        }
      }
    }
    if (filled) {
      lastFilledItem = item;
      if (item.totp_code) {
        pendingOtpItem = item;
      }
      void runtimeSend({ type: 'markLastFilled', item });
      const feedbackAnchor = anchorField || passwordField || document.activeElement || document.body;
      hideMenu();
      showMenu(
        feedbackAnchor,
        [{ info: true, icon: '✓', title: '已填充', subtitle: item.title || '' }],
        '',
      );
      window.setTimeout(() => {
        if (anchorField === feedbackAnchor && menu && menu.style.display !== 'none') {
          hideMenu();
        }
      }, 1500);
    }
    return filled;
  };

  const queryOtpField = () => {
    const focused = document.activeElement;
    if (focused && isOtpField(focused)) return focused;
    return Array.from(document.querySelectorAll('input')).find(isOtpField) || null;
  };

  const otpInputsInPage = () =>
    Array.from(document.querySelectorAll('input')).filter((el) => isOtpField(el) && isVisible(el));

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Segmented OTP widgets (six single-digit boxes) need one digit per input.
  const fillOtpSegmented = (digits) => {
    const inputs = otpInputsInPage();
    if (inputs.length < digits.length) return false;
    const group = inputs.slice(0, digits.length);
    let ok = true;
    group.forEach((input, index) => {
      if (!forceFill(input, digits[index])) ok = false;
    });
    return ok;
  };

  const fillOtpCode = async (field, code) => {
    const digits = code.replace(/\D/g, '');
    console.log('[FlyPassword] OTP fill start', { code, digits });
    const locate = () => {
      if (field && field.isConnected && isOtpField(field)) return field;
      return queryOtpField();
    };
    let target = locate();
    if (!target) return false;

    let succeeded = false;
    for (let attempt = 0; attempt < 2 && !succeeded; attempt += 1) {
      forceFill(target, code);
      await sleep(300);
      target = locate() || target;
      if (target.value === code) {
        succeeded = true;
        break;
      }
      // Truncated value (maxLength boxes) or a multi-box widget: distribute digits.
      succeeded = fillOtpSegmented(digits);
    }
    console.log('[FlyPassword] OTP fill result', {
      code,
      singleValue: target.value,
      otpInputs: otpInputsInPage().map((el) => ({
        name: el.name,
        id: el.id,
        maxLength: el.maxLength,
        value: el.value,
      })),
      succeeded,
    });

    const joined = otpInputsInPage()
      .slice(0, digits.length)
      .map((input) => input.value)
      .join('');
    succeeded = succeeded || joined === digits;

    if (succeeded) {
      target.focus();
      hideMenu();
      showMenu(target, [{ info: true, icon: '✓', title: '已填充 MFA 验证码', subtitle: '' }], '');
      window.setTimeout(() => {
        if (menu && menu.style.display !== 'none') {
          hideMenu();
        }
      }, 1200);
      return true;
    }
    showMenu(
      target,
      [{ info: true, icon: '⚠', title: '填充失败', subtitle: '请按 F12 查看控制台 [FlyPassword] 诊断信息并反馈' }],
      '',
    );
    window.setTimeout(() => {
      if (menu && menu.style.display !== 'none') {
        hideMenu();
      }
    }, 2500);
    return false;
  };

  // ===== Inline dropdown menu =====

  let host = null;
  let root = null;
  let menu = null;
  let anchorField = null;
  let menuMode = null; // 'credential' | 'otp'

  const MENU_STYLES = `
    :host { all: initial; }
    .cp-menu {
      position: absolute;
      z-index: 2147483646;
      min-width: 280px;
      max-width: 380px;
      background: #ffffff;
      border: 1px solid #e3e5ea;
      border-radius: 12px;
      box-shadow: 0 12px 32px rgba(20, 24, 34, 0.18);
      font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
      font-size: 13px;
      color: #282b31;
      overflow: hidden;
    }
    .cp-item {
      display: flex;
      align-items: center;
      gap: 10px;
      width: 100%;
      padding: 10px 14px;
      border: 0;
      background: transparent;
      cursor: pointer;
      text-align: left;
      font: inherit;
      color: inherit;
    }
    .cp-item:hover, .cp-item:focus { background: #f2f4fa; outline: none; }
    .cp-info { cursor: default; color: #55585f; }
    .cp-info .cp-avatar { background: #f0b429; }
    .cp-avatar {
      flex: none;
      width: 28px;
      height: 28px;
      border-radius: 8px;
      background: #4c6ef5;
      color: #fff;
      font-size: 12px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .cp-text { min-width: 0; }
    .cp-title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cp-sub { color: #74777f; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cp-badge {
      margin-left: auto;
      flex: none;
      padding: 2px 8px;
      border-radius: 999px;
      background: #eef1ff;
      color: #4c6ef5;
      font-size: 11px;
      font-weight: 600;
    }
    .cp-footer {
      padding: 8px 14px;
      border-top: 1px solid #eef0f4;
      color: #9a9da6;
      font-size: 11px;
      background: #fafbfc;
    }
  `;

  const ensureMenuHost = () => {
    if (host) return;
    host = document.createElement('div');
    host.id = 'fly-password-fill-host';
    host.style.position = 'absolute';
    host.style.top = '0';
    host.style.left = '0';
    host.style.width = '0';
    host.style.height = '0';
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = MENU_STYLES;
    root.appendChild(style);
    menu = document.createElement('div');
    menu.className = 'cp-menu';
    menu.style.display = 'none';
    root.appendChild(menu);
    (document.body || document.documentElement).appendChild(host);
  };

  const hideMenu = () => {
    if (menu) menu.style.display = 'none';
    anchorField = null;
    menuMode = null;
  };

  const positionMenu = () => {
    if (!host || !anchorField || !menu || menu.style.display === 'none') return;
    const rect = anchorField.getBoundingClientRect();
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    const top = rect.bottom + scrollY + 6;
    const left = Math.min(Math.max(rect.left + scrollX, scrollX + 8), scrollX + window.innerWidth - 300);
    host.style.top = `${top}px`;
    host.style.left = `${left}px`;
    menu.style.top = '0';
    menu.style.left = '0';
  };

  const showMenu = (field, entries, footerText) => {
    ensureMenuHost();
    menu.replaceChildren();
    for (const entry of entries) {
      if (entry.info) {
        const info = document.createElement('div');
        info.className = 'cp-item cp-info';
        const avatar = document.createElement('span');
        avatar.className = 'cp-avatar';
        avatar.textContent = entry.icon || '⏳';
        const text = document.createElement('span');
        text.className = 'cp-text';
        const title = document.createElement('div');
        title.className = 'cp-title';
        title.textContent = entry.title;
        const sub = document.createElement('div');
        sub.className = 'cp-sub';
        sub.textContent = entry.subtitle || '';
        text.append(title, sub);
        info.append(avatar, text);
        menu.appendChild(info);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'cp-item';
      const avatar = document.createElement('span');
      avatar.className = 'cp-avatar';
      avatar.textContent = (entry.title || '?').slice(0, 1).toUpperCase();
      const text = document.createElement('span');
      text.className = 'cp-text';
      const title = document.createElement('div');
      title.className = 'cp-title';
      title.textContent = entry.title || entry.username || '登录信息';
      const sub = document.createElement('div');
      sub.className = 'cp-sub';
      sub.textContent = entry.subtitle || '';
      text.append(title, sub);
      button.append(avatar, text);
      if (entry.badge) {
        const badge = document.createElement('span');
        badge.className = 'cp-badge';
        badge.textContent = entry.badge;
        button.appendChild(badge);
      }
      button.addEventListener('click', (event) => {
        event.preventDefault();
        console.log('[FlyPassword] 菜单项被点击：', entry.title || entry.subtitle || entry.username || '');
        entry.onPick();
      });
      menu.appendChild(button);
    }
    if (footerText) {
      const footer = document.createElement('div');
      footer.className = 'cp-footer';
      footer.textContent = footerText;
      menu.appendChild(footer);
    }
    anchorField = field;
    menu.style.display = 'block';
    positionMenu();
  };

  const showCredentialMenu = (field, items) => {
    if (!items || items.length === 0) return;
    menuMode = 'credential';
    showMenu(
      field,
      items.map((item) => ({
        title: item.title,
        subtitle: item.username,
        badge: item.totp_code ? 'MFA' : null,
        onPick: () => fillCredential(item),
      })),
      '由起飞密码箱填充 · v11',
    );
  };

  // ===== Auto dropdown on matching login pages =====

  let autoShownForPage = false;

  const tryAutoShowMenu = async () => {
    if (autoShownForPage) return;
    const passwordField = findPasswordField();
    if (!passwordField) return;
    const payload = await requestCredentials();
    if (payload?.status !== 'ok' || !payload.items?.length) return;
    autoShownForPage = true;
    const anchor = findUsernameField(passwordField) || passwordField;
    showCredentialMenu(anchor, payload.items);
  };

  window.setTimeout(() => void tryAutoShowMenu(), 900);

  const showOtpMenu = (field, item) => {
    menuMode = 'otp';
    showMenu(
      field,
      [
        {
          title: '填充 MFA 验证码',
          subtitle: item?.title ? `来自「${item.title}」` : '',
          badge: 'MFA',
          onPick: async () => {
            console.log('[FlyPassword] OTP fill triggered', { itemId: item?.id, title: item?.title });
            // Fill immediately from the cached code; refreshing through the
            // background may be slow or unroutable, so it is best-effort only.
            const code = item?.totp_code;
            if (!code) {
              showMenu(field, [{ info: true, icon: '⚠', title: '没有可用验证码', subtitle: '' }], '');
              return;
            }
            await fillOtpCode(field, code);
            void requestCredentials(true).catch(() => {});
          },
        },
      ],
      '由起飞密码箱填充 · v11',
    );
  };

  // ===== Credentials fetching =====

  const requestCredentials = (force = false) => {
    const origin = location.origin;
    const now = Date.now();
    if (
      !force &&
      credentialsCache.payload &&
      credentialsCache.origin === origin &&
      now - credentialsCache.fetchedAt < CREDENTIALS_CACHE_TTL
    ) {
      return Promise.resolve(credentialsCache.payload);
    }
    if (credentialsCache.promise && credentialsCache.origin === origin) {
      return credentialsCache.promise;
    }
    credentialsCache.origin = origin;
    credentialsCache.fetchedAt = now;
    credentialsCache.promise = runtimeSend({ type: 'getCredentials', origin }).then((response) => {
      credentialsCache.promise = null;
      if (response?.ok && response.payload?.status === 'ok') {
        credentialsCache.payload = response.payload;
        credentialsCache.fetchedAt = Date.now();
        return response.payload;
      }
      credentialsCache.payload = null;
      return response?.payload ?? null;
    });
    return credentialsCache.promise;
  };

  const maybeShowForField = async (field) => {
    if (isOtpField(field)) {
      let item = pendingOtpItem || lastFilledItem;
      if (!item?.totp_code) {
        // Nothing filled on this page load (e.g. full-page navigation to the
        // MFA step): look up cached credentials for a TOTP-enabled entry.
        const payload = await requestCredentials();
        item = (payload?.items ?? []).find((entry) => entry.totp_code) ?? null;
      }
      if (item?.totp_code) {
        showOtpMenu(field, item);
      }
      return;
    }
    const isPasswordField = field instanceof HTMLInputElement && field.type === 'password';
    if (!isPasswordField && !isUsernameCandidate(field)) return;
    const payload = await requestCredentials();
    if (payload?.status === 'approval_required') {
      showMenu(
        field,
        [
          {
            info: true,
            title: '等待应用授权…',
            subtitle: '请切换到起飞密码箱，点击「永久允许」',
          },
        ],
        '授权通过后将自动显示凭据',
      );
      void pollApproval(field);
      return;
    }
    if (payload?.status === 'ok' && payload.items?.length > 0) {
      showCredentialMenu(field, payload.items);
    }
  };

  let approvalPollTimer = null;

  const pollApproval = async (field) => {
    if (approvalPollTimer) {
      window.clearTimeout(approvalPollTimer);
      approvalPollTimer = null;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await new Promise((resolve) => {
        approvalPollTimer = window.setTimeout(resolve, 2000);
      });
      if (anchorField !== field || !menu || menu.style.display === 'none') return;
      const payload = await requestCredentials(true);
      if (payload?.status === 'ok') {
        if (anchorField === field) {
          showCredentialMenu(field, payload.items ?? []);
        }
        return;
      }
      if (payload?.status !== 'approval_required') return;
    }
    if (anchorField === field) {
      showMenu(
        field,
        [
          {
            info: true,
            title: '尚未完成授权',
            subtitle: '可在应用「设置 → 浏览器扩展」中允许后重试',
          },
        ],
        '由起飞密码箱填充 · v11',
      );
    }
  };

  let lastFocusedKey = '';
  document.addEventListener(
    'focusin',
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const key = `${fieldKey(target)}|${isOtpField(target) ? 'otp' : target.type || 'text'}`;
      if (key === lastFocusedKey && menu && menu.style.display !== 'none' && anchorField === target) return;
      lastFocusedKey = key;
      hideMenu();
      if (isVisible(target)) {
        void maybeShowForField(target);
      }
    },
    true,
  );

  document.addEventListener('mousedown', (event) => {
    if (host && event.composedPath().includes(host)) return;
    hideMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideMenu();
  });

  const reposition = () => positionMenu();
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);

  // Detect login forms that appear after SPA navigation.
  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    if (mutationTimer) return;
    mutationTimer = window.setTimeout(() => {
      mutationTimer = null;
      void tryAutoShowMenu();
      const active = document.activeElement;
      if (active instanceof HTMLElement && isVisible(active)) {
        void maybeShowForField(active);
      }
    }, 400);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Messages from the popup / background.
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'performFill') {
      const filled = fillCredential(message.item);
      sendResponse({ ok: filled, error: filled ? undefined : '未找到可填充的登录表单' });
      return;
    }
    if (message?.type === 'performOtpFill') {
      const filled = fillOtpCode(message.code);
      sendResponse({ ok: filled, error: filled ? undefined : '未找到验证码输入框' });
      return;
    }
    if (message?.type === 'peek') {
      const payload = { hasPassword: Boolean(findPasswordField()), otp: pendingOtpItem ? 'pending' : null };
      sendResponse({ ok: true, payload });
      return;
    }
    return undefined;
  });
})();

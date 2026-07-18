(function initializeShortOpPage(globalObject) {
  function isValidShortCode(value) {
    return /^\d{8}$/.test(String(value || ''));
  }

  function extractShortCode(locationLike = {}) {
    const match = String(locationLike.pathname || '').match(/^\/op\/(\d{8})\/?$/);
    return match ? match[1] : '';
  }

  function createAppHandoff({
    appName,
    url,
    message,
    submitButton,
    locationLike,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  }) {
    let navigationTimer;
    let fallbackTimer;

    function restore() {
      clearTimeoutImpl(navigationTimer);
      clearTimeoutImpl(fallbackTimer);
      submitButton.disabled = false;
      message.textContent = `未能打开${appName}，请重试`;
      message.className = 'message error';
    }

    message.textContent = `正在打开${appName}…`;
    message.className = 'message success';
    navigationTimer = setTimeoutImpl(() => {
      try {
        locationLike.href = url;
      } catch (error) {
        restore();
      }
    }, 50);
    fallbackTimer = setTimeoutImpl(restore, 1_500);

    return { restore };
  }

  const api = { createAppHandoff, extractShortCode, isValidShortCode };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }

  if (!globalObject || !globalObject.document) return;

  const document = globalObject.document;
  document.addEventListener('DOMContentLoaded', () => {
    const form = document.querySelector('#short-op-form');
    const input = document.querySelector('#short-code');
    const submitButton = document.querySelector('#submit-short-code');
    const message = document.querySelector('#short-op-message');
    if (!form || !input || !submitButton || !message) return;
    let activeHandoff = null;

    globalObject.addEventListener('pageshow', () => {
      if (activeHandoff) {
        activeHandoff.restore();
        activeHandoff = null;
      } else {
        submitButton.disabled = false;
      }
    });

    const pathCode = extractShortCode(globalObject.location);
    if (pathCode) input.value = pathCode;

    input.addEventListener('input', () => {
      input.value = input.value.replace(/\D/g, '').slice(0, 8);
      message.textContent = '';
      message.className = 'message';
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const code = input.value;
      if (!isValidShortCode(code)) {
        message.textContent = '请输入正确的 8 位短码';
        message.className = 'message error';
        return;
      }

      submitButton.disabled = true;
      message.textContent = '正在解析短码…';
      message.className = 'message';

      try {
        const response = await globalObject.fetch('/api/op/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        const result = await response.json();
        if (!response.ok) {
          throw new Error(result.error || '短码解析失败');
        }

        activeHandoff = createAppHandoff({
          appName: result.appName,
          url: result.url,
          message,
          submitButton,
          locationLike: globalObject.location,
        });
      } catch (error) {
        message.textContent = error.message || '短码解析失败';
        message.className = 'message error';
        submitButton.disabled = false;
      }
    });
  });
}(typeof window === 'undefined' ? undefined : window));

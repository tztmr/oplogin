function safeAccessNext(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(value)) {
    return '/admin';
  }
  try {
    const destination = new URL(value, window.location.origin);
    if (destination.origin !== window.location.origin || destination.pathname.startsWith('//')) {
      return '/admin';
    }
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch (error) {
    return '/admin';
  }
}

window.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('accessForm');
  const passwordInput = document.getElementById('accessPassword');
  const errorNode = document.getElementById('accessError');
  const submitButton = document.getElementById('accessSubmit');
  const next = safeAccessNext(new URLSearchParams(window.location.search).get('next'));

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitButton.disabled) return;
    errorNode.hidden = true;
    submitButton.disabled = true;
    submitButton.textContent = '正在验证…';
    try {
      const response = await fetch('/api/access/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput.value, next }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || '访问验证失败，请重试');
      }
      window.location.replace(safeAccessNext(data.next));
    } catch (error) {
      errorNode.textContent = error instanceof TypeError ? '网络异常，请稍后重试' : error.message || '访问验证失败，请重试';
      errorNode.hidden = false;
      passwordInput.focus();
      passwordInput.select();
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = '验证并进入';
    }
  });
});

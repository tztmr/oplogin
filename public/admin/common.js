async function adminFetch(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  if (response.status === 204) {
    return null;
  }

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

async function requireAdminSession() {
  try {
    const data = await adminFetch('/api/admin/auth/me', { method: 'GET' });
    return data.user;
  } catch (error) {
    window.location.href = '/admin/login';
    return null;
  }
}

function showToast(message) {
  window.alert(message);
}

function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

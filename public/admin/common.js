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

function initializeSelfPasswordChange() {
  const openButton = document.getElementById('changeOwnPasswordButton');
  const dialog = document.getElementById('selfPasswordDialog');
  const form = document.getElementById('selfPasswordForm');
  const cancelButton = document.getElementById('selfPasswordCancelButton');
  if (!openButton || !dialog || !form || !cancelButton) {
    return;
  }

  openButton.addEventListener('click', () => {
    form.reset();
    dialog.showModal();
  });

  cancelButton.addEventListener('click', () => {
    dialog.close();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const currentPassword = document.getElementById('selfCurrentPassword').value;
    const newPassword = document.getElementById('selfNewPassword').value;
    const confirmPassword = document.getElementById('selfConfirmPassword').value;

    if (newPassword !== confirmPassword) {
      showToast('两次输入的新密码不一致');
      return;
    }

    await adminFetch('/api/admin/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentPassword,
        newPassword,
      }),
    });

    dialog.close();
    showToast('密码修改成功，请使用新密码重新记住');
  });
}

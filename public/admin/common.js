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

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json()
    : { error: await response.text() };
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
  const { toastStack } = ensureFeedbackUi();
  const toast = document.createElement('div');
  toast.className = 'admin-toast';
  toast.textContent = message;
  toastStack.appendChild(toast);
  window.setTimeout(() => {
    toast.classList.add('is-visible');
  }, 10);
  window.setTimeout(() => {
    toast.classList.remove('is-visible');
    window.setTimeout(() => toast.remove(), 180);
  }, 2400);
}

function formatDateTime(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function ensureFeedbackUi() {
  let toastStack = document.getElementById('adminToastStack');
  if (!toastStack) {
    toastStack = document.createElement('div');
    toastStack.id = 'adminToastStack';
    document.body.appendChild(toastStack);
  }

  let dialog = document.getElementById('adminConfirmDialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'adminConfirmDialog';
    dialog.className = 'feedback-dialog';
    dialog.innerHTML = `
      <form method="dialog" class="stack-form feedback-dialog-form">
        <h3>操作确认</h3>
        <p id="adminConfirmMessage" class="dialog-subtitle"></p>
        <menu class="dialog-menu">
          <button type="button" id="adminConfirmCancelButton" class="btn-cancel">取消</button>
          <button type="button" id="adminConfirmOkButton" class="btn-primary">确定</button>
        </menu>
      </form>
    `;
    document.body.appendChild(dialog);
  }

  return {
    toastStack,
    dialog,
    message: document.getElementById('adminConfirmMessage'),
    cancelButton: document.getElementById('adminConfirmCancelButton'),
    okButton: document.getElementById('adminConfirmOkButton'),
  };
}

function showConfirm(message, options = {}) {
  const ui = ensureFeedbackUi();
  ui.message.textContent = message;
  ui.okButton.textContent = options.confirmText || '确定';
  ui.cancelButton.textContent = options.cancelText || '取消';
  ui.okButton.classList.toggle('btn-danger', options.tone === 'danger');

  return new Promise((resolve) => {
    const cleanup = (result) => {
      ui.okButton.removeEventListener('click', onConfirm);
      ui.cancelButton.removeEventListener('click', onCancel);
      ui.dialog.removeEventListener('cancel', onCancel);
      if (ui.dialog.open) {
        ui.dialog.close();
      }
      resolve(result);
    };

    const onConfirm = () => cleanup(true);
    const onCancel = (event) => {
      if (event && typeof event.preventDefault === 'function') {
        event.preventDefault();
      }
      cleanup(false);
    };

    ui.okButton.addEventListener('click', onConfirm, { once: true });
    ui.cancelButton.addEventListener('click', onCancel, { once: true });
    ui.dialog.addEventListener('cancel', onCancel, { once: true });
    ui.dialog.showModal();
  });
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

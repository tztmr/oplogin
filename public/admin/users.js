function renderUsers(users) {
  const tbody = document.getElementById('userTableBody');
  tbody.innerHTML = users
    .map(
      (user) => `
        <tr>
          <td>${user.login}</td>
          <td>${user.email}</td>
          <td>${user.role}</td>
          <td>${user.status}</td>
          <td>${formatDateTime(user.lastLoginAt)}</td>
          <td>
            <div class="row-actions">
              <button type="button" onclick="window.openEditUser('${user.id}')">编辑</button>
              <button type="button" onclick="window.openResetPassword('${user.id}')">重置密码</button>
            </div>
          </td>
        </tr>
      `,
    )
    .join('');
}

async function loadUsers() {
  const data = await adminFetch('/api/admin/users', { method: 'GET' });
  renderUsers(data.users);
}

window.openEditUser = async function openEditUser(id) {
  const data = await adminFetch('/api/admin/users', { method: 'GET' });
  const user = data.users.find((item) => item.id === id);

  document.getElementById('userId').value = user.id;
  document.getElementById('userLogin').value = user.login;
  document.getElementById('userEmail').value = user.email;
  document.getElementById('userRole').value = user.role;
  document.getElementById('userStatus').value = user.status;
  document.getElementById('userPassword').value = '';
  document.getElementById('userDialog').showModal();
};

window.openResetPassword = async function openResetPassword(id) {
  document.getElementById('passwordTargetUserId').value = id;
  document.getElementById('newPassword').value = '';
  document.getElementById('passwordDialog').showModal();
};

async function submitUserForm(event) {
  event.preventDefault();

  const userId = document.getElementById('userId').value;
  const isCreate = !userId;
  const payload = {
    login: document.getElementById('userLogin').value.trim(),
    email: document.getElementById('userEmail').value.trim(),
    role: document.getElementById('userRole').value,
    status: document.getElementById('userStatus').value,
  };

  if (isCreate) {
    payload.password = document.getElementById('userPassword').value;
  }

  await adminFetch(isCreate ? '/api/admin/users' : `/api/admin/users/${userId}`, {
    method: isCreate ? 'POST' : 'PUT',
    body: JSON.stringify(payload),
  });

  document.getElementById('userDialog').close();
  await loadUsers();
}

async function submitPasswordForm(event) {
  event.preventDefault();

  const userId = document.getElementById('passwordTargetUserId').value;
  const password = document.getElementById('newPassword').value;

  await adminFetch(`/api/admin/users/${userId}/password`, {
    method: 'PUT',
    body: JSON.stringify({ password }),
  });

  document.getElementById('passwordDialog').close();
  showToast('密码已重置');
}

window.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAdminSession();
  if (!user) return;
  initializeSelfPasswordChange();
  if (user.role !== 'super_admin') {
    window.location.href = '/admin';
    return;
  }

  document
    .getElementById('createUserButton')
    .addEventListener('click', () => {
      document.getElementById('userForm').reset();
      document.getElementById('userId').value = '';
      document.getElementById('userStatus').value = 'active';
      document.getElementById('userRole').value = 'operator';
      document.getElementById('userDialog').showModal();
    });
  document
    .getElementById('userForm')
    .addEventListener('submit', submitUserForm);
  document
    .getElementById('passwordForm')
    .addEventListener('submit', submitPasswordForm);
  document
    .getElementById('userCancelButton')
    .addEventListener('click', () => {
      document.getElementById('userDialog').close();
    });
  document
    .getElementById('passwordCancelButton')
    .addEventListener('click', () => {
      document.getElementById('passwordDialog').close();
    });
  document
    .getElementById('logoutButton')
    .addEventListener('click', async () => {
      await adminFetch('/api/admin/auth/logout', { method: 'POST' });
      window.location.href = '/admin/login';
    });

  await loadUsers();
});

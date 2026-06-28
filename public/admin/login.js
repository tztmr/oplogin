window.addEventListener('DOMContentLoaded', async () => {
  try {
    await adminFetch('/api/admin/auth/me', { method: 'GET' });
    window.location.href = '/admin';
    return;
  } catch (error) {
    // stay on login page
  }

  const form = document.getElementById('loginForm');
  const errorNode = document.getElementById('loginError');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorNode.hidden = true;

    const identifier = document.getElementById('identifier').value.trim();
    const password = document.getElementById('password').value;

    try {
      await adminFetch('/api/admin/auth/login', {
        method: 'POST',
        body: JSON.stringify({ identifier, password }),
      });
      window.location.href = '/admin';
    } catch (error) {
      errorNode.hidden = false;
      errorNode.textContent = error.message;
    }
  });
});

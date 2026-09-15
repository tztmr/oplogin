const originalRequireAdminSession = requireAdminSession;
let adminSessionPromise = null;

window.requireAdminSession = function requireAdminSessionOnce() {
  if (!adminSessionPromise) {
    adminSessionPromise = originalRequireAdminSession();
  }
  return adminSessionPromise;
};

function initializeAdminShell(user) {
  const navigationItems = Array.from(document.querySelectorAll('[data-section-target]'));
  const sections = Array.from(document.querySelectorAll('[data-admin-section]'));
  const isSuperAdmin = user && user.role === 'super_admin';
  const allowedSectionIds = new Set(['recordsSection', 'phoneInventorySection', 'shortOpsSection']);

  if (isSuperAdmin) {
    allowedSectionIds.add('opApplicationsSection');
  }

  document.querySelectorAll('[data-super-admin-only]').forEach((element) => {
    element.hidden = !isSuperAdmin;
  });
  window.AdminTableColumns?.initializeAll(user);

  const showSection = (sectionId) => {
    const nextSectionId = allowedSectionIds.has(sectionId) ? sectionId : 'recordsSection';
    sections.forEach((section) => {
      section.hidden = section.id !== nextSectionId;
    });
    navigationItems.forEach((item) => {
      item.classList.toggle('is-active', item.dataset.sectionTarget === nextSectionId);
      item.setAttribute?.('aria-current', item.dataset.sectionTarget === nextSectionId ? 'page' : 'false');
    });
    try { window.sessionStorage.setItem('admin.activeSection', nextSectionId); } catch { /* Navigation also works without storage. */ }
    window.dispatchEvent(new CustomEvent('admin-section-shown', {
      detail: { sectionId: nextSectionId },
    }));
  };

  navigationItems.forEach((item) => {
    item.addEventListener('click', () => showSection(item.dataset.sectionTarget));
  });

  let savedSection;
  try { savedSection = window.sessionStorage.getItem('admin.activeSection'); } catch { /* Use the default section. */ }
  showSection(savedSection);
}

window.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAdminSession();
  if (!user) return;
  initializeAdminShell(user);
});

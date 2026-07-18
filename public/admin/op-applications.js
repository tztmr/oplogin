let opApplicationsPage = 1;
let opApplicationsPageSize = '20';
let opApplicationsLoaded = false;
let opApplicationsTotalPages = 1;
let opApplicationsInitialized = false;
let opApplicationsAuthorized = false;

function createOpApplicationCell(value, className = '') {
  const cell = document.createElement('td');
  cell.className = className;
  cell.textContent = value === null || value === undefined ? '' : String(value);
  return cell;
}

function createOpApplicationButton(label, onClick, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function buildOpApplicationsQuery() {
  const query = new URLSearchParams({
    page: String(opApplicationsPage),
    pageSize: opApplicationsPageSize,
  });
  const search = document.getElementById('opApplicationsSearch').value.trim();
  const status = document.getElementById('opApplicationsStatusFilter').value;
  if (search) query.set('search', search);
  if (status) query.set('status', status);
  return query;
}

function updateOpApplicationsPagination(data) {
  const total = Number(data.total) || 0;
  const pageSize = Number(data.pageSize) || Number(opApplicationsPageSize) || 20;
  opApplicationsTotalPages = Math.max(1, Math.ceil(total / pageSize));
  document.getElementById('opApplicationsPageStatus').textContent = total
    ? `第 ${opApplicationsPage} / ${opApplicationsTotalPages} 页，共 ${total} 条`
    : '暂无数据';
  document.getElementById('opApplicationsPreviousPageButton').disabled = opApplicationsPage <= 1;
  document.getElementById('opApplicationsNextPageButton').disabled =
    opApplicationsPage >= opApplicationsTotalPages;
}

function notifyOpApplicationsChanged() {
  window.dispatchEvent(new CustomEvent('op-applications-changed'));
}

async function setOpApplicationDefault(item) {
  const confirmed = await showConfirm(`确认将“${item.name}”设为默认应用？`);
  if (!confirmed) return;
  await adminFetch(`/api/admin/op-applications/${encodeURIComponent(item.id)}/default`, {
    method: 'POST',
  });
  showToast('默认应用已更新');
  notifyOpApplicationsChanged();
  await loadOpApplications();
}

async function changeOpApplicationStatus(item) {
  const nextAction = item.status === 'active' ? 'disable' : 'enable';
  const nextLabel = nextAction === 'disable' ? '停用' : '启用';
  const confirmed = await showConfirm(`确认${nextLabel}应用“${item.name}”？`);
  if (!confirmed) return;
  await adminFetch(`/api/admin/op-applications/${encodeURIComponent(item.id)}/${nextAction}`, {
    method: 'POST',
  });
  showToast(`应用已${nextLabel}`);
  notifyOpApplicationsChanged();
  await loadOpApplications();
}

function openOpApplicationEditDialog(item) {
  document.getElementById('opApplicationForm').reset();
  document.getElementById('opApplicationDialogTitle').textContent = '编辑应用';
  document.getElementById('opApplicationId').value = item.id;
  document.getElementById('opApplicationName').value = item.name;
  document.getElementById('opApplicationAppId').value = item.appId;
  document.getElementById('opApplicationDialog').showModal();
}

function renderOpApplications(items) {
  const body = document.getElementById('opApplicationTableBody');
  if (!items.length) {
    const row = document.createElement('tr');
    const cell = createOpApplicationCell('没有符合条件的应用', 'empty-table-cell');
    cell.colSpan = 6;
    row.appendChild(cell);
    body.replaceChildren(row);
    return;
  }

  const rows = items.map((item) => {
    const row = document.createElement('tr');
    row.appendChild(createOpApplicationCell(item.name));
    row.appendChild(createOpApplicationCell(item.appId));

    const defaultCell = document.createElement('td');
    const defaultLabel = document.createElement('span');
    defaultLabel.className = item.isDefault ? 'default-label' : '';
    defaultLabel.textContent = item.isDefault ? '默认' : '否';
    defaultCell.appendChild(defaultLabel);
    row.appendChild(defaultCell);

    const statusCell = document.createElement('td');
    const statusLabel = document.createElement('span');
    statusLabel.className = item.status === 'active' ? 'status-label' : 'status-label is-disabled';
    statusLabel.textContent = item.status === 'active' ? '启用' : '停用';
    statusCell.appendChild(statusLabel);
    row.appendChild(statusCell);
    row.appendChild(createOpApplicationCell(formatDateTime(item.updatedAt)));

    const actionsCell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(createOpApplicationButton('编辑', () => openOpApplicationEditDialog(item)));
    if (!item.isDefault && item.status === 'active') {
      actions.appendChild(createOpApplicationButton('设为默认', () => {
        setOpApplicationDefault(item).catch((error) => showToast(error.message));
      }));
    }
    const statusButton = createOpApplicationButton(
      item.status === 'active' ? '停用' : '启用',
      () => changeOpApplicationStatus(item).catch((error) => showToast(error.message)),
    );
    if (item.isDefault && item.status === 'active') {
      statusButton.disabled = true;
      statusButton.textContent = '默认应用不可停用';
      statusButton.title = '默认应用不能停用，请先设置其他默认应用';
    }
    actions.appendChild(statusButton);
    actionsCell.appendChild(actions);
    row.appendChild(actionsCell);
    return row;
  });
  body.replaceChildren(...rows);
}

async function loadOpApplications(allowPageClamp = true) {
  if (!opApplicationsAuthorized) return;
  const data = await adminFetch(
    `/api/admin/op-applications?${buildOpApplicationsQuery().toString()}`,
    { method: 'GET' },
  );
  const total = Number(data.total) || 0;
  const pageSize = Number(data.pageSize) || Number(opApplicationsPageSize) || 20;
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  if (allowPageClamp && opApplicationsPage > lastPage) {
    opApplicationsPage = lastPage;
    return loadOpApplications(false);
  }
  opApplicationsLoaded = true;
  renderOpApplications(data.items || []);
  updateOpApplicationsPagination(data);
}

async function submitOpApplicationForm(event) {
  event.preventDefault();
  const id = document.getElementById('opApplicationId').value;
  const payload = {
    name: document.getElementById('opApplicationName').value.trim(),
    appId: document.getElementById('opApplicationAppId').value.trim(),
  };
  await adminFetch(
    id
      ? `/api/admin/op-applications/${encodeURIComponent(id)}`
      : '/api/admin/op-applications',
    {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    },
  );
  document.getElementById('opApplicationForm').reset();
  document.getElementById('opApplicationDialog').close();
  showToast(id ? '应用已更新' : '应用已创建');
  opApplicationsPage = 1;
  notifyOpApplicationsChanged();
  await loadOpApplications();
}

function initializeOpApplicationsControls() {
  if (opApplicationsInitialized) return;
  opApplicationsInitialized = true;
  document.getElementById('createOpApplicationButton').addEventListener('click', () => {
    document.getElementById('opApplicationForm').reset();
    document.getElementById('opApplicationDialogTitle').textContent = '新增应用';
    document.getElementById('opApplicationId').value = '';
    document.getElementById('opApplicationDialog').showModal();
  });
  document.getElementById('opApplicationCancelButton').addEventListener('click', () => {
    document.getElementById('opApplicationDialog').close();
  });
  document.getElementById('opApplicationForm').addEventListener('submit', (event) => {
    submitOpApplicationForm(event).catch((error) => showToast(error.message));
  });
  document.getElementById('applyOpApplicationsFiltersButton').addEventListener('click', () => {
    opApplicationsPage = 1;
    loadOpApplications().catch((error) => showToast(error.message));
  });
  document.getElementById('resetOpApplicationsFiltersButton').addEventListener('click', () => {
    document.getElementById('opApplicationsSearch').value = '';
    document.getElementById('opApplicationsStatusFilter').value = '';
    opApplicationsPage = 1;
    loadOpApplications().catch((error) => showToast(error.message));
  });
  document.getElementById('opApplicationsPreviousPageButton').addEventListener('click', () => {
    opApplicationsPage = Math.max(1, opApplicationsPage - 1);
    loadOpApplications().catch((error) => showToast(error.message));
  });
  document.getElementById('opApplicationsNextPageButton').addEventListener('click', () => {
    if (opApplicationsPage < opApplicationsTotalPages) opApplicationsPage += 1;
    loadOpApplications().catch((error) => showToast(error.message));
  });
  document.getElementById('opApplicationsPageSizeSelect').addEventListener('change', (event) => {
    opApplicationsPageSize = event.target.value;
    opApplicationsPage = 1;
    loadOpApplications().catch((error) => showToast(error.message));
  });
}

async function showOpApplicationsForAuthorizedUser() {
  const user = await requireAdminSession();
  if (!user || user.role !== 'super_admin') return;
  opApplicationsAuthorized = true;
  initializeOpApplicationsControls();
  if (!opApplicationsLoaded) {
    await loadOpApplications();
  }
}

window.addEventListener('admin-section-shown', (event) => {
  if (event.detail.sectionId !== 'opApplicationsSection') return;
  showOpApplicationsForAuthorizedUser().catch((error) => showToast(error.message));
});

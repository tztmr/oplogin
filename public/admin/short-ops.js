let shortOpsPage = 1;
let shortOpsPageSize = '20';
let shortOpsLoaded = false;
let shortOpsTotalPages = 1;
let shortOpsInitialized = false;
let shortOpApplicationOptions = [];
let shortOpApplicationOptionsLoaded = false;
let shortOpApplicationOptionsPromise = null;
let shortOpsInitialLoadPromise = null;
let shortOpsRequestGeneration = 0;
let shortOpsShowOwner = false;
let shortOpsRolePromise = null;

function createShortOpsCell(value, className = '') {
  const cell = document.createElement('td');
  cell.className = className;
  cell.textContent = value === null || value === undefined ? '' : String(value);
  if (className.includes('cell-truncate')) {
    cell.title = cell.textContent;
  }
  return cell;
}

function createShortOpsButton(label, onClick, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function fallbackCopyShortOpLink(value) {
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute?.('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    return document.execCommand('copy');
  } catch (error) {
    return false;
  } finally {
    textarea.remove();
  }
}

async function copyShortOpText(value) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch (error) {
      // Clipboard permission can be denied; continue with the safe DOM fallback.
    }
  }
  return fallbackCopyShortOpLink(value);
}

function copyShortOpLink(shortLink) {
  return copyShortOpText(new URL(shortLink, window.location.origin).toString());
}

function copyShortOpCode(code) {
  return copyShortOpText(String(code || ''));
}

function appendEmptyShortOpsRow(message) {
  const row = document.createElement('tr');
  const cell = createShortOpsCell(message, 'empty-table-cell');
  cell.colSpan = shortOpsShowOwner ? 10 : 9;
  row.appendChild(cell);
  document.getElementById('shortOpTableBody').replaceChildren(row);
}

function replaceShortOpApplicationSelectOptions(select, includeAllOption, selectedId = '') {
  const options = [];
  if (includeAllOption) {
    const allOption = document.createElement('option');
    allOption.value = '';
    allOption.textContent = '全部应用';
    options.push(allOption);
  }
  shortOpApplicationOptions.forEach((application) => {
    const option = document.createElement('option');
    option.value = application.id;
    option.textContent = application.isDefault
      ? `${application.name}（默认）`
      : application.name;
    options.push(option);
  });
  select.replaceChildren(...options);
  if (selectedId) {
    select.value = selectedId;
  } else if (!includeAllOption && shortOpApplicationOptions[0]) {
    select.value = shortOpApplicationOptions[0].id;
  }
}

async function loadShortOpApplicationOptions() {
  const data = await adminFetch('/api/admin/op-applications?status=active&pageSize=all', {
    method: 'GET',
  });
  shortOpApplicationOptions = (data.items || []).slice().sort((left, right) => {
    if (left.isDefault === right.isDefault) return 0;
    return left.isDefault ? -1 : 1;
  });
  replaceShortOpApplicationSelectOptions(
    document.getElementById('shortOpsApplicationFilter'),
    true,
  );
  replaceShortOpApplicationSelectOptions(
    document.getElementById('shortOpApplicationId'),
    false,
  );
  shortOpApplicationOptionsLoaded = true;
}

function ensureShortOpApplicationOptions() {
  if (shortOpApplicationOptionsLoaded) return Promise.resolve();
  if (!shortOpApplicationOptionsPromise) {
    shortOpApplicationOptionsPromise = loadShortOpApplicationOptions()
      .finally(() => {
        shortOpApplicationOptionsPromise = null;
      });
  }
  return shortOpApplicationOptionsPromise;
}

function ensureShortOpsRole() {
  if (!shortOpsRolePromise) {
    shortOpsRolePromise = requireAdminSession().then((user) => {
      shortOpsShowOwner = Boolean(user && user.role === 'super_admin');
      document.getElementById('shortOpsOwnerColumn').hidden = !shortOpsShowOwner;
      document.getElementById('shortOpsOwnerHeader').hidden = !shortOpsShowOwner;
    });
  }
  return shortOpsRolePromise;
}

function buildShortOpsQuery() {
  if (shortOpsPageSize === 'all') shortOpsPage = 1;
  const query = new URLSearchParams({
    page: String(shortOpsPage),
    pageSize: shortOpsPageSize,
  });
  const search = document.getElementById('shortOpsSearch').value.trim();
  const status = document.getElementById('shortOpsStatusFilter').value;
  const applicationId = document.getElementById('shortOpsApplicationFilter').value;
  const opExpireFrom = document.getElementById('shortOpsExpireFrom').value;
  const opExpireTo = document.getElementById('shortOpsExpireTo').value;
  if (search) query.set('search', search);
  if (status) query.set('status', status);
  if (applicationId) query.set('applicationId', applicationId);
  if (opExpireFrom) query.set('opExpireFrom', opExpireFrom);
  if (opExpireTo) query.set('opExpireTo', opExpireTo);
  return query;
}

function updateShortOpsPagination(data) {
  const total = Number(data.total) || 0;
  const allRows = data.pageSize === 'all' || shortOpsPageSize === 'all';
  const pageSize = allRows ? total || 1 : Number(data.pageSize) || Number(shortOpsPageSize) || 20;
  if (allRows) shortOpsPage = 1;
  shortOpsTotalPages = allRows ? 1 : Math.max(1, Math.ceil(total / pageSize));
  document.getElementById('shortOpsPageStatus').textContent = total
    ? `第 ${shortOpsPage} / ${shortOpsTotalPages} 页，共 ${total} 条`
    : '暂无数据';
  document.getElementById('shortOpsPreviousPageButton').disabled = shortOpsPage <= 1;
  document.getElementById('shortOpsNextPageButton').disabled = shortOpsPage >= shortOpsTotalPages;
}

async function changeShortOpStatus(item) {
  const nextAction = item.status === 'active' ? 'disable' : 'enable';
  const nextLabel = nextAction === 'disable' ? '停用' : '启用';
  const confirmed = await showConfirm(`确认${nextLabel}短码 ${item.code}？`);
  if (!confirmed) return;
  await adminFetch(`/api/admin/short-ops/${encodeURIComponent(item.id)}/${nextAction}`, {
    method: 'POST',
  });
  showToast(`短 OP 已${nextLabel}`);
  await loadShortOps();
}

async function deleteShortOp(item) {
  const confirmed = await showConfirm(`确认删除短码 ${item.code}？删除后无法恢复。`, {
    confirmText: '删除',
    tone: 'danger',
  });
  if (!confirmed) return;
  await adminFetch(`/api/admin/short-ops/${encodeURIComponent(item.id)}`, {
    method: 'DELETE',
  });
  showToast('短 OP 已删除');
  await loadShortOps();
}

async function openShortOpEditDialog(item) {
  const data = await adminFetch(`/api/admin/short-ops/${encodeURIComponent(item.id)}`, {
    method: 'GET',
  });
  const detail = data.item;
  document.getElementById('shortOpDialogTitle').textContent = '编辑短 OP';
  document.getElementById('shortOpId').value = detail.id;
  document.getElementById('shortOpValue').value = detail.opValue;
  replaceShortOpApplicationSelectOptions(
    document.getElementById('shortOpApplicationId'),
    false,
    detail.applicationId,
  );
  document.getElementById('shortOpRemark').value = detail.remark || '';
  document.getElementById('shortOpDialog').showModal();
}

function renderShortOps(items) {
  const body = document.getElementById('shortOpTableBody');
  if (!items.length) {
    appendEmptyShortOpsRow('没有符合条件的短 OP');
    return;
  }
  const rows = items.map((item) => {
    const row = document.createElement('tr');
    row.appendChild(createShortOpsCell(item.code));
    row.appendChild(createShortOpsCell(item.shortLink, 'cell-truncate'));
    row.appendChild(createShortOpsCell(item.appName || '', 'cell-truncate'));
    row.appendChild(createShortOpsCell(item.appId || '', 'cell-truncate'));
    row.appendChild(createShortOpsCell(item.maskedOpValue, 'cell-truncate'));
    row.appendChild(createShortOpsCell(formatDateTime(item.opExpireAt)));

    const statusCell = document.createElement('td');
    const status = document.createElement('span');
    status.className = item.status === 'active' ? 'status-label' : 'status-label is-disabled';
    status.textContent = item.status === 'active' ? '启用' : '停用';
    statusCell.appendChild(status);
    row.appendChild(statusCell);
    if (shortOpsShowOwner) {
      row.appendChild(createShortOpsCell(item.owner || ''));
    }
    row.appendChild(createShortOpsCell(item.remark || '', 'cell-truncate'));

    const actionsCell = document.createElement('td');
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    actions.appendChild(createShortOpsButton('复制链接', () => {
      copyShortOpLink(item.shortLink)
        .then((copied) => showToast(copied ? '短链接已复制' : '复制失败，请手动复制'));
    }));
    actions.appendChild(createShortOpsButton('复制短码', () => {
      copyShortOpCode(item.code)
        .then((copied) => showToast(copied ? '短码已复制' : '复制失败，请手动复制'));
    }));
    actions.appendChild(createShortOpsButton('编辑', () => {
      openShortOpEditDialog(item).catch((error) => showToast(error.message));
    }));
    actions.appendChild(createShortOpsButton(
      item.status === 'active' ? '停用' : '启用',
      () => changeShortOpStatus(item).catch((error) => showToast(error.message)),
    ));
    actions.appendChild(createShortOpsButton('删除', () => {
      deleteShortOp(item).catch((error) => showToast(error.message));
    }, 'btn-danger'));
    actionsCell.appendChild(actions);
    row.appendChild(actionsCell);
    return row;
  });
  body.replaceChildren(...rows);
}

async function loadShortOps(allowPageClamp = true) {
  const requestGeneration = ++shortOpsRequestGeneration;
  const data = await adminFetch(`/api/admin/short-ops?${buildShortOpsQuery().toString()}`, {
    method: 'GET',
  });
  if (requestGeneration !== shortOpsRequestGeneration) return;
  const total = Number(data.total) || 0;
  const allRows = data.pageSize === 'all' || shortOpsPageSize === 'all';
  const pageSize = allRows ? total || 1 : Number(data.pageSize) || Number(shortOpsPageSize) || 20;
  const lastPage = allRows ? 1 : Math.max(1, Math.ceil(total / pageSize));
  if (allowPageClamp && shortOpsPage > lastPage) {
    shortOpsPage = lastPage;
    return loadShortOps(false);
  }
  shortOpsLoaded = true;
  renderShortOps(data.items || []);
  updateShortOpsPagination(data);
}

function loadInitialShortOps() {
  if (shortOpsLoaded) return Promise.resolve();
  if (!shortOpsInitialLoadPromise) {
    shortOpsInitialLoadPromise = loadShortOps()
      .finally(() => {
        shortOpsInitialLoadPromise = null;
      });
  }
  return shortOpsInitialLoadPromise;
}

async function openCreateShortOpDialog() {
  await ensureShortOpApplicationOptions();
  if (!shortOpApplicationOptions.length) {
    showToast('没有可用应用，请联系超级管理员先启用应用');
    return;
  }
  document.getElementById('shortOpForm').reset();
  document.getElementById('shortOpDialogTitle').textContent = '新增短 OP';
  document.getElementById('shortOpId').value = '';
  replaceShortOpApplicationSelectOptions(
    document.getElementById('shortOpApplicationId'),
    false,
  );
  document.getElementById('shortOpDialog').showModal();
}

async function submitShortOpForm(event) {
  event.preventDefault();
  const id = document.getElementById('shortOpId').value;
  const payload = {
    opValue: document.getElementById('shortOpValue').value.trim(),
    applicationId: document.getElementById('shortOpApplicationId').value,
    remark: document.getElementById('shortOpRemark').value.trim(),
  };
  await adminFetch(id ? `/api/admin/short-ops/${encodeURIComponent(id)}` : '/api/admin/short-ops', {
    method: id ? 'PUT' : 'POST',
    body: JSON.stringify(payload),
  });
  document.getElementById('shortOpForm').reset();
  document.getElementById('shortOpDialog').close();
  showToast(id ? '短 OP 已更新' : '短 OP 已创建');
  shortOpsPage = 1;
  await loadShortOps();
}

function renderShortOpImportResult(data) {
  document.getElementById('shortOpImportSummary').textContent =
    `成功 ${data.importedCount || 0}，重复 ${data.duplicateCount || 0}，失败 ${data.failedCount || 0}`;
  const errorItems = (data.errors || []).map((error) => {
    const item = document.createElement('li');
    item.textContent = `第 ${error.lineNumber} 行：${error.message}`;
    return item;
  });
  document.getElementById('shortOpImportErrors').replaceChildren(...errorItems);
}

async function submitShortOpImport(event) {
  event.preventDefault();
  const submitButton = document.getElementById('shortOpImportSubmitButton');
  submitButton.disabled = true;
  try {
    const data = await adminFetch('/api/admin/short-ops/import-text', {
      method: 'POST',
      body: JSON.stringify({
        rowsText: document.getElementById('shortOpImportText').value,
      }),
    });
    renderShortOpImportResult(data);
    showToast('短 OP 批量导入完成');
    shortOpsPage = 1;
    await loadShortOps();
  } finally {
    submitButton.disabled = false;
  }
}

async function initializeShortOps() {
  if (!shortOpsInitialized) {
    shortOpsInitialized = true;
    document.getElementById('createShortOpButton').addEventListener('click', () => {
      openCreateShortOpDialog().catch((error) => showToast(error.message));
    });
    document.getElementById('shortOpImportButton').addEventListener('click', () => {
      document.getElementById('shortOpImportForm').reset();
      document.getElementById('shortOpImportSummary').textContent = '';
      document.getElementById('shortOpImportErrors').replaceChildren();
      document.getElementById('shortOpImportDialog').showModal();
    });
    document.getElementById('shortOpForm').addEventListener('submit', (event) => {
      submitShortOpForm(event).catch((error) => showToast(error.message));
    });
    document.getElementById('shortOpImportForm').addEventListener('submit', (event) => {
      submitShortOpImport(event).catch((error) => showToast(error.message));
    });
    document.getElementById('shortOpCancelButton').addEventListener('click', () => {
      document.getElementById('shortOpDialog').close();
    });
    document.getElementById('shortOpImportCancelButton').addEventListener('click', () => {
      document.getElementById('shortOpImportDialog').close();
    });
    document.getElementById('applyShortOpsFiltersButton').addEventListener('click', () => {
      shortOpsPage = 1;
      loadShortOps().catch((error) => showToast(error.message));
    });
    document.getElementById('resetShortOpsFiltersButton').addEventListener('click', () => {
      document.getElementById('shortOpsSearch').value = '';
      document.getElementById('shortOpsStatusFilter').value = '';
      document.getElementById('shortOpsApplicationFilter').value = '';
      document.getElementById('shortOpsExpireFrom').value = '';
      document.getElementById('shortOpsExpireTo').value = '';
      shortOpsPage = 1;
      loadShortOps().catch((error) => showToast(error.message));
    });
    document.getElementById('shortOpsPreviousPageButton').addEventListener('click', () => {
      shortOpsPage = Math.max(1, shortOpsPage - 1);
      loadShortOps().catch((error) => showToast(error.message));
    });
    document.getElementById('shortOpsNextPageButton').addEventListener('click', () => {
      if (shortOpsPage < shortOpsTotalPages) shortOpsPage += 1;
      loadShortOps().catch((error) => showToast(error.message));
    });
    document.getElementById('shortOpsPageSizeSelect').addEventListener('change', (event) => {
      shortOpsPageSize = event.target.value;
      shortOpsPage = 1;
      loadShortOps().catch((error) => showToast(error.message));
    });
  }
  await Promise.all([
    ensureShortOpApplicationOptions(),
    ensureShortOpsRole(),
  ]);
}

window.addEventListener('admin-section-shown', (event) => {
  if (event.detail.sectionId !== 'shortOpsSection') return;
  initializeShortOps()
    .then(() => {
      if (!shortOpsLoaded) return loadInitialShortOps();
      return null;
    })
    .catch((error) => showToast(error.message));
});

window.addEventListener('op-applications-changed', () => {
  if (!shortOpsInitialized) return;
  shortOpApplicationOptionsLoaded = false;
  ensureShortOpApplicationOptions().catch((error) => showToast(error.message));
});

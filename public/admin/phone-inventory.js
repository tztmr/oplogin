let phoneInventoryPage = 1;
let phoneInventoryTotalPages = 1;
let phoneInventoryGeneration = 0;
let phoneInventoryInitialized = false;
let phoneInventoryStatusTargetIds = [];
let phoneInventoryStatusSubmitting = false;
const selectedPhoneInventoryIds = new Set();
let currentPagePhoneInventoryIds = [];
const phoneInventoryExtractionLabels = {
  available: '待提取', reserved: '已提取', bound: '已入库', after_sale: '不再分配',
};

function phoneInventoryCell(value) {
  const cell = document.createElement('td');
  cell.textContent = value == null ? '' : String(value);
  return cell;
}

function getSelectedPhoneInventoryIds() {
  return Array.from(selectedPhoneInventoryIds);
}

function syncPhoneInventoryBatchState() {
  const selectedCount = selectedPhoneInventoryIds.size;
  const selectionText = document.getElementById('phoneInventorySelectionText');
  if (selectionText) selectionText.textContent = `已选 ${selectedCount} 条`;
  const deleteButton = document.getElementById('phoneInventoryBatchDeleteButton');
  if (deleteButton) {
    deleteButton.disabled = selectedCount === 0;
    deleteButton.textContent = selectedCount > 0 ? `批量删除手机号 (${selectedCount})` : '批量删除手机号';
  }
  const statusButton = document.getElementById('phoneInventoryBatchStatusButton');
  if (statusButton) {
    statusButton.disabled = selectedCount === 0;
    statusButton.textContent = selectedCount > 0
      ? `批量更改手机号状态 (${selectedCount})`
      : '批量更改手机号状态';
  }
  const selectAll = document.getElementById('selectAllPhoneInventoryCheckbox');
  if (!selectAll) return;
  const totalVisible = currentPagePhoneInventoryIds.length;
  const selectedVisible = currentPagePhoneInventoryIds.filter((id) =>
    selectedPhoneInventoryIds.has(id),
  ).length;
  selectAll.checked = totalVisible > 0 && selectedVisible === totalVisible;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < totalVisible;
  selectAll.disabled = totalVisible === 0;
}

function togglePhoneInventorySelection(id, checked) {
  if (!id) return;
  if (checked) selectedPhoneInventoryIds.add(id);
  else selectedPhoneInventoryIds.delete(id);
  syncPhoneInventoryBatchState();
}

function renderPhoneInventory(items) {
  const body = document.getElementById('phoneInventoryTableBody');
  currentPagePhoneInventoryIds = items.map((item) => item.id).filter(Boolean);
  for (const selectedId of Array.from(selectedPhoneInventoryIds)) {
    if (!currentPagePhoneInventoryIds.includes(selectedId)) {
      selectedPhoneInventoryIds.delete(selectedId);
    }
  }
  const rows = items.map((item) => {
    const row = document.createElement('tr');
    const selectCell = document.createElement('td');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = selectedPhoneInventoryIds.has(item.id);
    checkbox.addEventListener('change', (event) => {
      togglePhoneInventorySelection(item.id, event.target.checked);
    });
    selectCell.appendChild(checkbox);
    row.appendChild(selectCell);
    row.appendChild(phoneInventoryCell(item.phoneNumber));
    row.appendChild(phoneInventoryCell({ available: '未绑定', reserved: '未绑定', bound: '已绑定', after_sale: '老号售后' }[item.status] || '未知'));
    const extraction = phoneInventoryCell(phoneInventoryExtractionLabels[item.status] || '');
    extraction.className = 'phone-inventory-extraction-cell';
    const statusButton = document.createElement('button');
    statusButton.type = 'button';
    statusButton.className = 'btn-cancel';
    statusButton.textContent = '修改状态';
    statusButton.setAttribute('aria-label', `修改 ${item.phoneNumber} 的状态`);
    statusButton.addEventListener('click', () => openPhoneInventoryStatusDialog(item));
    extraction.appendChild(statusButton);
    row.appendChild(extraction);
    const sms = phoneInventoryCell('');
    try {
      const url = new URL(item.phoneSmsUrl);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('unsupported URL');
      const link = document.createElement('a');
      link.href = url.href;
      link.textContent = item.phoneSmsUrl;
      link.title = item.phoneSmsUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      sms.appendChild(link);
    } catch {
      sms.textContent = item.phoneSmsUrl || '—';
    }
    row.appendChild(sms);
    row.appendChild(phoneInventoryCell(formatDateTime(item.phoneExpireAt) || '—'));
    row.appendChild(phoneInventoryCell(item.phoneModel));
    row.appendChild(phoneInventoryCell(formatDateTime(item.createdAt)));
    row.appendChild(phoneInventoryCell(formatDateTime(item.updatedAt)));
    return row;
  });
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = phoneInventoryCell('暂无符合条件的手机号，请导入号码或调整筛选条件。');
    cell.colSpan = 9;
    row.appendChild(cell);
    rows.push(row);
  }
  body.replaceChildren(...rows);
  window.AdminTableColumns?.refresh('phoneInventoryTable');
  syncPhoneInventoryBatchState();
}

async function loadPhoneInventory() {
  const generation = ++phoneInventoryGeneration;
  const status = document.getElementById('phoneInventoryLoadStatus');
  const previous = document.getElementById('phoneInventoryPreviousButton');
  const next = document.getElementById('phoneInventoryNextButton');
  previous.disabled = true;
  next.disabled = true;
  status.textContent = '正在加载手机号库存…';
  const query = new URLSearchParams({
    page: String(phoneInventoryPage),
    pageSize: document.getElementById('phoneInventoryPageSize').value || '20',
  });
  const search = document.getElementById('phoneInventorySearch').value.trim();
  const filter = document.getElementById('phoneInventoryStatusFilter').value;
  if (search) query.set('search', search);
  if (filter) query.set('status', filter);
  try {
    const data = await adminFetch(`/api/admin/records/phone-inventory?${query}`, { method: 'GET', cache: 'no-store' });
    if (generation !== phoneInventoryGeneration) return;
    phoneInventoryPage = data.page;
    phoneInventoryTotalPages = Math.max(1, Math.ceil(data.total / data.pageSize));
    renderPhoneInventory(data.items);
    document.getElementById('phoneInventoryPageStatus').textContent = `第 ${data.page} / ${phoneInventoryTotalPages} 页，共 ${data.total} 个手机号`;
    status.textContent = '';
  } catch (error) {
    if (generation !== phoneInventoryGeneration) return;
    status.textContent = `库存加载失败：${error.message || '请稍后重试'}。已导入的数据不会丢失，请点击刷新列表。`;
  } finally {
    if (generation === phoneInventoryGeneration) {
      previous.disabled = phoneInventoryPage <= 1;
      next.disabled = phoneInventoryPage >= phoneInventoryTotalPages;
    }
  }
}

async function refreshPhoneInventoryAfterImport() {
  phoneInventoryPage = 1;
  document.getElementById('phoneInventorySearch').value = '';
  document.getElementById('phoneInventoryStatusFilter').value = '';
  await loadPhoneInventory();
}

async function deleteSelectedPhoneInventory() {
  const ids = getSelectedPhoneInventoryIds();
  if (!ids.length) {
    showToast('请先勾选要删除的手机号');
    return;
  }
  if (!(await showConfirm(`确认永久删除已勾选的 ${ids.length} 个手机号吗？删除后无法从库存恢复。`, {
    confirmText: '删除',
    tone: 'danger',
  }))) {
    return;
  }
  const data = await adminFetch('/api/admin/records/phone-inventory/batch-delete', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  });
  if (data.deletedCount > 0) {
    selectedPhoneInventoryIds.clear();
    await loadPhoneInventory();
    showToast(`已删除 ${data.deletedCount} 个手机号`);
    return;
  }
  showToast('未删除任何手机号，请重新勾选后再试');
}

function openPhoneInventoryStatusDialog(item) {
  if (phoneInventoryStatusSubmitting) return;
  const ids = item ? [item.id] : getSelectedPhoneInventoryIds();
  if (!ids.length) {
    showToast('请先勾选要更改状态的手机号');
    return;
  }
  phoneInventoryStatusTargetIds = ids;
  document.getElementById('phoneInventoryStatusDialogTitle').textContent = item
    ? '修改手机号状态'
    : '批量更改手机号状态';
  document.getElementById('phoneInventoryStatusTarget').textContent = item
    ? `${item.phoneNumber} · 当前提取情况：${phoneInventoryExtractionLabels[item.status] || '未知'}`
    : `已选 ${ids.length} 个手机号`;
  document.getElementById('phoneInventoryStatusSelect').value = item && ['reserved', 'bound', 'after_sale'].includes(item.status)
    ? item.status
    : 'unbound';
  const dialog = document.getElementById('phoneInventoryStatusDialog');
  if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
}

async function submitPhoneInventoryStatusForm(event) {
  event.preventDefault();
  if (phoneInventoryStatusSubmitting) return;
  const ids = phoneInventoryStatusTargetIds.slice();
  if (!ids.length) {
    showToast('请先勾选要更改状态的手机号');
    return;
  }
  const select = document.getElementById('phoneInventoryStatusSelect');
  const status = select.value;
  const submitButton = document.getElementById('phoneInventoryStatusSubmitButton');
  const cancelButton = document.getElementById('phoneInventoryStatusCancelButton');
  const dialog = document.getElementById('phoneInventoryStatusDialog');
  phoneInventoryStatusSubmitting = true;
  submitButton.disabled = true;
  submitButton.textContent = '正在保存…';
  cancelButton.disabled = true;
  select.disabled = true;
  try {
    const data = await adminFetch('/api/admin/records/phone-inventory/batch-status', {
      method: 'POST',
      body: JSON.stringify({ ids, status }),
    });
    phoneInventoryStatusTargetIds = [];
    if (dialog && typeof dialog.close === 'function') dialog.close();
    if (data.updatedCount > 0) {
      ids.forEach((id) => selectedPhoneInventoryIds.delete(id));
      syncPhoneInventoryBatchState();
      await loadPhoneInventory();
      showToast(`已更改 ${data.updatedCount} 个手机号状态`);
      return;
    }
    showToast('状态未发生变化，请刷新列表后查看');
  } finally {
    phoneInventoryStatusSubmitting = false;
    submitButton.disabled = false;
    submitButton.textContent = '确认更改';
    cancelButton.disabled = false;
    select.disabled = false;
  }
}

function initializePhoneInventory() {
  if (phoneInventoryInitialized) return;
  phoneInventoryInitialized = true;
  document.getElementById('phoneInventoryFilterForm').addEventListener('submit', (event) => {
    event.preventDefault();
    phoneInventoryPage = 1;
    void loadPhoneInventory();
  });
  document.getElementById('phoneInventoryRefreshButton').addEventListener('click', () => { void loadPhoneInventory(); });
  document.getElementById('phoneInventoryResetButton').addEventListener('click', () => { void refreshPhoneInventoryAfterImport(); });
  document.getElementById('phoneInventoryPreviousButton').addEventListener('click', () => {
    phoneInventoryPage = Math.max(1, phoneInventoryPage - 1);
    void loadPhoneInventory();
  });
  document.getElementById('phoneInventoryNextButton').addEventListener('click', () => {
    phoneInventoryPage = Math.min(phoneInventoryTotalPages, phoneInventoryPage + 1);
    void loadPhoneInventory();
  });
  document.getElementById('phoneInventoryPageSize').addEventListener('change', () => {
    phoneInventoryPage = 1;
    void loadPhoneInventory();
  });
  document.getElementById('phoneInventoryBatchDeleteButton').addEventListener('click', () => {
    void deleteSelectedPhoneInventory().catch((error) => showToast(error.message || '删除失败'));
  });
  document.getElementById('phoneInventoryBatchStatusButton').addEventListener('click', () => {
    openPhoneInventoryStatusDialog();
  });
  document.getElementById('phoneInventoryStatusForm').addEventListener('submit', (event) => {
    void submitPhoneInventoryStatusForm(event).catch((error) => showToast(error.message || '更改状态失败'));
  });
  document.getElementById('phoneInventoryStatusCancelButton').addEventListener('click', () => {
    const dialog = document.getElementById('phoneInventoryStatusDialog');
    if (dialog && typeof dialog.close === 'function') dialog.close();
  });
  document.getElementById('phoneInventoryStatusDialog').addEventListener('close', () => {
    phoneInventoryStatusTargetIds = [];
  });
  document.getElementById('phoneInventoryStatusDialog').addEventListener('cancel', (event) => {
    if (phoneInventoryStatusSubmitting) event.preventDefault();
  });
  document.getElementById('selectAllPhoneInventoryCheckbox').addEventListener('change', (event) => {
    const checked = event.target.checked;
    if (checked) currentPagePhoneInventoryIds.forEach((id) => selectedPhoneInventoryIds.add(id));
    else currentPagePhoneInventoryIds.forEach((id) => selectedPhoneInventoryIds.delete(id));
    const body = document.getElementById('phoneInventoryTableBody');
    if (body && typeof body.querySelectorAll === 'function') {
      body.querySelectorAll('input[type="checkbox"]').forEach((checkbox) => {
        checkbox.checked = checked;
      });
    }
    syncPhoneInventoryBatchState();
  });
}

window.addEventListener('admin-section-shown', (event) => {
  if (event.detail.sectionId !== 'phoneInventorySection') return;
  initializePhoneInventory();
  void loadPhoneInventory();
});

let currentPage = 1;
let currentPageSize = '20';
const selectedRecordIds = new Set();
let currentPageRecordIds = [];
let batchImportProgressTimer = null;
let batchDeleteProgressTimer = null;

function buildDerivedOpLink(opValue) {
  const normalizedOpValue = String(opValue || '').trim();
  return normalizedOpValue
    ? `/oplogin/${encodeURIComponent(normalizedOpValue)}`
    : '';
}

function deriveOpExpireAt(opValue) {
  const normalizedOpValue = String(opValue || '').trim();
  if (!normalizedOpValue) return '';

  const parts = normalizedOpValue.split('|').map((item) => item.trim());
  const timestamp = Number(parts[4]);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return '';
  }

  return new Date(timestamp * 1000).toISOString();
}

function collectRecordFilters() {
  return {
    page: currentPage,
    pageSize: currentPageSize,
    googleAccount: document.getElementById('filterGoogleAccount').value.trim(),
    googlePassword: document.getElementById('filterGooglePassword').value.trim(),
    googleAssist: document.getElementById('filterGoogleAssist').value.trim(),
    googleExpireFrom: document.getElementById('filterGoogleExpireFrom').value,
    googleExpireTo: document.getElementById('filterGoogleExpireTo').value,
    uidValue: document.getElementById('filterUidValue').value.trim(),
    uidCreatedFrom: document.getElementById('filterUidCreatedFrom').value,
    uidCreatedTo: document.getElementById('filterUidCreatedTo').value,
    opValue: document.getElementById('filterOpValue').value.trim(),
    opLink: document.getElementById('filterOpLink').value.trim(),
    opExpireFrom: document.getElementById('filterOpExpireFrom').value,
    opExpireTo: document.getElementById('filterOpExpireTo').value,
    remark: document.getElementById('filterRemark').value.trim(),
  };
}

function getSelectedRecordIds() {
  return Array.from(selectedRecordIds);
}

function toQueryString(filters) {
  return new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value),
  ).toString();
}

function escapeHtmlAttribute(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderTruncatedText(value, className) {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return '';
  }

  const safeValue = escapeHtmlAttribute(normalizedValue);
  return `<span class="cell-truncate ${className}" title="${safeValue}">${normalizedValue}</span>`;
}

function renderTruncatedLink(value) {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return '';
  }

  const safeValue = escapeHtmlAttribute(normalizedValue);
  return `<a class="cell-truncate cell-truncate-link" href="${normalizedValue}" target="_blank" rel="noreferrer" title="${safeValue}">${normalizedValue}</a>`;
}

function renderRows(data) {
  const items = data.items;
  const isAllPageSize = currentPageSize === 'all';
  const effectivePageSize = isAllPageSize ? Math.max(data.total, 1) : data.pageSize;
  const startIndex = isAllPageSize ? 0 : (data.page - 1) * effectivePageSize;

  const tbody = document.getElementById('recordTableBody');
  currentPageRecordIds = items.map((item) => item.id);
  for (const selectedId of Array.from(selectedRecordIds)) {
    if (!currentPageRecordIds.includes(selectedId)) {
      selectedRecordIds.delete(selectedId);
    }
  }
  tbody.innerHTML = items
    .map(
      (item, index) => `
        <tr>
          <td>
            <input
              type="checkbox"
              aria-label="选择 ${item.googleAccount}"
              ${selectedRecordIds.has(item.id) ? 'checked' : ''}
              onchange="window.toggleRecordSelection('${item.id}', this.checked)"
            />
          </td>
          <td>${item.distributionOrder || (startIndex + index + 1)}</td>
          <td>${item.googleAccount}</td>
          <td>${item.googlePassword}</td>
          <td>${item.googleAssist}</td>
          <td>${formatDateTime(item.googleExpireAt)}</td>
          <td>${item.uidValue}</td>
          <td>${formatDateTime(item.uidCreatedAt)}</td>
          <td>${renderTruncatedText(item.opValue, 'cell-truncate-op')}</td>
          <td>${renderTruncatedLink(item.opLink)}</td>
          <td>${formatDateTime(item.opExpireAt)}</td>
          <td>${item.remark || ''}</td>
          <td>
            <div class="row-actions">
              <button type="button" onclick="window.openEditRecord('${item.id}')">编辑</button>
              <button type="button" onclick="window.deleteRecord('${item.id}')">删除</button>
            </div>
          </td>
        </tr>
      `,
    )
    .join('');
  syncBatchDeleteState();
}

function toDateTimeLocalValue(value) {
  return value ? new Date(value).toISOString().slice(0, 16) : '';
}

function renderPagination(data) {
  const pageStatus = document.getElementById('pageStatus');
  const previousButton = document.getElementById('previousPageButton');
  const nextButton = document.getElementById('nextPageButton');
  const isAllPageSize = currentPageSize === 'all';
  const effectivePageSize = isAllPageSize ? Math.max(data.total, 1) : data.pageSize;
  const totalPages = isAllPageSize
    ? 1
    : Math.max(1, Math.ceil(data.total / effectivePageSize));

  pageStatus.textContent = isAllPageSize
    ? `已显示全部 ${data.total} 条记录`
    : `第 ${data.page} / ${totalPages} 页，共 ${data.total} 条`;
  previousButton.disabled = isAllPageSize || data.page <= 1;
  nextButton.disabled = isAllPageSize || data.page >= totalPages;
}

function renderPublicBatchEligibility(data) {
  const card = document.getElementById('publicBatchEligibilityCard');
  const summary = document.getElementById('publicBatchEligibilitySummary');
  const details = document.getElementById('publicBatchEligibilityDetails');
  const stats = data.publicBatchEligibility;

  if (!stats) {
    card.hidden = true;
    return;
  }

  card.hidden = false;
  card.classList.toggle('has-warning', stats.blockedTotalCount > 0);
  summary.textContent = `可进入公开批次 ${stats.eligibleCount} 条，受阻 ${stats.blockedTotalCount} 条`;
  details.textContent =
    `缺谷歌号 ${stats.missingGoogleAccountCount} 条，缺谷歌密码 ${stats.missingGooglePasswordCount} 条，缺 OP ${stats.missingOpCount} 条，已有 UID ${stats.filledUidCount} 条。`;
}

async function loadRecords() {
  const queryString = toQueryString(collectRecordFilters());
  const data = await adminFetch(`/api/admin/records?${queryString}`, {
    method: 'GET',
  });
  renderPublicBatchEligibility(data);
  renderRows(data);
  renderPagination(data);
}

function syncBatchDeleteState() {
  const batchDeleteButton = document.getElementById('batchDeleteButton');
  const selectAllCheckbox = document.getElementById('selectAllRecordsCheckbox');
  const selectedCount = selectedRecordIds.size;
  batchDeleteButton.disabled = selectedCount === 0;
  batchDeleteButton.textContent =
    selectedCount > 0 ? `批量删除 (${selectedCount})` : '批量删除';

  const totalVisible = currentPageRecordIds.length;
  const selectedVisible = currentPageRecordIds.filter((id) =>
    selectedRecordIds.has(id),
  ).length;
  selectAllCheckbox.checked = totalVisible > 0 && selectedVisible === totalVisible;
  selectAllCheckbox.indeterminate =
    selectedVisible > 0 && selectedVisible < totalVisible;
}

function readRecordFormPayload() {
  return {
    googleAccount: document.getElementById('recordGoogleAccount').value.trim(),
    googlePassword: document.getElementById('recordGooglePassword').value.trim(),
    googleAssist: document.getElementById('recordGoogleAssist').value.trim(),
    googleExpireAt: document.getElementById('recordGoogleExpireAt').value || null,
    uidValue: document.getElementById('recordUidValue').value.trim(),
    opValue: document.getElementById('recordOpValue').value.trim(),
    opLink: document.getElementById('recordOpLink').value.trim(),
    opExpireAt: document.getElementById('recordOpExpireAt').value || null,
    remark: document.getElementById('recordRemark').value.trim(),
  };
}

function syncDerivedOpFields() {
  const opValue = document.getElementById('recordOpValue').value.trim();
  const opLink = buildDerivedOpLink(opValue);
  const opExpireAt = deriveOpExpireAt(opValue);

  document.getElementById('recordOpLink').value = opLink;
  if (opExpireAt) {
    document.getElementById('recordOpExpireAt').value = toDateTimeLocalValue(
      opExpireAt,
    );
  } else {
    document.getElementById('recordOpExpireAt').value = '';
  }
}

async function submitRecordForm(event) {
  event.preventDefault();

  const recordId = document.getElementById('recordId').value;
  const method = recordId ? 'PUT' : 'POST';
  const url = recordId ? `/api/admin/records/${recordId}` : '/api/admin/records';

  await adminFetch(url, {
    method,
    body: JSON.stringify(readRecordFormPayload()),
  });

  document.getElementById('recordDialog').close();
  await loadRecords();
}

function setBatchImportProgressState(percent, text) {
  const progressSection = document.getElementById('batchImportProgressSection');
  const progressBar = document.getElementById('batchImportProgressBar');
  const progressValue = document.getElementById('batchImportProgressValue');
  const progressText = document.getElementById('batchImportProgressText');
  const normalizedPercent = Math.max(0, Math.min(100, Number(percent) || 0));

  progressSection.classList.remove('hidden');
  progressBar.style.width = `${normalizedPercent}%`;
  progressValue.textContent = `${Math.round(normalizedPercent)}%`;
  progressText.textContent = text;
}

function resetBatchImportProgressState() {
  const progressSection = document.getElementById('batchImportProgressSection');
  const progressBar = document.getElementById('batchImportProgressBar');
  const progressValue = document.getElementById('batchImportProgressValue');
  const progressText = document.getElementById('batchImportProgressText');
  const submitButton = document.getElementById('batchImportSubmitButton');
  const cancelButton = document.getElementById('batchImportCancelButton');

  if (batchImportProgressTimer) {
    window.clearInterval(batchImportProgressTimer);
    batchImportProgressTimer = null;
  }

  progressSection.classList.add('hidden');
  progressBar.style.width = '0%';
  progressValue.textContent = '0%';
  progressText.textContent = '等待开始导入';
  submitButton.disabled = false;
  submitButton.textContent = '开始导入';
  cancelButton.disabled = false;
}

function startBatchImportProgress() {
  const submitButton = document.getElementById('batchImportSubmitButton');
  const cancelButton = document.getElementById('batchImportCancelButton');
  let currentProgress = 15;

  submitButton.disabled = true;
  submitButton.textContent = '导入中...';
  cancelButton.disabled = true;
  setBatchImportProgressState(15, '正在上传导入数据...');

  if (batchImportProgressTimer) {
    window.clearInterval(batchImportProgressTimer);
  }

  batchImportProgressTimer = window.setInterval(() => {
    currentProgress = Math.min(currentProgress + 8, 90);
    setBatchImportProgressState(currentProgress, '正在解析并写入数据...');
    if (currentProgress >= 90) {
      window.clearInterval(batchImportProgressTimer);
      batchImportProgressTimer = null;
    }
  }, 220);
}

function setBatchDeleteProgressState(percent, text) {
  const progressSection = document.getElementById('batchDeleteProgressSection');
  const progressBar = document.getElementById('batchDeleteProgressBar');
  const progressValue = document.getElementById('batchDeleteProgressValue');
  const progressText = document.getElementById('batchDeleteProgressText');
  const normalizedPercent = Math.max(0, Math.min(100, Number(percent) || 0));

  progressSection.classList.remove('hidden');
  progressBar.style.width = `${normalizedPercent}%`;
  progressValue.textContent = `${Math.round(normalizedPercent)}%`;
  progressText.textContent = text;
}

function resetBatchDeleteProgressState() {
  const progressSection = document.getElementById('batchDeleteProgressSection');
  const progressBar = document.getElementById('batchDeleteProgressBar');
  const progressValue = document.getElementById('batchDeleteProgressValue');
  const progressText = document.getElementById('batchDeleteProgressText');
  const batchDeleteButton = document.getElementById('batchDeleteButton');

  if (batchDeleteProgressTimer) {
    window.clearInterval(batchDeleteProgressTimer);
    batchDeleteProgressTimer = null;
  }

  progressSection.classList.add('hidden');
  progressBar.style.width = '0%';
  progressValue.textContent = '0%';
  progressText.textContent = '等待开始删除';
  syncBatchDeleteState();
  batchDeleteButton.disabled = selectedRecordIds.size === 0;
}

function startBatchDeleteProgress() {
  const batchDeleteButton = document.getElementById('batchDeleteButton');
  let currentProgress = 20;

  batchDeleteButton.disabled = true;
  batchDeleteButton.textContent = '删除中...';
  setBatchDeleteProgressState(20, '正在删除勾选记录...');

  if (batchDeleteProgressTimer) {
    window.clearInterval(batchDeleteProgressTimer);
  }

  batchDeleteProgressTimer = window.setInterval(() => {
    currentProgress = Math.min(currentProgress + 10, 88);
    setBatchDeleteProgressState(currentProgress, '正在同步删除结果...');
    if (currentProgress >= 88) {
      window.clearInterval(batchDeleteProgressTimer);
      batchDeleteProgressTimer = null;
    }
  }, 180);
}

function stopBatchDeleteProgressTimer() {
  if (batchDeleteProgressTimer) {
    window.clearInterval(batchDeleteProgressTimer);
    batchDeleteProgressTimer = null;
  }
}

async function submitBatchImportForm(event) {
  event.preventDefault();

  const rowsText = document.getElementById('batchImportText').value.trim();
  startBatchImportProgress();

  try {
    const data = await adminFetch('/api/admin/records/import-text', {
      method: 'POST',
      body: JSON.stringify({ rowsText }),
    });

    setBatchImportProgressState(100, '导入完成');
    await loadRecords();
    window.setTimeout(() => {
      document.getElementById('batchImportDialog').close();
      document.getElementById('batchImportForm').reset();
      resetBatchImportProgressState();
      showToast(
        data.skippedCount
          ? `已导入 ${data.importedCount} 条记录，跳过重复 ${data.skippedCount} 条`
          : `已导入 ${data.importedCount} 条记录`,
      );
    }, 320);
  } catch (error) {
    setBatchImportProgressState(100, '导入失败，请检查内容后重试');
    document.getElementById('batchImportCancelButton').disabled = false;
    document.getElementById('batchImportSubmitButton').disabled = false;
    document.getElementById('batchImportSubmitButton').textContent = '重新导入';
    throw error;
  }
}

window.openEditRecord = async function openEditRecord(id) {
  const data = await adminFetch(`/api/admin/records/${id}`, { method: 'GET' });
  document.getElementById('recordId').value = data.item.id;
  document.getElementById('recordGoogleAccount').value = data.item.googleAccount;
  document.getElementById('recordGooglePassword').value = data.item.googlePassword;
  document.getElementById('recordGoogleAssist').value = data.item.googleAssist;
  document.getElementById('recordGoogleExpireAt').value = toDateTimeLocalValue(
    data.item.googleExpireAt,
  );
  document.getElementById('recordUidValue').value = data.item.uidValue;
  document.getElementById('recordUidCreatedAt').value = formatDateTime(
    data.item.uidCreatedAt,
  );
  document.getElementById('recordOpValue').value = data.item.opValue;
  document.getElementById('recordOpLink').value = data.item.opLink;
  document.getElementById('recordOpExpireAt').value = toDateTimeLocalValue(
    data.item.opExpireAt,
  );
  document.getElementById('recordRemark').value = data.item.remark || '';
  document.getElementById('recordDialog').showModal();
};

window.deleteRecord = async function deleteRecord(id) {
  if (
    !(await showConfirm('确认永久删除这条记录吗？', {
      confirmText: '删除',
      tone: 'danger',
    }))
  ) {
    return;
  }

  await adminFetch(`/api/admin/records/${id}`, { method: 'DELETE' });
  await loadRecords();
};

window.toggleRecordSelection = function toggleRecordSelection(id, checked) {
  if (checked) {
    selectedRecordIds.add(id);
  } else {
    selectedRecordIds.delete(id);
  }
  syncBatchDeleteState();
};

async function deleteSelectedRecords() {
  const ids = getSelectedRecordIds();
  if (!ids.length) {
    showToast('请先勾选要删除的记录');
    return;
  }

  if (
    !(await showConfirm(`确认永久删除已勾选的 ${ids.length} 条记录吗？`, {
      confirmText: '删除',
      tone: 'danger',
    }))
  ) {
    return;
  }

  startBatchDeleteProgress();

  try {
    const data = await adminFetch('/api/admin/records/batch-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });

    stopBatchDeleteProgressTimer();
    setBatchDeleteProgressState(100, '删除完成');
    if (data.deletedCount > 0) {
      selectedRecordIds.clear();
      await loadRecords();
      window.setTimeout(() => {
        resetBatchDeleteProgressState();
        showToast(`已删除 ${data.deletedCount} 条记录`);
      }, 220);
      return;
    }

    window.setTimeout(() => {
      resetBatchDeleteProgressState();
      showToast('未删除任何记录，请重新勾选后再试');
    }, 220);
  } catch (error) {
    stopBatchDeleteProgressTimer();
    const errMsg = error.message || '请稍后重试';
    setBatchDeleteProgressState(100, `删除失败: ${errMsg}`);
    document.getElementById('batchDeleteButton').disabled = false;
    document.getElementById('batchDeleteButton').textContent = '重新删除';
    throw error;
  }
}

async function exportSelectedRecords() {
  const ids = getSelectedRecordIds();
  if (!ids.length) {
    showToast('请先勾选要导出的记录');
    return;
  }

  const response = await fetch('/api/admin/records/export.csv', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids }),
  });

  if (!response.ok) {
    const contentType = response.headers.get('content-type') || '';
    const errorPayload = contentType.includes('application/json')
      ? await response.json()
      : { error: await response.text() };
    throw new Error(errorPayload.error || '导出失败');
  }

  const csvBlob = await response.blob();
  const downloadUrl = window.URL.createObjectURL(csvBlob);
  const downloadLink = document.createElement('a');
  downloadLink.href = downloadUrl;
  downloadLink.download = 'managed-records.csv';
  document.body.appendChild(downloadLink);
  downloadLink.click();
  downloadLink.remove();
  window.URL.revokeObjectURL(downloadUrl);

  if (await showConfirm('已导出勾选数据，是否删除这些数据？')) {
    const data = await adminFetch('/api/admin/records', {
      method: 'DELETE',
      body: JSON.stringify({ ids }),
    });
    selectedRecordIds.clear();
    await loadRecords();
    showToast(`已删除 ${data.deletedCount} 条已导出记录`);
    return;
  }

  showToast(`已导出 ${ids.length} 条记录`);
}

function exportFilteredRecords() {
  const exportFilters = { ...collectRecordFilters() };
  delete exportFilters.page;
  delete exportFilters.pageSize;
  const queryString = toQueryString(exportFilters);
  window.location.href = `/api/admin/records/export.csv${
    queryString ? `?${queryString}` : ''
  }`;
}

window.addEventListener('DOMContentLoaded', async () => {
  let user = await requireAdminSession();
  if (!user) return;
  initializeSelfPasswordChange();
  initializeSelfWifiConfig(user, (updatedUser) => {
    user = updatedUser;
    document.getElementById('currentAdminText').textContent = `${user.login} / ${user.role}`;
  });

  document.getElementById('currentAdminText').textContent = `${user.login} / ${user.role}`;
  document.getElementById('userManageLink').hidden = user.role !== 'super_admin';
  document.getElementById('applyFiltersButton').addEventListener('click', () => {
    currentPage = 1;
    loadRecords();
  });

  const filterSection = document.getElementById('filterSection');
  const toggleIcon = document.getElementById('filterToggleIcon');
  
  document.getElementById('toggleFiltersButton').addEventListener('click', () => {
    const isHidden = filterSection.classList.contains('hidden');
    if (isHidden) {
      filterSection.classList.remove('hidden');
      toggleIcon.textContent = '▲';
    } else {
      filterSection.classList.add('hidden');
      toggleIcon.textContent = '▼';
    }
  });

  document.getElementById('resetFiltersButton').addEventListener('click', () => {
    const inputs = filterSection.querySelectorAll('input');
    inputs.forEach(input => input.value = '');
    currentPage = 1;
    loadRecords();
  });
  document
    .getElementById('previousPageButton')
    .addEventListener('click', () => {
      currentPage = Math.max(1, currentPage - 1);
      loadRecords();
    });
  document
    .getElementById('nextPageButton')
    .addEventListener('click', () => {
      currentPage += 1;
      loadRecords();
    });
  document
    .getElementById('pageSizeSelect')
    .addEventListener('change', (event) => {
      currentPageSize = event.target.value;
      currentPage = 1;
      loadRecords();
    });
  document
    .getElementById('createRecordButton')
    .addEventListener('click', () => {
      document.getElementById('recordForm').reset();
      document.getElementById('recordId').value = '';
      document.getElementById('recordUidCreatedAt').value = '';
      document.getElementById('recordOpLink').value = '';
      document.getElementById('recordDialog').showModal();
    });
  document
    .getElementById('batchImportButton')
    .addEventListener('click', () => {
      document.getElementById('batchImportForm').reset();
      resetBatchImportProgressState();
      document.getElementById('batchImportDialog').showModal();
    });
  document
    .getElementById('batchDeleteButton')
    .addEventListener('click', deleteSelectedRecords);
  document
    .getElementById('selectAllRecordsCheckbox')
    .addEventListener('change', (event) => {
      if (event.target.checked) {
        currentPageRecordIds.forEach((id) => selectedRecordIds.add(id));
      } else {
        currentPageRecordIds.forEach((id) => selectedRecordIds.delete(id));
      }
      document
        .querySelectorAll('#recordTableBody input[type="checkbox"]')
        .forEach((checkbox) => {
          checkbox.checked = event.target.checked;
        });
      syncBatchDeleteState();
    });
  document
    .getElementById('exportCsvButton')
    .addEventListener('click', exportSelectedRecords);
  document
    .getElementById('exportFilteredCsvButton')
    .addEventListener('click', exportFilteredRecords);
  document
    .getElementById('recordForm')
    .addEventListener('submit', submitRecordForm);
  document
    .getElementById('batchImportForm')
    .addEventListener('submit', submitBatchImportForm);
  document
    .getElementById('recordCancelButton')
    .addEventListener('click', () => {
      document.getElementById('recordDialog').close();
    });
  document
    .getElementById('batchImportCancelButton')
    .addEventListener('click', () => {
      resetBatchImportProgressState();
      document.getElementById('batchImportDialog').close();
    });
  document
    .getElementById('recordOpValue')
    .addEventListener('input', syncDerivedOpFields);
  document
    .getElementById('logoutButton')
    .addEventListener('click', async () => {
      await adminFetch('/api/admin/auth/logout', { method: 'POST' });
      window.location.href = '/admin/login';
    });

  await loadRecords();
});

let currentPage = 1;
const currentPageSize = 20;

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

function toQueryString(filters) {
  return new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value),
  ).toString();
}

function renderRows(items) {
  const tbody = document.getElementById('recordTableBody');
  tbody.innerHTML = items
    .map(
      (item) => `
        <tr>
          <td>${item.googleAccount}</td>
          <td>${item.googlePassword}</td>
          <td>${item.googleAssist}</td>
          <td>${formatDateTime(item.googleExpireAt)}</td>
          <td>${item.uidValue}</td>
          <td>${formatDateTime(item.uidCreatedAt)}</td>
          <td>${item.opValue}</td>
          <td>${item.opLink ? `<a href="${item.opLink}" target="_blank">${item.opLink}</a>` : ''}</td>
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
}

function toDateTimeLocalValue(value) {
  return value ? new Date(value).toISOString().slice(0, 16) : '';
}

function renderPagination(data) {
  const pageStatus = document.getElementById('pageStatus');
  const previousButton = document.getElementById('previousPageButton');
  const nextButton = document.getElementById('nextPageButton');
  const totalPages = Math.max(1, Math.ceil(data.total / data.pageSize));

  pageStatus.textContent = `第 ${data.page} / ${totalPages} 页，共 ${data.total} 条`;
  previousButton.disabled = data.page <= 1;
  nextButton.disabled = data.page >= totalPages;
}

async function loadRecords() {
  const queryString = toQueryString(collectRecordFilters());
  const data = await adminFetch(`/api/admin/records?${queryString}`, {
    method: 'GET',
  });
  renderRows(data.items);
  renderPagination(data);
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

async function submitBatchImportForm(event) {
  event.preventDefault();

  const rowsText = document.getElementById('batchImportText').value.trim();
  const data = await adminFetch('/api/admin/records/import-text', {
    method: 'POST',
    body: JSON.stringify({ rowsText }),
  });

  document.getElementById('batchImportDialog').close();
  document.getElementById('batchImportForm').reset();
  await loadRecords();
  showToast(`已导入 ${data.importedCount} 条记录`);
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
  if (!window.confirm('确认永久删除这条记录吗？')) {
    return;
  }

  await adminFetch(`/api/admin/records/${id}`, { method: 'DELETE' });
  await loadRecords();
};

window.addEventListener('DOMContentLoaded', async () => {
  const user = await requireAdminSession();
  if (!user) return;

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
      document.getElementById('batchImportDialog').showModal();
    });
  document
    .getElementById('exportCsvButton')
    .addEventListener('click', () => {
      const exportFilters = { ...collectRecordFilters() };
      delete exportFilters.page;
      delete exportFilters.pageSize;
      const queryString = toQueryString(exportFilters);
      window.location.href = `/api/admin/records/export.csv${
        queryString ? `?${queryString}` : ''
      }`;
    });
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

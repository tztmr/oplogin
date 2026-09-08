let phoneInventoryPage = 1;
let phoneInventoryTotalPages = 1;
let phoneInventoryGeneration = 0;
let phoneInventoryInitialized = false;

function phoneInventoryCell(value) {
  const cell = document.createElement('td');
  cell.textContent = value == null ? '' : String(value);
  return cell;
}

function renderPhoneInventory(items) {
  const body = document.getElementById('phoneInventoryTableBody');
  const rows = items.map((item) => {
    const row = document.createElement('tr');
    row.appendChild(phoneInventoryCell(item.phoneNumber));
    row.appendChild(phoneInventoryCell({ available: '未绑定', reserved: '未绑定', bound: '已绑定', after_sale: '老号售后' }[item.status] || '未知'));
    row.appendChild(phoneInventoryCell({ available: '待提取', reserved: '已提取', bound: '已入库', after_sale: '不再分配' }[item.status] || ''));
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
    cell.colSpan = 8;
    row.appendChild(cell);
    rows.push(row);
  }
  body.replaceChildren(...rows);
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
}

window.addEventListener('admin-section-shown', (event) => {
  if (event.detail.sectionId !== 'phoneInventorySection') return;
  initializePhoneInventory();
  void loadPhoneInventory();
});

(function () {
  const tables = new Map();
  const definitions = {
    recordTable: ['select', ...window.AdminRecordColumns.map((column) => column.key), 'actions'],
    phoneInventoryTable: ['phoneNumber', 'status', 'extraction', 'phoneSmsUrl', 'phoneExpireAt', 'phoneModel', 'createdAt', 'updatedAt'],
    shortOpTable: ['code', 'shortLink', 'appName', 'appId', 'opValue', 'opExpireAt', 'status', 'owner', 'remark', 'actions'],
    opApplicationTable: ['name', 'appId', 'isDefault', 'status', 'createdAt', 'updatedAt', 'actions'],
    userTable: ['login', 'email', 'role', 'status', 'lastLoginAt', 'actions'],
  };
  const fixedKeys = new Set(['select', 'actions']);

  function normalizeOrder(saved, defaults) {
    const allowed = new Set(defaults);
    return [...new Set([...(Array.isArray(saved) ? saved : []), ...defaults])]
      .filter((key) => allowed.has(key));
  }

  function refresh(tableId) {
    const state = tables.get(tableId);
    if (!state) return;
    const { table, keys, order } = state;
    let nextColumn = 0;
    const allKeys = keys.map((key) => fixedKeys.has(key) ? key : order[nextColumn++]);
    const groups = [table.tHead.rows[0], table.querySelector('colgroup'), ...table.tBodies[0].rows];
    groups.filter(Boolean).forEach((group) => {
      const cells = Array.from(group.children);
      if (cells.some((cell) => cell.colSpan > 1) || cells.length !== keys.length) return;
      cells.forEach((cell, index) => {
        if (!cell.dataset.columnKey) cell.dataset.columnKey = keys[index];
      });
      const byKey = new Map(cells.map((cell) => [cell.dataset.columnKey, cell]));
      allKeys.forEach((key) => group.appendChild(byKey.get(key)));
    });
  }

  function save(state, order) {
    state.order = normalizeOrder(order, state.defaults);
    refresh(state.table.id);
    try {
      window.localStorage.setItem(state.storageKey, JSON.stringify(state.order));
      state.status.textContent = '列顺序已保存';
    } catch {
      state.status.textContent = '列顺序已调整，本次有效';
      showToast('浏览器无法保存设置，刷新后将恢复默认顺序');
    }
  }

  function move(state, key, target) {
    const order = state.order.slice();
    const from = order.indexOf(key);
    const to = order.indexOf(target);
    if (from < 0 || to < 0 || from === to) return;
    order.splice(from, 1);
    order.splice(to, 0, key);
    save(state, order);
  }

  function openSettings(state) {
    const dialog = document.createElement('dialog');
    dialog.className = 'column-settings-dialog';
    dialog.setAttribute('aria-labelledby', 'columnSettingsTitle');
    dialog.innerHTML = `
      <div class="dialog-heading">
        <p class="eyebrow">TABLE PREFERENCES</p>
        <h3 id="columnSettingsTitle">自定义列顺序</h3>
        <p class="dialog-subtitle">使用上下按钮调整顺序，或直接拖动表格标题。设置保存在当前浏览器，按账号分别记忆。</p>
      </div>
      <ol class="column-order-list" aria-label="列显示顺序"></ol>
      <p class="column-settings-note"></p>
      <div class="column-settings-footer">
        <button type="button" data-reset>恢复默认</button>
        <div><button type="button" data-cancel>取消</button><button type="button" class="btn-primary" data-save>应用顺序</button></div>
      </div>`;
    let draft = state.order.slice();
    const list = dialog.querySelector('ol');
    const render = (focusKey, direction) => {
      list.replaceChildren();
      draft.forEach((key, index) => {
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.className = 'column-order-label';
        label.textContent = `${String(index + 1).padStart(2, '0')}  ${state.labels.get(key)}`;
        item.appendChild(label);
        const actions = document.createElement('div');
        [-1, 1].forEach((delta) => {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = delta < 0 ? '↑' : '↓';
          button.setAttribute('aria-label', `${delta < 0 ? '上移' : '下移'}${state.labels.get(key)}`);
          button.disabled = index + delta < 0 || index + delta >= draft.length;
          button.addEventListener('click', () => {
            [draft[index], draft[index + delta]] = [draft[index + delta], draft[index]];
            render(key, delta);
          });
          actions.appendChild(button);
          if (focusKey === key && delta === direction) {
            requestAnimationFrame(() => {
              (button.disabled ? actions.querySelector('button:not(:disabled)') : button)?.focus();
            });
          }
        });
        item.appendChild(actions);
        list.appendChild(item);
      });
    };
    render();
    dialog.querySelector('.column-settings-note').textContent = state.table.id === 'recordTable'
      ? '勾选导出与按筛选导出全部，均按此顺序输出；选择框和操作列不导出。'
      : '调整后，标题与对应数据会一起移动。';
    dialog.querySelector('[data-reset]').addEventListener('click', () => { draft = state.defaults.slice(); render(); });
    dialog.querySelector('[data-cancel]').addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-save]').addEventListener('click', () => { save(state, draft); dialog.close(); });
    dialog.addEventListener('close', () => { dialog.remove(); state.button.focus(); }, { once: true });
    document.body.appendChild(dialog);
    dialog.showModal();
  }

  function initialize(table, user) {
    if (tables.has(table.id)) return;
    // Operators have no owner cells in short OP rows. Remove the hidden structural
    // columns as well, keeping the same schema for headers, widths and row cells.
    const originalKeys = definitions[table.id];
    const headers = Array.from(table.tHead.rows[0].cells);
    const cols = Array.from(table.querySelectorAll('colgroup > col'));
    headers.forEach((header, index) => {
      header.dataset.columnKey = originalKeys[index];
      header.scope = 'col';
      if (cols[index]) cols[index].dataset.columnKey = originalKeys[index];
    });
    const keys = originalKeys.filter((key) => !(table.id === 'shortOpTable' && key === 'owner' && user.role !== 'super_admin'));
    headers.forEach((header, index) => {
      if (!keys.includes(originalKeys[index])) { header.remove(); cols[index]?.remove(); }
    });
    const defaults = keys.filter((key) => !fixedKeys.has(key));
    const storageKey = `admin.table-columns.v1.${user.id || user.login}.${table.id}`;
    let saved;
    try { saved = JSON.parse(window.localStorage.getItem(storageKey)); } catch { /* Use defaults if storage is unavailable or damaged. */ }
    const toolbar = document.createElement('div');
    toolbar.className = 'table-toolbar';
    const status = document.createElement('span');
    status.className = 'table-order-status';
    status.setAttribute('role', 'status');
    status.textContent = table.id === 'recordTable' ? '拖动表头调整列顺序，导出同步排列' : '拖动表头调整列顺序';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'column-settings-button';
    button.textContent = '列顺序';
    button.setAttribute('aria-haspopup', 'dialog');
    toolbar.append(status, button);
    table.parentElement.before(toolbar);
    const state = { table, keys, defaults, storageKey, order: normalizeOrder(saved, defaults), status, button,
      labels: new Map(headers.map((header) => [header.dataset.columnKey, header.textContent.trim()])) };
    tables.set(table.id, state);
    button.addEventListener('click', () => openSettings(state));
    let dragging = null;
    const clearDrag = () => {
      dragging = null;
      headers.forEach((header) => header.classList.remove('is-dragging', 'is-drop-target'));
    };
    headers.filter((header) => defaults.includes(header.dataset.columnKey)).forEach((header) => {
      const key = header.dataset.columnKey;
      header.draggable = true;
      header.tabIndex = 0;
      header.title = `${header.textContent.trim()}：拖动调整顺序，或按 Alt + 左右方向键`;
      header.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight');
      header.addEventListener('dragstart', (event) => {
        dragging = key;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', key);
        header.classList.add('is-dragging');
      });
      header.addEventListener('dragover', (event) => {
        if (!dragging || dragging === key) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        header.classList.add('is-drop-target');
      });
      header.addEventListener('dragleave', () => header.classList.remove('is-drop-target'));
      header.addEventListener('drop', (event) => {
        if (!dragging) return;
        event.preventDefault();
        move(state, dragging, key);
        clearDrag();
      });
      header.addEventListener('dragend', clearDrag);
      header.addEventListener('keydown', (event) => {
        if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
        event.preventDefault();
        const target = state.order[state.order.indexOf(key) + (event.key === 'ArrowLeft' ? -1 : 1)];
        if (target) { move(state, key, target); header.focus(); }
      });
    });
    refresh(table.id);
  }

  window.AdminTableColumns = {
    initializeAll(user) {
      Object.keys(definitions).forEach((id) => {
        const table = document.getElementById(id);
        if (table) initialize(table, user);
      });
    },
    refresh,
    getOrder(tableId) { return tables.get(tableId)?.order.slice() || []; },
  };
})();

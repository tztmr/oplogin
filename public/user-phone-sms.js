let phoneSmsInitialized = false;
let phoneSmsStopped = false;
let phoneSmsPending = false;
let phoneSmsTimer = null;
let phoneSmsController = null;
let phoneSmsUsername = '';
let phoneSmsBatchId = '';
let phoneSmsGeneration = 0;
let phoneSmsResumeOnShow = false;
const phoneSmsRows = new Map();
const phoneSmsCardNodes = new Map();

function identifyPhoneSms(raw) {
  const text = String(raw ?? '').trim();
  if (!text || /^0\s*\|\s*0$/.test(text)) return { state: 'waiting', code: '', messageKey: '' };
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  // The supplier's only no-message marker is 0|0. Code extraction is optional
  // display formatting; arrival and freshness depend on the full response.
  const candidates = [];
  function collect(value, depth = 0) {
    if (depth > 8 || value == null) return;
    if (typeof value === 'string' || typeof value === 'number') { candidates.push(String(value).trim()); return; }
    if (Array.isArray(value)) { value.forEach((child) => collect(child, depth + 1)); return; }
    for (const [key, child] of Object.entries(value)) {
      // A code alongside response metadata is normally the supplier's status code.
      if (key.toLowerCase() === 'code' && Object.keys(value).length > 1) continue;
      if (/^(sms|message|msg|data|content|text|body|code|otp|verify_?code|verification_?code|sms_?code)$/i.test(key)) collect(child, depth + 1);
    }
  }
  collect(parsed);
  for (const candidate of candidates) {
    const code = /^\d{4,8}$/.test(candidate) ? candidate
      : candidate.match(/(?:验证码|校验码|动态码|动态密码|一次性密码|(?:verification|security|login|authentication|one[ -]time)\s*(?:code|password)|\botp\b|\bcode\b)[^\d\n]{0,20}(\d{4,8})(?!\d)/i)?.[1]
        || candidate.match(/(?:^|[^\d])(\d{4,8})(?!\d)[^\d\n]{0,12}(?:验证码|校验码|动态码|(?:verification|security|login|authentication|one[ -]time)\s*(?:code|password)|\botp\b)/i)?.[1];
    if (code) return { state: 'received', code, messageKey: text };
  }
  return { state: 'received', code: '', messageKey: text };
}

function smsNode(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function updateSmsText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function createPhoneSmsCard(row) {
  const card = smsNode('article', 'sms-slot-card');
  card.dataset.slot = String(row.slot);
  const heading = smsNode('div', 'sms-slot-heading');
  const phone = smsNode('span', 'sms-phone-number');
  heading.replaceChildren(smsNode('h2', 'sms-slot-number', `第 ${row.slot} 个`), phone);
  const statuses = smsNode('div', 'sms-statuses');
  const received = smsNode('span', 'sms-badge');
  const fresh = smsNode('span', 'sms-badge');
  statuses.replaceChildren(received, fresh);
  const time = smsNode('p', 'note');
  const code = smsNode('p', 'sms-code');
  const raw = smsNode('pre', 'sms-raw');
  card.replaceChildren(heading, statuses, time, code, smsNode('p', 'sms-label', '本次接口原文'), raw);
  return { card, phone, received, fresh, time, code, raw };
}

function renderPhoneSmsRows() {
  const cards = Array.from(phoneSmsRows.values())
    .filter((row) => row.state === 'received' && row.isNew)
    .sort((a, b) => a.slot - b.slot).map((row) => {
    if (!phoneSmsCardNodes.has(row.slot)) phoneSmsCardNodes.set(row.slot, createPhoneSmsCard(row));
    const nodes = phoneSmsCardNodes.get(row.slot);
    updateSmsText(nodes.phone, row.phoneNumber || '暂无手机号');
    nodes.received.className = 'sms-badge received';
    nodes.fresh.className = 'sms-badge new';
    updateSmsText(nodes.received, '是否来码：已来码');
    updateSmsText(nodes.fresh, '是否新码：本次收到新码');
    const time = row.lastNewAt ? new Date(row.lastNewAt).toLocaleString('zh-CN', { hour12: false }) : '尚未收到';
    updateSmsText(nodes.time, `来码时间：${time}`);
    nodes.code.hidden = !row.lastCode;
    updateSmsText(nodes.code, row.lastCode);
    updateSmsText(nodes.raw, row.raw);
    return nodes.card;
  });
  const list = document.getElementById('phoneSmsSlots');
  if (list.children.length !== cards.length || cards.some((card, index) => list.children[index] !== card)) {
    list.replaceChildren(...cards);
  }
  const emptyState = document.getElementById('phoneSmsEmptyState');
  emptyState.hidden = cards.length > 0;
  updateSmsText(emptyState, phoneSmsStopped ? '已停止接码。' : '本轮暂无新验证码，正在等待…');
}

function setPhoneSmsStatus(message, state = '') {
  const node = document.getElementById('phoneSmsPollingStatus');
  node.textContent = message;
  node.dataset.state = state;
}

function stopPhoneSms(message = '') {
  phoneSmsStopped = true;
  if (message) phoneSmsResumeOnShow = false;
  phoneSmsGeneration += 1;
  if (phoneSmsTimer !== null) clearInterval(phoneSmsTimer);
  phoneSmsTimer = null;
  phoneSmsController?.abort();
  phoneSmsController = null;
  phoneSmsPending = false;
  for (const row of phoneSmsRows.values()) row.isNew = false;
  renderPhoneSmsRows();
  if (message) setPhoneSmsStatus(message, 'stopped');
}

function phoneSmsFatalResponse(status) {
  if (status === 409) {
    stopPhoneSms('当前组已变更，已停止接码。请返回用户中心重新打开批量接码。');
    return true;
  }
  if (status === 404) {
    stopPhoneSms('用户不存在或已禁用，已停止接码。请返回用户中心。');
    return true;
  }
  return false;
}

function putPhoneSmsRow(item) {
  if (!Number.isInteger(item.slot) || item.slot < 1 || item.slot > 18) return null;
  let row = phoneSmsRows.get(item.slot);
  if (!row || row.recordId !== item.recordId || row.phoneNumber !== (item.phoneNumber || '')) {
    row = { slot: item.slot, recordId: item.recordId, phoneNumber: item.phoneNumber || '', state: 'pending', raw: '', lastCode: '', lastMessage: '', lastNewAt: null, isNew: false };
    phoneSmsRows.set(item.slot, row);
  }
  return row;
}

function markPhoneSmsFailure(message) {
  for (const row of phoneSmsRows.values()) {
    row.state = 'error';
    row.isNew = false;
    row.raw = message;
  }
  renderPhoneSmsRows();
}

async function pollPhoneSms() {
  if (phoneSmsStopped || phoneSmsPending) return;
  const generation = phoneSmsGeneration;
  phoneSmsPending = true;
  phoneSmsController = new AbortController();
  try {
    const response = await fetch(`/api/public/user/${encodeURIComponent(phoneSmsUsername)}/batch/phone/sms`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ batchId: phoneSmsBatchId }), signal: phoneSmsController.signal, cache: 'no-store',
    });
    if (generation !== phoneSmsGeneration || phoneSmsStopped || phoneSmsFatalResponse(response.status)) return;
    const data = await response.json();
    if (generation !== phoneSmsGeneration || phoneSmsStopped) return;
    if (!response.ok) throw new Error('本次读取失败，将自动重试。');
    if (data.batchId !== phoneSmsBatchId) {
      stopPhoneSms('当前组已变更，已停止接码。请返回用户中心重新打开批量接码。');
      return;
    }
    if (!Array.isArray(data.results)) throw new Error('接码返回格式不正确，将自动重试。');
    const seen = new Set();
    for (const item of data.results) {
      const row = putPhoneSmsRow(item);
      if (!row) continue;
      seen.add(item.slot);
      row.raw = typeof item.message === 'string' ? item.message : '';
      const identified = item.status === 'success' ? identifyPhoneSms(row.raw)
        : { state: item.status === 'skipped' ? 'skipped' : 'error', code: '' };
      row.state = identified.state;
      row.isNew = row.state === 'received' && identified.messageKey !== row.lastMessage;
      if (row.state === 'received') {
        if (row.isNew) row.lastNewAt = Date.now();
        row.lastCode = identified.code;
        row.lastMessage = identified.messageKey;
      }
    }
    for (const row of phoneSmsRows.values()) {
      if (!seen.has(row.slot)) { row.state = 'error'; row.isNew = false; row.raw = '本次未返回该槽位，将自动重试。'; }
    }
    renderPhoneSmsRows();
    const rows = Array.from(phoneSmsRows.values());
    const fresh = rows.filter((row) => row.isNew).length;
    const failed = rows.filter((row) => row.state === 'error').length;
    setPhoneSmsStatus(`自动接码中 · 当前新码 ${fresh} 个${failed ? `，读取失败 ${failed} 个` : ''} · 每秒查询`, failed ? 'error' : '');
  } catch (error) {
    if (generation === phoneSmsGeneration && !phoneSmsStopped) {
      markPhoneSmsFailure('本次读取失败，请等待自动重试。');
      setPhoneSmsStatus('本次读取失败，已隐藏旧消息，正在自动重试。', 'error');
    }
  } finally {
    if (generation === phoneSmsGeneration) {
      phoneSmsPending = false;
      phoneSmsController = null;
    }
  }
}

async function initializePhoneSmsPage() {
  if (phoneSmsInitialized) return;
  phoneSmsInitialized = true;
  const query = new URLSearchParams(window.location.search);
  phoneSmsUsername = (query.get('username') || '').trim();
  phoneSmsBatchId = query.get('batchId') || '';
  document.getElementById('phoneSmsReturnLink').href = phoneSmsUsername ? `/${encodeURIComponent(phoneSmsUsername)}` : '/';
  if (!phoneSmsUsername || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(phoneSmsBatchId)) {
    stopPhoneSms('缺少有效的用户或批次信息，请返回用户中心重新打开批量接码。');
    return;
  }
  document.getElementById('phoneSmsBatchText').textContent = `${phoneSmsUsername} · 固定批次 ${phoneSmsBatchId.slice(0, 8)}`;
  const generation = phoneSmsGeneration;
  phoneSmsPending = true;
  phoneSmsController = new AbortController();
  phoneSmsTimer = setInterval(() => { void pollPhoneSms(); }, 1000);
  try {
    const response = await fetch(`/api/public/user/${encodeURIComponent(phoneSmsUsername)}/batch/phone?batchId=${encodeURIComponent(phoneSmsBatchId)}`, {
      method: 'GET', cache: 'no-store', signal: phoneSmsController.signal,
    });
    if (generation !== phoneSmsGeneration || phoneSmsStopped || phoneSmsFatalResponse(response.status)) return;
    const data = await response.json();
    if (generation !== phoneSmsGeneration || phoneSmsStopped) return;
    if (!response.ok) throw new Error('暂时无法加载手机号');
    if (data.batchId !== phoneSmsBatchId) { phoneSmsFatalResponse(409); return; }
    for (const slot of data.slots || []) putPhoneSmsRow(slot);
    renderPhoneSmsRows();
  } catch (error) {
    if (generation === phoneSmsGeneration && !phoneSmsStopped) setPhoneSmsStatus('暂时无法加载手机号，正在自动重试。', 'error');
  } finally {
    if (generation === phoneSmsGeneration) {
      phoneSmsPending = false;
      phoneSmsController = null;
    }
  }
  if (generation === phoneSmsGeneration && !phoneSmsStopped) await pollPhoneSms();
}

function suspendPhoneSmsPage() {
  if (phoneSmsStopped) return;
  phoneSmsResumeOnShow = true;
  stopPhoneSms();
}

window.addEventListener('pagehide', suspendPhoneSmsPage);
window.addEventListener('beforeunload', suspendPhoneSmsPage);
window.addEventListener('pageshow', (event) => {
  if (!event.persisted || !phoneSmsStopped || !phoneSmsResumeOnShow) return;
  phoneSmsResumeOnShow = false;
  phoneSmsInitialized = false;
  phoneSmsStopped = false;
  setPhoneSmsStatus('正在重新核对本组手机号…');
  void initializePhoneSmsPage();
});
document.addEventListener('DOMContentLoaded', () => { void initializePhoneSmsPage(); });

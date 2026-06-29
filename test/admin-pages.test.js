const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const { createApp } = require('../app');

function createTestApp() {
  return createApp({
    buildWakeUrlImpl: () => 'tencent1105602870://qzapp/mqzone/0?pasteboard=test',
  });
}

test('GET /admin/login serves the admin login shell', async () => {
  const response = await request(createTestApp()).get('/admin/login');

  assert.equal(response.status, 200);
  assert.match(response.text, /管理员登录/);
  assert.match(response.text, /id="loginForm"/);
  assert.match(response.text, /\/admin\/login\.js/);
});

test('GET /admin serves the record management shell', async () => {
  const response = await request(createTestApp()).get('/admin');

  assert.equal(response.status, 200);
  assert.match(response.text, /谷歌号/);
  assert.match(response.text, /UID创建时间/);
  assert.match(response.text, /id="recordTable"/);
  assert.match(response.text, /批量导入/);
  assert.match(response.text, /导出勾选/);
  assert.match(response.text, /按筛选导出全部/);
  assert.match(response.text, /id="exportCsvButton"[^>]*class="btn-primary"/);
  assert.match(response.text, /id="exportFilteredCsvButton"[^>]*class="btn-cancel"/);
  assert.match(response.text, /id="pageSizeSelect"/);
  assert.match(response.text, /<option value="20" selected>20<\/option>/);
  assert.match(response.text, /<option value="50">50<\/option>/);
  assert.match(response.text, /<option value="100">100<\/option>/);
  assert.match(response.text, /<option value="all">全部<\/option>/);
});

test('admin records UI truncates long OP fields in the table', async () => {
  const app = createTestApp();
  const pageResponse = await request(app).get('/admin/records.js');
  const styleResponse = await request(app).get('/admin/admin.css');

  assert.equal(pageResponse.status, 200);
  assert.equal(styleResponse.status, 200);
  assert.match(pageResponse.text, /renderTruncatedText\(item\.opValue, 'cell-truncate-op'\)/);
  assert.match(pageResponse.text, /cell-truncate cell-truncate-link/);
  assert.match(styleResponse.text, /\.cell-truncate\s*\{/);
  assert.match(styleResponse.text, /text-overflow:\s*ellipsis/);
});

test('admin common UI exposes custom feedback dialogs for export confirmation and toast', async () => {
  const app = createTestApp();
  const pageResponse = await request(app).get('/admin/records.js');
  const commonResponse = await request(app).get('/admin/common.js');

  assert.equal(pageResponse.status, 200);
  assert.equal(commonResponse.status, 200);
  assert.match(pageResponse.text, /showConfirm\('已导出勾选数据，是否删除这些数据？'\)/);
  assert.match(pageResponse.text, /window\.location\.href = `\/api\/admin\/records\/export\.csv/);
  assert.match(commonResponse.text, /function showConfirm\(/);
  assert.match(commonResponse.text, /function showToast\(/);
});

test('GET /admin/users serves the super admin user management shell', async () => {
  const response = await request(createTestApp()).get('/admin/users');

  assert.equal(response.status, 200);
  assert.match(response.text, /账号管理/);
  assert.match(response.text, /id="userTable"/);
  assert.match(response.text, /id="selfPasswordDialog"/);
});

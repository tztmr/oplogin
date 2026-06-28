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
  assert.match(response.text, /导出 CSV/);
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

test('GET /admin/users serves the super admin user management shell', async () => {
  const response = await request(createTestApp()).get('/admin/users');

  assert.equal(response.status, 200);
  assert.match(response.text, /账号管理/);
  assert.match(response.text, /id="userTable"/);
});

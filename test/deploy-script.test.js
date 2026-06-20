const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const scriptPath = path.join(__dirname, '..', 'deploy-oplogin.sh');

test('deploy script targets the current GitHub repository and installs runtime dependencies', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /git@github\.com:tztmr\/oplogin\.git/);
  assert.match(script, /pm2/);
  assert.match(script, /nginx/);
  assert.match(script, /npm ci|npm install/);
  assert.match(script, /certbot/);
});

test('deploy script and app both default to port 4399', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

  assert.match(script, /DEFAULT_PORT="4399"/);
  assert.match(server, /const PORT = process\.env\.PORT \|\| 4399;/);
});

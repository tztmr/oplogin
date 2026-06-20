const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const {
  buildWakeUrl,
  parseOpToken,
} = require('../lib/op-url');

const SAMPLE_TOKEN =
  '785C405C8549B6018AD88946B1D497BA|61918848DC616E7304A2D7F3C4ED796D|F43DC53DD8E3AA6FD799EF322F5F71C6|65fe51e82cf70df5ca345617887e1601|1780747973';

test('parseOpToken extracts the token fields used by the wake payload', () => {
  assert.deepEqual(parseOpToken(SAMPLE_TOKEN), {
    openid: '785C405C8549B6018AD88946B1D497BA',
    accessToken: '61918848DC616E7304A2D7F3C4ED796D',
    payToken: 'F43DC53DD8E3AA6FD799EF322F5F71C6',
  });
});

test('buildWakeUrl creates a Tencent app URL with a decodable pasteboard plist', () => {
  const wakeUrl = buildWakeUrl(SAMPLE_TOKEN, '1105602870');

  assert.match(
    wakeUrl,
    /^tencent1105602870:\/\/qzapp\/mqzone\/0\?objectlocation=url&pasteboard=/,
  );

  const pasteboard = new URL(wakeUrl).searchParams.get('pasteboard');
  assert.ok(pasteboard);

  const decodedJson = execFileSync(
    'python3',
    [
      '-c',
      [
        'import base64, json, plistlib, sys',
        'raw = base64.b64decode(sys.argv[1] + "=" * ((4 - len(sys.argv[1]) % 4) % 4))',
        'obj = plistlib.loads(raw)',
        'objects = obj["$objects"]',
        'payload = objects[1]',
        'uid_index = lambda value: int(str(value).split("(")[1].split(")")[0])',
        'keys = [objects[uid_index(item)] for item in payload["NS.keys"]]',
        'values = [objects[uid_index(item)] for item in payload["NS.objects"]]',
        'print(json.dumps(dict(zip(keys, values)), ensure_ascii=False, default=str))',
      ].join('; '),
      pasteboard,
    ],
    { encoding: 'utf8' },
  );
  const decoded = JSON.parse(decodedJson);

  assert.equal(decoded.openid, '785C405C8549B6018AD88946B1D497BA');
  assert.equal(decoded.access_token, '61918848DC616E7304A2D7F3C4ED796D');
  assert.equal(decoded.pay_token, 'F43DC53DD8E3AA6FD799EF322F5F71C6');
  assert.equal(decoded.pf, 'openmobile_ios');
  assert.equal(decoded.ret, 0);
  assert.equal(decoded.expires_in, 7776000);
});

test('parseOpToken rejects malformed OP tokens', () => {
  assert.throws(() => parseOpToken('only-one-part'), /OP 数据号格式不正确/);
});

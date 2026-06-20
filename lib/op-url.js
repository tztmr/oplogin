const DEFAULT_ENCRY_TOKEN = 'dd02c11302e09f85400b834bbd3ac04d';
const DEFAULT_PFKEY = '65d0a30bedbc73f53d8370141e6220df';

class UID {
  constructor(value) {
    this.value = value;
  }
}

function parseOpToken(input) {
  const value = String(input || '').trim();
  const parts = value.split('|').map((item) => item.trim());

  if (parts.length < 3 || parts.slice(0, 3).some((item) => !item)) {
    throw new Error('OP 数据号格式不正确，需要至少包含 openid|access_token|pay_token');
  }

  return {
    openid: parts[0],
    accessToken: parts[1],
    payToken: parts[2],
  };
}

function buildWakeUrl(opToken, game) {
  const gameId = String(game || '').trim();
  if (!gameId) {
    throw new Error('请选择目标应用');
  }

  const token = parseOpToken(opToken);
  const pasteboard = buildPasteboard(token).toString('base64');

  return `tencent${gameId}://qzapp/mqzone/0?objectlocation=url&pasteboard=${encodeURIComponent(pasteboard)}`;
}

function buildPasteboard({ openid, accessToken, payToken }) {
  return writeBinaryPlist({
    $archiver: 'NSKeyedArchiver',
    $objects: [
      '$null',
      {
        $class: new UID(27),
        'NS.keys': [
          new UID(2),
          new UID(3),
          new UID(4),
          new UID(5),
          new UID(6),
          new UID(7),
          new UID(8),
          new UID(9),
          new UID(10),
          new UID(11),
          new UID(12),
          new UID(13),
        ],
        'NS.objects': [
          new UID(14),
          new UID(15),
          new UID(16),
          new UID(17),
          new UID(19),
          new UID(20),
          new UID(21),
          new UID(22),
          new UID(23),
          new UID(24),
          new UID(25),
          new UID(26),
        ],
      },
      'expires_in',
      'appsign_bundlenull',
      'encrytoken',
      'passDataResp',
      'ret',
      'openid',
      'pf',
      'user_cancelled',
      'pfkey',
      'pay_token',
      'msg',
      'access_token',
      7776000,
      '2',
      DEFAULT_ENCRY_TOKEN,
      {
        $class: new UID(18),
        'NS.objects': [],
      },
      {
        $classes: ['NSMutableArray', 'NSArray', 'NSObject'],
        $classname: 'NSMutableArray',
      },
      0,
      openid,
      'openmobile_ios',
      'NO',
      DEFAULT_PFKEY,
      payToken,
      '',
      accessToken,
      {
        $classes: ['NSMutableDictionary', 'NSDictionary', 'NSObject'],
        $classname: 'NSMutableDictionary',
      },
    ],
    $top: {
      root: new UID(1),
    },
    $version: 100000,
  });
}

function writeBinaryPlist(root) {
  const objects = [];
  const seen = new Map();

  collect(root, objects, seen);

  const refSize = byteSize(objects.length - 1);
  const encodedObjects = [];
  const offsets = [];
  let offset = 8;

  for (const object of objects) {
    const encoded = encodeObject(object, seen, refSize);
    offsets.push(offset);
    encodedObjects.push(encoded);
    offset += encoded.length;
  }

  const offsetSize = byteSize(offset);
  const offsetTableOffset = offset;
  const offsetTable = Buffer.concat(
    offsets.map((item) => unsignedIntBuffer(item, offsetSize)),
  );

  const trailer = Buffer.alloc(32);
  trailer.writeUInt8(offsetSize, 6);
  trailer.writeUInt8(refSize, 7);
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(0n, 16);
  trailer.writeBigUInt64BE(BigInt(offsetTableOffset), 24);

  return Buffer.concat([
    Buffer.from('bplist00', 'ascii'),
    ...encodedObjects,
    offsetTable,
    trailer,
  ]);
}

function collect(value, objects, seen) {
  if (value === null || value === undefined) {
    return;
  }

  if (typeof value !== 'object') {
    return addObject(value, objects, seen);
  }

  if (seen.has(value)) {
    return seen.get(value);
  }

  const index = addObject(value, objects, seen);

  if (Array.isArray(value)) {
    for (const item of value) {
      collect(item, objects, seen);
    }
    return index;
  }

  for (const [key, item] of Object.entries(value)) {
    collect(key, objects, seen);
    collect(item, objects, seen);
  }

  return index;
}

function addObject(value, objects, seen) {
  const key = objectKey(value);
  if (seen.has(key)) {
    return seen.get(key);
  }
  const index = objects.length;
  objects.push(value);
  seen.set(key, index);
  if (typeof value === 'object' && value !== null) {
    seen.set(value, index);
  }
  return index;
}

function objectKey(value) {
  if (value instanceof UID) {
    return `uid:${value.value}`;
  }
  if (typeof value === 'string') {
    return `string:${value}`;
  }
  if (typeof value === 'number') {
    return `number:${value}`;
  }
  if (typeof value === 'boolean') {
    return `boolean:${value}`;
  }
  return value;
}

function encodeObject(value, seen, refSize) {
  if (typeof value === 'string') {
    return encodeAsciiString(value);
  }
  if (typeof value === 'number') {
    return encodeInteger(value);
  }
  if (typeof value === 'boolean') {
    return Buffer.from([value ? 0x09 : 0x08]);
  }
  if (value instanceof UID) {
    return encodeUid(value.value);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([
      encodeCount(0xa0, value.length),
      ...value.map((item) => unsignedIntBuffer(refFor(item, seen), refSize)),
    ]);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value);
    return Buffer.concat([
      encodeCount(0xd0, entries.length),
      ...entries.map(([key]) => unsignedIntBuffer(refFor(key, seen), refSize)),
      ...entries.map(([, item]) =>
        unsignedIntBuffer(refFor(item, seen), refSize),
      ),
    ]);
  }
  return Buffer.from([0x00]);
}

function refFor(value, seen) {
  const index = seen.get(objectKey(value));
  if (index === undefined) {
    throw new Error(`Missing plist reference for ${String(value)}`);
  }
  return index;
}

function encodeAsciiString(value) {
  const data = Buffer.from(value, 'ascii');
  return Buffer.concat([encodeCount(0x50, data.length), data]);
}

function encodeInteger(value) {
  const size = byteSize(value);
  const marker = 0x10 + Math.log2(size);
  return Buffer.concat([Buffer.from([marker]), unsignedIntBuffer(value, size)]);
}

function encodeUid(value) {
  const size = byteSize(value);
  return Buffer.concat([
    Buffer.from([0x80 + size - 1]),
    unsignedIntBuffer(value, size),
  ]);
}

function encodeCount(markerBase, count) {
  if (count < 15) {
    return Buffer.from([markerBase + count]);
  }
  return Buffer.concat([Buffer.from([markerBase + 15]), encodeInteger(count)]);
}

function byteSize(value) {
  if (value <= 0xff) return 1;
  if (value <= 0xffff) return 2;
  if (value <= 0xffffffff) return 4;
  return 8;
}

function unsignedIntBuffer(value, size) {
  const buffer = Buffer.alloc(size);
  if (size === 1) buffer.writeUInt8(value);
  else if (size === 2) buffer.writeUInt16BE(value);
  else if (size === 4) buffer.writeUInt32BE(value);
  else buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

module.exports = {
  buildWakeUrl,
  parseOpToken,
};

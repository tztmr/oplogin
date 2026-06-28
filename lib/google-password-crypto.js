const crypto = require('node:crypto');

function getKeyBuffer(hexKey) {
  return Buffer.from(hexKey, 'hex');
}

function normalizeGooglePassword(value) {
  return String(value || '').trim();
}

function encryptGooglePassword(plainText, hexKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKeyBuffer(hexKey), iv);
  const encrypted = Buffer.concat([
    cipher.update(normalizeGooglePassword(plainText), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    iv.toString('hex'),
    tag.toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

function decryptGooglePassword(payload, hexKey) {
  const [ivHex, tagHex, dataHex] = String(payload || '').split(':');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getKeyBuffer(hexKey),
    Buffer.from(ivHex, 'hex'),
  );

  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));

  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

function buildGooglePasswordSearchHash(value, hexKey) {
  return crypto
    .createHmac('sha256', getKeyBuffer(hexKey))
    .update(normalizeGooglePassword(value))
    .digest('hex');
}

module.exports = {
  normalizeGooglePassword,
  encryptGooglePassword,
  decryptGooglePassword,
  buildGooglePasswordSearchHash,
};

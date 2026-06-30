function escapeWifiQrValue(value) {
  return String(value || '')
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll(':', '\\:');
}

function buildWifiQrPayload(config = {}) {
  const type = String(config.type || 'WPA').trim().toUpperCase() || 'WPA';
  const ssid = String(config.ssid || '').trim();
  const password = String(config.password || '').trim();
  const hidden = Boolean(config.hidden);

  if (!ssid) {
    return '';
  }

  const parts = [
    'WIFI:',
    `T:${escapeWifiQrValue(type)};`,
    `S:${escapeWifiQrValue(ssid)};`,
  ];

  if (type !== 'NOPASS') {
    parts.push(`P:${escapeWifiQrValue(password)};`);
  }
  if (hidden) {
    parts.push('H:true;');
  }
  parts.push(';');

  return parts.join('');
}

function buildUserCenterUrl(origin, username) {
  return `${String(origin || '').replace(/\/$/, '')}/${encodeURIComponent(String(username || '').trim())}`;
}

function buildQrImageUrl(value, size = 180) {
  const normalizedValue = String(value || '').trim();
  if (!normalizedValue) {
    return '';
  }
  const pixelSize = Number.isFinite(size) ? Math.max(80, Math.floor(size)) : 180;
  return `https://api.qrserver.com/v1/create-qr-code/?size=${pixelSize}x${pixelSize}&data=${encodeURIComponent(normalizedValue)}`;
}

if (typeof window !== 'undefined') {
  window.buildWifiQrPayload = buildWifiQrPayload;
  window.buildUserCenterUrl = buildUserCenterUrl;
  window.buildQrImageUrl = buildQrImageUrl;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    buildQrImageUrl,
    buildUserCenterUrl,
    buildWifiQrPayload,
    escapeWifiQrValue,
  };
}

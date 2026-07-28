function decodeParam(value) {
  try {
    return decodeURIComponent(String(value || '').replace(/^\/+/, ''));
  } catch {
    return String(value || '').replace(/^\/+/, '');
  }
}

function extractInitialOpValueFromLocation(locationLike) {
  const pathname = String(locationLike?.pathname || '');
  const search = String(locationLike?.search || '');
  const hash = String(locationLike?.hash || '');

  const pathParts = pathname.split('/').filter(Boolean);
  if (pathParts[0] === 'oplogin' && pathParts[1]) {
    return decodeParam(pathParts.slice(1).join('/'));
  }

  if (search) {
    return decodeParam(search.substring(1));
  }

  if (hash) {
    return decodeParam(hash.substring(1));
  }

  return '';
}

function shouldPrefetchWakeUrl(opValue) {
  const parts = String(opValue || '')
    .split('|')
    .map((item) => item.trim());

  return parts.length >= 3 && parts.slice(0, 3).every(Boolean);
}

if (typeof window !== 'undefined') {
  window.extractInitialOpValueFromLocation = extractInitialOpValueFromLocation;
  window.shouldPrefetchWakeUrl = shouldPrefetchWakeUrl;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    decodeParam,
    extractInitialOpValueFromLocation,
    shouldPrefetchWakeUrl,
  };
}

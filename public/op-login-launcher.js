function createWakeNavigationController({
  openWindow = (url, target) => window.open(url, target),
  navigateCurrent = (url) => {
    window.location.href = url;
  },
} = {}) {
  let placeholderWindow = null;

  return {
    prepare() {
      placeholderWindow = openWindow('about:blank', '_blank');
      return placeholderWindow;
    },
    navigate(url) {
      if (
        placeholderWindow &&
        typeof placeholderWindow === 'object' &&
        placeholderWindow.closed !== true &&
        placeholderWindow.location
      ) {
        placeholderWindow.location.href = url;
        return 'popup';
      }
      navigateCurrent(url);
      return 'current';
    },
    abort() {
      if (
        placeholderWindow &&
        typeof placeholderWindow.close === 'function' &&
        placeholderWindow.closed !== true
      ) {
        placeholderWindow.close();
      }
      placeholderWindow = null;
    },
  };
}

if (typeof window !== 'undefined') {
  window.createWakeNavigationController = createWakeNavigationController;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createWakeNavigationController };
}

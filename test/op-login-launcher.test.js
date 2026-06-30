const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createWakeNavigationController,
} = require('../public/op-login-launcher');

test('createWakeNavigationController navigates the synchronously opened popup when available', () => {
  const popup = {
    location: { href: 'about:blank' },
    closed: false,
    closeCalled: false,
    close() {
      this.closeCalled = true;
      this.closed = true;
    },
  };
  let currentHref = 'https://example.com/current';
  const controller = createWakeNavigationController({
    openWindow: () => popup,
    navigateCurrent: (url) => {
      currentHref = url;
    },
  });

  controller.prepare();

  assert.equal(popup.location.href, 'about:blank');
  assert.equal(currentHref, 'https://example.com/current');

  const result = controller.navigate('tencent1105602870://wake?token=abc');

  assert.equal(result, 'popup');
  assert.equal(popup.location.href, 'tencent1105602870://wake?token=abc');
  assert.equal(currentHref, 'https://example.com/current');
});

test('createWakeNavigationController falls back to current window when popup is blocked', () => {
  let currentHref = 'https://example.com/current';
  const controller = createWakeNavigationController({
    openWindow: () => null,
    navigateCurrent: (url) => {
      currentHref = url;
    },
  });

  const result = controller.navigate('tencent1105602870://wake?token=blocked');

  assert.equal(result, 'current');
  assert.equal(currentHref, 'tencent1105602870://wake?token=blocked');
});

test('createWakeNavigationController closes the placeholder popup when launching fails', () => {
  const popup = {
    location: { href: 'about:blank' },
    closed: false,
    closeCalled: false,
    close() {
      this.closeCalled = true;
      this.closed = true;
    },
  };
  const controller = createWakeNavigationController({
    openWindow: () => popup,
    navigateCurrent: () => {},
  });

  controller.prepare();
  controller.abort();

  assert.equal(popup.closeCalled, true);
  assert.equal(popup.closed, true);
});

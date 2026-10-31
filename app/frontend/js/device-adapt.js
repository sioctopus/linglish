(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.LxDevice = api;
    if (root.document) api.install(root);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function classify({
    userAgent = '',
    viewportWidth,
    maxTouchPoints = 0,
    pointer = '',
    hover = ''
  } = {}) {
    const ua = String(userAgent || '');
    const width = Number(viewportWidth);
    const touchPoints = Number(maxTouchPoints) || 0;
    const iPad = /iPad/i.test(ua) || (/Macintosh|Mac OS X/i.test(ua) && touchPoints > 1);
    const android = /Android/i.test(ua);
    const androidPhone = android && /Mobile/i.test(ua);
    const mac = /Macintosh|Mac OS X/i.test(ua) && !iPad;

    let os = 'other';
    if (/iPhone|iPod|iPad/i.test(ua) || iPad) os = 'ios';
    else if (android) os = 'android';
    else if (mac) os = 'mac';
    else if (/Windows/i.test(ua)) os = 'windows';

    const tabletDevice = iPad || (android && !androidPhone);
    let tier = 'desktop';
    if (!Number.isFinite(width)) {
      if (/iPhone|iPod/i.test(ua) || androidPhone) tier = 'phone';
      else if (tabletDevice) tier = 'tablet-portrait';
      else tier = 'desktop';
    } else if (width <= 375) {
      tier = 'phone';
    } else if (width <= 767) {
      tier = 'phone';
    } else if (width <= 1023) {
      tier = 'tablet-portrait';
    } else if (tabletDevice || (pointer === 'coarse' && hover !== 'hover' && !mac && !/Windows/i.test(ua))) {
      tier = 'tablet-landscape';
    } else {
      tier = 'desktop';
    }

    const form = tier === 'desktop' ? 'desktop' : tier.indexOf('tablet') === 0 ? 'tablet' : 'phone';
    const input = pointer === 'coarse' || hover === 'none' || touchPoints > 1 ? 'coarse' : 'fine';
    return { tier, os, form, pointer: input };
  }

  function installTarget(info) {
    if (!info || info.form === 'desktop') {
      return { surface: 'desktop', manifest: '/manifest-desktop.json' };
    }
    return { surface: 'home', manifest: '/manifest.json' };
  }

  function ensureViewport(doc) {
    if (!doc || !doc.head) return;
    let meta = doc.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = doc.createElement('meta');
      meta.setAttribute('name', 'viewport');
      doc.head.appendChild(meta);
    }
    const parts = new Map();
    String(meta.getAttribute('content') || '').split(',').forEach((piece) => {
      const item = piece.trim();
      if (!item) return;
      const eq = item.indexOf('=');
      const key = (eq === -1 ? item : item.slice(0, eq)).trim().toLowerCase();
      const value = eq === -1 ? '' : item.slice(eq + 1).trim();
      if (key) parts.set(key, value);
    });
    if (!parts.has('width')) parts.set('width', 'device-width');
    if (!parts.has('initial-scale')) parts.set('initial-scale', '1');
    parts.set('viewport-fit', 'cover');
    if (!parts.has('interactive-widget')) parts.set('interactive-widget', 'resizes-content');
    meta.setAttribute(
      'content',
      Array.from(parts, ([key, value]) => (value ? `${key}=${value}` : key)).join(', ')
    );
  }

  function readSignals(windowObject) {
    const nav = windowObject.navigator || {};
    const match = (query) => {
      try {
        return windowObject.matchMedia && windowObject.matchMedia(query).matches;
      } catch (_) {
        return false;
      }
    };
    return classify({
      userAgent: nav.userAgent || '',
      viewportWidth: windowObject.innerWidth,
      maxTouchPoints: nav.maxTouchPoints || 0,
      pointer: match('(pointer: coarse)') ? 'coarse' : 'fine',
      hover: match('(hover: hover)') ? 'hover' : 'none'
    });
  }

  function apply(windowObject) {
    const doc = windowObject && windowObject.document;
    if (!doc || !doc.documentElement) return null;
    const info = readSignals(windowObject);
    const root = doc.documentElement;
    root.setAttribute('data-lx-tier', info.tier);
    root.setAttribute('data-lx-os', info.os);
    root.setAttribute('data-lx-form', info.form);
    root.setAttribute('data-lx-pointer', info.pointer);
    ensureViewport(doc);
    return info;
  }

  function install(windowObject) {
    if (!windowObject || !windowObject.document || windowObject.__lxDeviceAdapt) return;
    windowObject.__lxDeviceAdapt = true;
    const run = () => apply(windowObject);
    if (windowObject.document.readyState === 'loading') {
      windowObject.document.addEventListener('DOMContentLoaded', run);
    }
    run();
    windowObject.addEventListener('resize', run);
    windowObject.addEventListener('orientationchange', run);
  }

  return { classify, installTarget, ensureViewport, apply, install };
});

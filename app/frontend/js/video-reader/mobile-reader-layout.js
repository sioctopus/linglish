(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.MobileReaderLayout = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function shouldStartSidebarHidden(viewportWidth) {
    return Number(viewportWidth) <= 768;
  }

  function closedSidebarState() {
    return {
      hidden: true,
      expanded: false,
      label: '打开视频库',
      text: '视频库'
    };
  }

  function openSidebarState() {
    return {
      hidden: false,
      expanded: true,
      label: '关闭视频库',
      text: '关闭'
    };
  }

  function nextSidebarState(currentlyHidden) {
    if (currentlyHidden) {
      return openSidebarState();
    }
    return closedSidebarState();
  }

  function usesFocusedTranscriptSizing(bodyClassName) {
    return String(bodyClassName || '')
      .split(/\s+/)
      .includes('video-reader-mobile-focus');
  }

  function configureGuidedTools(tools, active) {
    if (!tools) return null;
    if (active) {
      tools.open = false;
      return tools;
    }
    if (tools.parentElement) {
      // Native details has an internal content box; display:contents cannot
      // make its children participate in the reader's flex ordering on phones.
      const content = Array.from(tools.childNodes).filter(node => node.nodeName !== 'SUMMARY');
      tools.replaceWith(...content);
    }
    return null;
  }

  return {
    shouldStartSidebarHidden,
    nextSidebarState,
    closedSidebarState,
    openSidebarState,
    usesFocusedTranscriptSizing,
    configureGuidedTools
  };
});

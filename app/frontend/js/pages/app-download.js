(function () {
  'use strict';

  const download = document.getElementById('android-download');
  const version = document.getElementById('release-version');
  const size = document.getElementById('release-size');
  const status = document.getElementById('release-status');
  const retry = document.getElementById('release-retry');
  const notes = document.getElementById('release-notes');
  const sha256 = document.getElementById('release-sha256');
  if (!download || !version || !size || !status || !retry || !notes || !sha256) return;

  let current = {
    version: '0.1.5', versionCode: 6, bytes: 35680859,
    sha256: '564a080d38e777075925124e1ef556e364566d717682448f792986b82e39c6d8',
    apkPath: '/app-releases/android/internal/Linglish-0.1.5-code6-arm64.apk',
  };
  let requestId = 0;

  function validateRelease(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schemaVersion !== 1 || value.platform !== 'android' || value.channel !== 'internal'
      || value.applicationId !== 'org.linglish.mobile.dev'
      || !Number.isInteger(value.versionCode) || value.versionCode < 1 || value.versionCode > 2100000000
      || typeof value.version !== 'string' || !/^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value.version)
      || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > 300000000
      || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256)
      || typeof value.publishedAt !== 'string' || !Number.isFinite(Date.parse(value.publishedAt))
      || !Array.isArray(value.notes) || value.notes.length < 1 || value.notes.length > 12
      || !value.notes.every(note => typeof note === 'string' && note.trim() && note.length <= 240)) {
      throw new Error('Invalid release');
    }
    // An exact immutable filename excludes external origins, traversal, query
    // credentials and packages whose identity differs from the displayed release.
    const expectedPath = `/app-releases/android/internal/Linglish-${value.version}-code${value.versionCode}-arm64.apk`;
    if (value.apkPath !== expectedPath) throw new Error('Invalid package path');
    if (value.versionCode === current.versionCode
      && (value.version !== current.version || value.bytes !== current.bytes || value.sha256 !== current.sha256)) {
      throw new Error('Conflicting package identity');
    }
    if (value.versionCode > current.versionCode) {
      const incoming = value.version.split('.').map(Number);
      const shown = current.version.split('.').map(Number);
      const firstDifference = incoming.findIndex((part, index) => part !== shown[index]);
      if (firstDifference >= 0 && incoming[firstDifference] < shown[firstDifference]) throw new Error('Version downgrade');
    }
    return value;
  }

  function showStatus(message, state) {
    status.textContent = message;
    status.setAttribute('data-state', state);
  }

  async function checkRelease() {
    const id = ++requestId;
    let timeout;
    const controller = new AbortController();
    retry.hidden = false;
    retry.disabled = true;
    showStatus('正在检查版本，当前安装包仍可下载。', 'checking');
    try {
      const release = await Promise.race([
        (async () => {
          const response = await fetch('/app-releases/android/internal/latest.json', {
            credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
          });
          if (!response.ok || response.redirected) throw new Error('Release unavailable');
          return validateRelease(await response.json());
        })(),
        new Promise((_, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(new Error('Release check timed out'));
          }, 8000);
        }),
      ]);
      if (id !== requestId) return;
      if (release.versionCode < current.versionCode) {
        showStatus(`继续提供已核实的 ${current.version} 版本。`, 'stale');
        return;
      }
      current = release;
      version.textContent = release.version;
      size.textContent = `${(release.bytes / 1000000).toFixed(1)} MB`;
      sha256.textContent = release.sha256;
      download.href = release.apkPath;
      const items = release.notes.map(note => {
        const item = document.createElement('li');
        item.textContent = note;
        return item;
      });
      notes.replaceChildren(...items);
      showStatus('版本信息已更新，可直接下载。', 'success');
    } catch (_) {
      if (id !== requestId) return;
      showStatus(`暂时无法检查版本，仍可下载已核实的 ${current.version}。`, 'error');
    } finally {
      clearTimeout(timeout);
      if (id === requestId) retry.disabled = false;
    }
  }

  retry.addEventListener('click', checkRelease);
  checkRelease();
})();

/**
 * AuthManager - Centralized Authentication Handling
 * Keeps a 30-day sliding login (90-day ceiling) and a 1-hour data credential.
 * A credential that cannot be decoded locally is left in place; only a real
 * expiry with no refresh session is cleared.
 */
(function (window) {
    function isStorageAvailable(type) {
        try {
            const storage = window[type];
            const x = '__storage_test__';
            storage.setItem(x, x);
            storage.removeItem(x);
            return true;
        } catch (e) {
            return false;
        }
    }

    const CookieStore = {
        getItem: function (sKey) {
            if (!sKey) { return null; }
            return decodeURIComponent(document.cookie.replace(new RegExp("(?:(?:^|.*;)\\s*" + encodeURIComponent(sKey).replace(/[\-\.\+\*]/g, "\\$&") + "\\s*\\=\\s*([^;]*).*$)|^.*$"), "$1")) || null;
        },
        setItem: function (sKey, sValue, vEnd, sPath, sDomain, bSecure) {
            if (!sKey || /^(?:expires|max\-age|path|domain|secure)$/i.test(sKey)) { return false; }
            var sExpires = "";
            if (vEnd) {
                switch (vEnd.constructor) {
                    case Number:
                        sExpires = vEnd === Infinity ? "; expires=Fri, 31 Dec 9999 23:59:59 GMT" : "; max-age=" + vEnd;
                        break;
                    case String:
                        sExpires = "; expires=" + vEnd;
                        break;
                    case Date:
                        sExpires = "; expires=" + vEnd.toUTCString();
                        break;
                }
            }
            document.cookie = encodeURIComponent(sKey) + "=" + encodeURIComponent(sValue) + sExpires + (sDomain ? "; domain=" + sDomain : "") + (sPath ? "; path=" + sPath : "; path=/") + (bSecure ? "; secure" : "");
            return true;
        },
        removeItem: function (sKey, sPath, sDomain) {
            if (!this.hasItem(sKey)) { return false; }
            document.cookie = encodeURIComponent(sKey) + "=; expires=Thu, 01 Jan 1970 00:00:00 GMT" + (sDomain ? "; domain=" + sDomain : "") + (sPath ? "; path=" + sPath : "; path=/");
            return true;
        },
        hasItem: function (sKey) {
            if (!sKey || /^(?:expires|max\-age|path|domain|secure)$/i.test(sKey)) { return false; }
            return (new RegExp("(?:^|;\\s*)" + encodeURIComponent(sKey).replace(/[\-\.\+\*]/g, "\\$&") + "\\s*\\=")).test(document.cookie);
        }
    };

    const MemoryStore = {
        _data: {},
        getItem: function (k) { return this._data[k] || null; },
        setItem: function (k, v) { this._data[k] = String(v); },
        removeItem: function (k) { delete this._data[k]; }
    };

    let useLocalStorage = isStorageAvailable('localStorage');
    let useSessionStorage = isStorageAvailable('sessionStorage');
    let useCookies = navigator.cookieEnabled;
    let mediaClearPromise = null;
    let refreshInFlight = null;
    let refreshPersistent = true;
    const originalFetch = window.fetch ? window.fetch.bind(window) : null;

    const REFRESH_KEY = 'linglish_refresh_token';
    const DEVICE_KEY = 'linglish_device_id';
    const SESSION_MAX_AGE = 60 * 60 * 24 * 90;

    function clearMediaSession() {
        if (mediaClearPromise) return mediaClearPromise;
        const request = window.LinglishMediaSession
            ? window.LinglishMediaSession.clear()
            : originalFetch
                ? originalFetch('/auth/media-session', { method: 'DELETE', credentials: 'include' })
                : Promise.resolve();
        const serialized = Promise.resolve(request).catch(function () { });
        const tracked = serialized.finally(function () {
            if (mediaClearPromise === tracked) mediaClearPromise = null;
        });
        mediaClearPromise = tracked;
        return tracked;
    }

    function clearStoredTokens() {
        if (useLocalStorage) {
            try { localStorage.removeItem('authToken'); localStorage.removeItem('linglish_token'); } catch (e) { }
        }
        if (useSessionStorage) {
            try { sessionStorage.removeItem('authToken'); sessionStorage.removeItem('linglish_token'); } catch (e) { }
        }
        if (useCookies) {
            CookieStore.removeItem('authToken');
            CookieStore.removeItem('linglish_token');
        }
        MemoryStore.removeItem('authToken');
        MemoryStore.removeItem('linglish_token');
    }

    function storageGet(type, key) {
        try { return window[type].getItem(key); } catch (e) { return null; }
    }

    function storageSet(type, key, value) {
        try { window[type].setItem(key, value); return true; } catch (e) { return false; }
    }

    function storageRemove(type, key) {
        try { window[type].removeItem(key); } catch (e) { }
    }

    function usable(value) {
        return value && value !== 'null' && value !== 'undefined';
    }

    function decodeJwtPayload(token) {
        if (!token || typeof token !== 'string') return null;
        const parts = token.split('.');
        if (parts.length < 2 || !parts[1]) return null;
        try {
            let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            return JSON.parse(atob(b64));
        } catch (err) {
            return null;
        }
    }

    function tokenSubject(token) {
        const payload = decodeJwtPayload(token);
        return payload && payload.sub != null ? String(payload.sub) : null;
    }

    function accessExpired(token) {
        const payload = decodeJwtPayload(token);
        if (!payload || typeof payload.exp !== 'number') return false;
        return payload.exp < Math.floor(Date.now() / 1000);
    }

    function accessSecondsLeft(token) {
        const payload = decodeJwtPayload(token);
        if (!payload || typeof payload.exp !== 'number') return Number.POSITIVE_INFINITY;
        return payload.exp - Math.floor(Date.now() / 1000);
    }

    function readRawAccess() {
        const tiers = [];
        if (useLocalStorage) tiers.push(storageGet('localStorage', 'authToken') || storageGet('localStorage', 'linglish_token'));
        if (useSessionStorage) tiers.push(storageGet('sessionStorage', 'authToken') || storageGet('sessionStorage', 'linglish_token'));
        if (useCookies) tiers.push(CookieStore.getItem('authToken') || CookieStore.getItem('linglish_token'));
        tiers.push(MemoryStore.getItem('authToken') || MemoryStore.getItem('linglish_token'));
        for (let i = 0; i < tiers.length; i += 1) {
            if (usable(tiers[i])) return tiers[i];
        }
        return null;
    }

    function writeRefresh(token, remember) {
        if (!usable(token)) return;
        refreshPersistent = remember !== false;
        storageRemove('localStorage', REFRESH_KEY);
        storageRemove('sessionStorage', REFRESH_KEY);
        CookieStore.removeItem(REFRESH_KEY);
        MemoryStore.removeItem(REFRESH_KEY);
        if (refreshPersistent && useLocalStorage && storageSet('localStorage', REFRESH_KEY, token)) return;
        if (!refreshPersistent && useSessionStorage && storageSet('sessionStorage', REFRESH_KEY, token)) return;
        if (useCookies && CookieStore.setItem(REFRESH_KEY, token, refreshPersistent ? SESSION_MAX_AGE : null)) return;
        if (refreshPersistent && useLocalStorage === false && useSessionStorage && storageSet('sessionStorage', REFRESH_KEY, token)) return;
        MemoryStore.setItem(REFRESH_KEY, token);
    }

    function readRefresh() {
        const local = useLocalStorage ? storageGet('localStorage', REFRESH_KEY) : null;
        if (usable(local)) { refreshPersistent = true; return local; }
        const session = useSessionStorage ? storageGet('sessionStorage', REFRESH_KEY) : null;
        if (usable(session)) { refreshPersistent = false; return session; }
        const cookie = useCookies ? CookieStore.getItem(REFRESH_KEY) : null;
        if (usable(cookie)) { refreshPersistent = true; return cookie; }
        const memory = MemoryStore.getItem(REFRESH_KEY);
        if (usable(memory)) return memory;
        return null;
    }

    function clearRefresh() {
        storageRemove('localStorage', REFRESH_KEY);
        storageRemove('sessionStorage', REFRESH_KEY);
        CookieStore.removeItem(REFRESH_KEY);
        MemoryStore.removeItem(REFRESH_KEY);
    }

    function writeDeviceId(id) {
        if (!usable(id)) return;
        if (!(useLocalStorage && storageSet('localStorage', DEVICE_KEY, id))) {
            MemoryStore.setItem(DEVICE_KEY, id);
        }
    }

    function getDeviceId() {
        const existing = (useLocalStorage && storageGet('localStorage', DEVICE_KEY)) || MemoryStore.getItem(DEVICE_KEY);
        if (usable(existing) && /^[A-Za-z0-9_-]{16,80}$/.test(existing)) return existing;
        const bytes = new Uint8Array(16);
        if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
            window.crypto.getRandomValues(bytes);
        } else {
            for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
        }
        const id = Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        writeDeviceId(id);
        return id;
    }

    function requestUrl(input) {
        if (typeof input === 'string') return input;
        if (input && typeof input.url === 'string') return input.url;
            if (input && typeof input.href === 'string') return input.href;
        return '';
    }

    function isSessionEndpoint(url) {
        return /\/auth\/(login|register|guest|refresh|oauth\/session)(?:\?|$)/.test(url);
    }

    function headerHasAuth(headers) {
        if (!headers) return false;
        if (typeof headers.get === 'function') {
            return Boolean(headers.get('Authorization') || headers.get('authorization'));
        }
        return Boolean(headers.Authorization || headers.authorization);
    }

    function captureIssuedSession(response) {
        if (!response || typeof response.clone !== 'function') return;
        response.clone().json().then(function (data) {
            if (!data || typeof data !== 'object') return;
            if (data.device_id) writeDeviceId(data.device_id);
            if (data.refresh_token) writeRefresh(data.refresh_token, true);
        }).catch(function () { });
    }

    function clearLocalCredentials() {
        clearStoredTokens();
        clearRefresh();
    }

    console.log(`[AuthManager] Storage Status: LS=${useLocalStorage}, SS=${useSessionStorage}, Cookies=${useCookies}`);

    const AuthManager = {
        setToken: async function (token, remember) {
            if (!token) {
                console.warn('[AuthManager] setToken: no token provided');
                return false;
            }

            const previousToken = readRawAccess();
            if (previousToken && previousToken !== token) {
                const previousSub = tokenSubject(previousToken);
                const nextSub = tokenSubject(token);
                clearStoredTokens();
                if (previousSub && nextSub && previousSub !== nextSub) {
                    await clearMediaSession();
                }
            } else if (mediaClearPromise) {
                await mediaClearPromise;
            }

            const refresh = readRefresh();
            if (refresh) writeRefresh(refresh, !!remember);

            if (remember && useLocalStorage) {
                try {
                    localStorage.setItem('authToken', token);
                    localStorage.setItem('linglish_token', token);
                    return true;
                } catch (e) {
                    console.warn('[AuthManager] localStorage failed:', e.message);
                }
            } else if (!remember && useSessionStorage) {
                try {
                    sessionStorage.setItem('authToken', token);
                    sessionStorage.setItem('linglish_token', token);
                    return true;
                } catch (e) {
                    console.warn('[AuthManager] sessionStorage failed:', e.message);
                }
            }

            if (useCookies) {
                try {
                    const expires = remember ? SESSION_MAX_AGE : null;
                    CookieStore.setItem('authToken', token, expires);
                    CookieStore.setItem('linglish_token', token, expires);
                    return true;
                } catch (e) {
                    console.warn('[AuthManager] Cookie storage failed:', e.message);
                }
            }

            MemoryStore.setItem('authToken', token);
            MemoryStore.setItem('linglish_token', token);
            return true;
        },

        storeAccess: function (token, remember) {
            if (!token) return false;
            const refresh = readRefresh();
            if (refresh) writeRefresh(refresh, !!remember);
            if (remember && useLocalStorage && storageSet('localStorage', 'authToken', token) && storageSet('localStorage', 'linglish_token', token)) {
                return true;
            }
            if (!remember && useSessionStorage && storageSet('sessionStorage', 'authToken', token) && storageSet('sessionStorage', 'linglish_token', token)) {
                return true;
            }
            if (useCookies && CookieStore.setItem('authToken', token, remember ? SESSION_MAX_AGE : null)) {
                CookieStore.setItem('linglish_token', token, remember ? SESSION_MAX_AGE : null);
                return true;
            }
            MemoryStore.setItem('authToken', token);
            MemoryStore.setItem('linglish_token', token);
            return true;
        },

        saveLogin: async function (payload, remember) {
            const data = payload || {};
            if (data.device_id) writeDeviceId(data.device_id);
            if (data.refresh_token) writeRefresh(data.refresh_token, remember !== false);
            const token = data.access_token || data.token || data.accessToken;
            if (!token) return false;
            return this.setToken(token, remember !== false);
        },

        getToken: function () {
            const refresh = readRefresh();
            const tiers = [
                { name: 'local', read: function () { return useLocalStorage ? (storageGet('localStorage', 'authToken') || storageGet('localStorage', 'linglish_token')) : null; }, clear: function () { storageRemove('localStorage', 'authToken'); storageRemove('localStorage', 'linglish_token'); } },
                { name: 'session', read: function () { return useSessionStorage ? (storageGet('sessionStorage', 'authToken') || storageGet('sessionStorage', 'linglish_token')) : null; }, clear: function () { storageRemove('sessionStorage', 'authToken'); storageRemove('sessionStorage', 'linglish_token'); } },
                { name: 'cookie', read: function () { return useCookies ? (CookieStore.getItem('authToken') || CookieStore.getItem('linglish_token')) : null; }, clear: function () { CookieStore.removeItem('authToken'); CookieStore.removeItem('linglish_token'); } },
                { name: 'memory', read: function () { return MemoryStore.getItem('authToken') || MemoryStore.getItem('linglish_token'); }, clear: function () { MemoryStore.removeItem('authToken'); MemoryStore.removeItem('linglish_token'); } }
            ];

            let stale = null;
            for (let i = 0; i < tiers.length; i += 1) {
                const token = tiers[i].read();
                if (!usable(token)) continue;
                const payload = decodeJwtPayload(token);
                if (!payload) return token;
                if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
                    if (refresh) {
                        stale = stale || token;
                        continue;
                    }
                    console.warn('[AuthManager] Access credential expired in ' + tiers[i].name + ', removing that copy');
                    tiers[i].clear();
                    continue;
                }
                return token;
            }
            if (stale) {
                this.ensureSession();
                return stale;
            }
            return null;
        },

        isTokenExpired: function (token) {
            if (!token || typeof token !== 'string') return true;
            const parts = token.split('.');
            if (parts.length !== 3) return true;
            const payload = decodeJwtPayload(token);
            if (!payload) return false;
            if (typeof payload.exp !== 'number') return false;
            return payload.exp < Math.floor(Date.now() / 1000);
        },

        clearToken: function (options) {
            const refresh = readRefresh();
            const access = readRawAccess();
            clearLocalCredentials();
            const jobs = [];
            if (!(options && options.skipRevoke) && originalFetch && (refresh || access)) {
                const headers = { 'Content-Type': 'application/json' };
                if (access) headers.Authorization = 'Bearer ' + access;
                jobs.push(originalFetch('/auth/logout', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: headers,
                    body: JSON.stringify({ refresh_token: refresh || undefined, device_id: getDeviceId() }),
                }).catch(function () { }));
            }
            if (!(options && options.skipMediaSession)) jobs.push(clearMediaSession());
            return Promise.all(jobs).then(function () { });
        },

        isLoggedIn: function () {
            return !!this.getToken() || !!readRefresh();
        },

        isValidTokenFormat: function (token) {
            if (!token || typeof token !== 'string') return false;
            if (token === 'undefined' || token === 'null') return false;
            const parts = token.split('.');
            return parts.length === 3;
        },

        ensureSession: function (options) {
            const force = Boolean(options && options.force);
            if (refreshInFlight) return refreshInFlight;
            const current = readRawAccess();
            if (!force && current && accessSecondsLeft(current) > 300) return Promise.resolve(current);
            const run = refreshAccess({ force: force });
            const tracked = run.finally(function () {
                if (refreshInFlight === tracked) refreshInFlight = null;
            });
            refreshInFlight = tracked;
            return tracked;
        },

        healthCheck: function () {
            try {
                const token = readRawAccess();
                if (token && !this.isValidTokenFormat(token) && !readRefresh()) {
                    console.warn('[AuthManager] Invalid token detected, clearing...');
                    clearLocalCredentials();
                }
                return true;
            } catch (e) {
                console.error('[AuthManager] Health check failed:', e);
                return false;
            }
        },

        versionCheck: function (currentVersion) {
            const VERSION_KEY = 'linglish_app_version';
            try {
                let storedVersion = null;
                if (useLocalStorage) storedVersion = localStorage.getItem(VERSION_KEY);
                else if (useCookies) storedVersion = CookieStore.getItem(VERSION_KEY);
                else storedVersion = MemoryStore.getItem(VERSION_KEY);

                if (storedVersion !== currentVersion) {
                    console.log('[AuthManager] App version changed. Login session kept.', {
                        stored: storedVersion,
                        current: currentVersion
                    });
                    if (useLocalStorage) localStorage.setItem(VERSION_KEY, currentVersion);
                    else if (useCookies) CookieStore.setItem(VERSION_KEY, currentVersion, Infinity);
                    else MemoryStore.setItem(VERSION_KEY, currentVersion);
                }
                return true;
            } catch (e) {
                console.error('[AuthManager] Version check failed:', e);
                return false;
            }
        }
    };

    async function refreshAccess(options) {
        const refresh = readRefresh();
        const current = readRawAccess();
        const force = Boolean(options && options.force);
        if (!refresh || !originalFetch) {
            return current && !accessExpired(current) ? current : null;
        }
        if (!force && current && accessSecondsLeft(current) > 300) return current;
        try {
            const response = await originalFetch('/auth/refresh', {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Linglish-Device': getDeviceId(),
                },
                body: JSON.stringify({ refresh_token: refresh, device_id: getDeviceId() }),
            });
            const data = await response.json().catch(function () { return {}; });
            if (response.ok && data && data.access_token) {
                if (data.device_id) writeDeviceId(data.device_id);
                writeRefresh(data.refresh_token || refresh, refreshPersistent);
                await AuthManager.setToken(data.access_token, refreshPersistent);
                return data.access_token;
            }
            if (response.status === 401) {
                clearLocalCredentials();
                return null;
            }
            return current || null;
        } catch (err) {
            console.warn('[AuthManager] Session refresh skipped:', err && err.message ? err.message : err);
            return current || null;
        }
    }

    function sameOriginRequest(input) {
        const url = requestUrl(input);
        if (input && !url) return false;
        try { return new URL(url, window.location.href).origin === new URL(window.location.href).origin; }
        catch (_) { return !url || (/^(?:\/(?!\/)|\.\.?\/)/.test(url) && !url.includes('\\')); }
    }

    if (originalFetch) {
        window.fetch = function (input, init) {
            if (!sameOriginRequest(input)) return originalFetch(input, init);
            let retryInput = input;
            try { if (input && typeof input.clone === 'function') retryInput = input.clone(); } catch (_) {}

            const url = requestUrl(input);
            const nextInit = isSessionEndpoint(url) || /\/auth\/logout(?:\?|$)/.test(url)
                ? Object.assign({}, init, {
                    headers: (function () {
                        const headers = new Headers((init && init.headers) || (input && input.headers) || undefined);
                        if (!headers.has('X-Linglish-Device')) headers.set('X-Linglish-Device', getDeviceId());
                        return headers;
                    })()
                })
                : init;
            return originalFetch(input, nextInit).then(function (response) {
                if (response && response.ok && isSessionEndpoint(url)) captureIssuedSession(response);
                if (!response || response.status !== 401 || isSessionEndpoint(url) || /\/auth\/logout(?:\?|$)/.test(url)) {
                    return response;
                }
                if (nextInit && nextInit.__linglishRetried) return response;
                if (!headerHasAuth(nextInit && nextInit.headers) && !headerHasAuth(init && init.headers) && !headerHasAuth(input && input.headers)) {
                    return response;
                }
                return AuthManager.ensureSession({ force: true }).then(function (renewed) {
                    if (!renewed) return response;
                    const headers = new Headers((nextInit && nextInit.headers) || (init && init.headers) || (input && input.headers) || undefined);
                    headers.set('Authorization', 'Bearer ' + renewed);
                    const retryInit = Object.assign({}, nextInit || init, { headers: headers, __linglishRetried: true });
                    return originalFetch(retryInput, retryInit);
                });
            });
        };
    }

    function refreshAccessBlocking() {
        const refresh = readRefresh();
        const current = readRawAccess();
        if (!refresh) return current && !accessExpired(current) ? current : null;
        if (current && accessSecondsLeft(current) > 300) return current;
        if (typeof XMLHttpRequest !== 'function') return current || null;
        try {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/auth/refresh', false);
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.setRequestHeader('X-Linglish-Device', getDeviceId());
            xhr.send(JSON.stringify({ refresh_token: refresh, device_id: getDeviceId() }));
            if (xhr.status === 200) {
                const data = JSON.parse(xhr.responseText || '{}');
                if (data && data.access_token) {
                    if (data.device_id) writeDeviceId(data.device_id);
                    writeRefresh(data.refresh_token || refresh, refreshPersistent);
                    AuthManager.storeAccess(data.access_token, refreshPersistent);
                    return data.access_token;
                }
            }
            if (xhr.status === 401) {
                clearLocalCredentials();
                return null;
            }
        } catch (err) {
            console.warn('[AuthManager] Session refresh skipped:', err && err.message ? err.message : err);
        }
        return current || null;
    }

    const APP_VERSION = '2024.12.16.002';

    try {
        AuthManager.versionCheck(APP_VERSION);
        AuthManager.healthCheck();
        AuthManager.ready = Promise.resolve(refreshAccessBlocking());
    } catch (e) {
        console.error('[AuthManager] Initialization checks failed:', e);
        AuthManager.ready = Promise.resolve(null);
    }

    window.AuthManager = AuthManager;

})(window);

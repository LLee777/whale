// 指纹UUID管理器 - 作为普通脚本引入
(function() {
  'use strict';

  const UUID_KEY = 'fingerprint_uuid';
  const DB_NAME = 'FingerprintDB';
  const STORE_NAME = 'fingerprints';
  const DB_VERSION = 1;

  // 生成UUID v4
  function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Cookie操作
  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? match[2] : null;
  }

  function setCookie(name, value, days) {
    days = days || 180;
    var expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = name + '=' + value + '; expires=' + expires + '; path=/; SameSite=Lax';
  }

  // IndexedDB操作
  function openDB() {
    return new Promise(function(resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = function() { reject(request.error); };
      request.onsuccess = function() { resolve(request.result); };

      request.onupgradeneeded = function(event) {
        var db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
    });
  }

  function getFromIndexedDB(key) {
    return openDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        var transaction = db.transaction([STORE_NAME], 'readonly');
        var store = transaction.objectStore(STORE_NAME);
        var request = store.get(key);

        request.onerror = function() { reject(request.error); };
        request.onsuccess = function() {
          resolve(request.result ? request.result.value : null);
        };
      });
    });
  }

  function saveToIndexedDB(key, value) {
    return openDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        var transaction = db.transaction([STORE_NAME], 'readwrite');
        var store = transaction.objectStore(STORE_NAME);
        var request = store.put({ id: key, value: value });

        request.onerror = function() { reject(request.error); };
        request.onsuccess = function() { resolve(); };
      });
    });
  }

  function deleteFromIndexedDB(key) {
    return openDB().then(function(db) {
      return new Promise(function(resolve, reject) {
        var transaction = db.transaction([STORE_NAME], 'readwrite');
        var store = transaction.objectStore(STORE_NAME);
        var request = store.delete(key);

        request.onerror = function() { reject(request.error); };
        request.onsuccess = function() { resolve(); };
      });
    });
  }

  function deleteCookie(name) {
    document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
  }

  // 主逻辑：初始化指纹
  async function initFingerprint() {
    try {
      // 1. 先检查cookies
      var uuid = getCookie(UUID_KEY);

      if (uuid) {
        // 2. Cookies中有指纹，再与IndexedDB对比
        var dbUuid = await getFromIndexedDB(UUID_KEY);
        if (dbUuid && dbUuid === uuid) {
          console.log('[Fingerprint] UUID verified (cookies == IndexedDB):', uuid);
          return uuid;
        }
        // 不一致或IndexedDB缺失，清空两者后重新生成
        console.log('[Fingerprint] UUID mismatch or IndexedDB missing, clearing and regenerating...');
        deleteCookie(UUID_KEY);
        if (dbUuid) {
          await deleteFromIndexedDB(UUID_KEY);
        }
      } else {
        console.log('[Fingerprint] UUID not found in cookies, checking IndexedDB...');

        // 2. 检查IndexedDB
        uuid = await getFromIndexedDB(UUID_KEY);

        if (uuid) {
          console.log('[Fingerprint] UUID found in IndexedDB:', uuid);
          setCookie(UUID_KEY, uuid);
          return uuid;
        }

        console.log('[Fingerprint] UUID not found in IndexedDB, generating new one...');
      }

      // 3. 生成新的UUID
      uuid = generateUUID();

      // 4. 同时存入IndexedDB和cookies
      await saveToIndexedDB(UUID_KEY, uuid);
      setCookie(UUID_KEY, uuid);

      console.log('[Fingerprint] New UUID generated and saved:', uuid);
      return uuid;

    } catch (error) {
      console.error('[Fingerprint] Error initializing fingerprint:', error);
      return null;
    }
  }

  // 获取指纹信息
  async function getFingerprintInfo() {
    try {
      var uuid = getCookie(UUID_KEY);
      if (uuid) {
        return { uuid: uuid, source: 'cookie' };
      }

      uuid = await getFromIndexedDB(UUID_KEY);
      if (uuid) {
        return { uuid: uuid, source: 'indexeddb' };
      }

      return { uuid: null, source: null };
    } catch (error) {
      console.error('[Fingerprint] Error getting fingerprint info:', error);
      return { uuid: null, source: null, error: error.message };
    }
  }

  // 清除指纹
  async function clearFingerprint() {
    try {
      deleteCookie(UUID_KEY);
      await deleteFromIndexedDB(UUID_KEY);
      console.log('[Fingerprint] Fingerprint cleared');
      return { success: true };
    } catch (error) {
      console.error('[Fingerprint] Error clearing fingerprint:', error);
      return { success: false, error: error.message };
    }
  }

  // 暴露到全局
  window.FingerprintManager = {
    init: initFingerprint,
    getInfo: getFingerprintInfo,
    clear: clearFingerprint,
    getCookie: getCookie,
    setCookie: setCookie
  };

  // 指纹就绪Promise，供后续脚本等待
  var fingerprintReadyResolve;
  var fingerprintReadyReject;
  window.FingerprintReady = new Promise(function(resolve, reject) {
    fingerprintReadyResolve = resolve;
    fingerprintReadyReject = reject;
  });

  // 页面加载时自动初始化，完成后解除后续脚本阻塞
  (async function() {
    try {
      var uuid = await initFingerprint();
      if (uuid) {
        console.log('[Fingerprint] Fingerprint ready, UUID:', uuid);
      }
      fingerprintReadyResolve(uuid);
    } catch (error) {
      console.error('[Fingerprint] Init failed:', error);
      fingerprintReadyReject(error);
    }
  })();

})();

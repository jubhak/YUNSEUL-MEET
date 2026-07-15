/**
 * 호스트 PPT ArrayBuffer 로컬 캐시 (IndexedDB).
 * 새로고침 시 서버 재다운로드 없이 같은 방·같은 파일을 재사용.
 */

const DB_NAME = 'yunseul-ppt-cache';
const DB_VER = 1;
const STORE = 'ppt';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'roomCode' });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
}

/**
 * @param {string} roomCode
 * @param {string} fileKey  presentation.filename 등
 * @param {ArrayBuffer} buffer
 * @param {{ originalName?: string, url?: string }} [meta]
 */
export async function putPptCache(roomCode, fileKey, buffer, meta = {}) {
  const code = String(roomCode || '').toUpperCase();
  const key = String(fileKey || '');
  if (!code || !key || !buffer) return;

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.objectStore(STORE).put({
      roomCode: code,
      fileKey: key,
      buffer,
      originalName: meta.originalName || '',
      url: meta.url || '',
      updatedAt: Date.now(),
    });
  });
}

/**
 * @param {string} roomCode
 * @param {string} fileKey
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function getPptCache(roomCode, fileKey) {
  const code = String(roomCode || '').toUpperCase();
  const key = String(fileKey || '');
  if (!code || !key) return null;

  try {
    const db = await openDb();
    const row = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(code);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    if (!row || row.fileKey !== key || !row.buffer) return null;
    return row.buffer;
  } catch (err) {
    console.warn('[ppt-cache] get failed', err);
    return null;
  }
}

export function fileKeyFromPresentation(presentation) {
  if (!presentation) return '';
  if (presentation.filename) return String(presentation.filename);
  const url = String(presentation.url || '');
  const m = url.match(/(?:f=|\/)([a-f0-9]{32}\.(?:pptx|ppt))/i);
  if (m) return m[1];
  return url.split('/').pop() || '';
}

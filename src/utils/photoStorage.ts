/**
 * 照片独立存储层
 *
 * 原图字节存放在 IndexedDB（与长椅档案数据完全隔离，不挤占
 * localStorage 中的 `bench-archive-data`）；localStorage 中只保存
 * 轻量清单：内容哈希 -> 元数据（类型、大小）+ 每张长椅的有序照片引用。
 *
 * - 以 SHA-256 内容哈希作为照片主键，内容相同只存一份，多张长椅可共用
 * - 引用归零后由 GC 删除 blob 与清单条目
 * - 写入前用 StorageManager.estimate 预检剩余空间，不足时拒绝且不改动已有内容
 */

const DB_NAME = 'bench-archive-photos';
const DB_VERSION = 1;
const STORE_NAME = 'blobs';
const MANIFEST_KEY = 'bench-archive-photo-manifest';
/** 配额预检预留的安全余量（字节），避免写满最后一点空间 */
const QUOTA_SAFETY_MARGIN = 256 * 1024;

export interface PhotoMeta {
  /** SHA-256 内容哈希，同时也是 IndexedDB 中的 key */
  hash: string;
  type: string;
  size: number;
  /** 引用该照片的长椅 id 集合 */
  refs: string[];
}

export interface BenchPhotoLink {
  hash: string;
  /** 挂到该长椅时使用的文件名，仅用于展示 */
  name: string;
}

export interface PhotoManifest {
  /** hash -> 元数据 */
  photos: Record<string, PhotoMeta>;
  /** benchId -> 有序照片引用，第一个为封面 */
  links: Record<string, BenchPhotoLink[]>;
  version: 1;
}

export class QuotaError extends Error {
  constructor(
    public readonly required: number,
    public readonly available: number,
  ) {
    super(
      `剩余空间不足：需要约 ${formatBytes(required)}，可用约 ${formatBytes(available)}`,
    );
    this.name = 'QuotaError';
  }
}

const emptyManifest = (): PhotoManifest => ({ photos: {}, links: {}, version: 1 });

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

export function loadManifest(): PhotoManifest {
  const raw = localStorage.getItem(MANIFEST_KEY);
  if (!raw) return emptyManifest();
  const parsed = JSON.parse(raw) as Partial<PhotoManifest>;
  return {
    photos: parsed.photos && typeof parsed.photos === 'object' ? parsed.photos : {},
    links: parsed.links && typeof parsed.links === 'object' ? parsed.links : {},
    version: 1,
  };
}

export function saveManifest(manifest: PhotoManifest): void {
  localStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest));
}

/** 估算当前可用于照片的剩余字节；拿不到配额信息时返回 null */
export async function estimateAvailableBytes(): Promise<number | null> {
  if (!('storage' in navigator) || typeof navigator.storage.estimate !== 'function') {
    return null;
  }
  try {
    const est = await navigator.storage.estimate();
    if (typeof est.quota !== 'number' || typeof est.usage !== 'number') {
      return null;
    }
    return Math.max(0, est.quota - est.usage - QUOTA_SAFETY_MARGIN);
  } catch {
    return null;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 计算文件内容的 SHA-256 哈希（十六进制） */
export async function hashBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  if (crypto?.subtle?.digest) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // 兜底：极老环境没有 subtle.digest，用 FNV 风格摘要（内容相同仍可去重）
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const view = new Uint8Array(buffer);
  for (let i = 0; i < view.length; i++) {
    h1 = Math.imul(h1 ^ view[i], 2654435761);
    h2 = Math.imul(h2 ^ view[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  return `fallback-${hex}`;
}

function storeRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getPhotoBlob(hash: string): Promise<Blob | undefined> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const result = await storeRequest(tx.objectStore(STORE_NAME).get(hash));
  return (result as Blob | undefined) ?? undefined;
}

/** 列出 IDB 中全部 blob 的 key（启动对账用） */
export async function listAllBlobKeys(): Promise<string[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const result = await storeRequest(tx.objectStore(STORE_NAME).getAllKeys());
  return result.map((key) => String(key));
}

/** 单个新 hash 对应一条待写入 */
export interface NewPhotoBlob {
  hash: string;
  blob: Blob;
}

/**
 * 在单个读写事务内批量写入新 blob。
 * 任一写入失败则整个事务中止，已写入的条目随事务回滚，
 * 不会出现清单引用了但 blob 缺失的断链。
 */
export async function putPhotoBlobs(items: NewPhotoBlob[]): Promise<void> {
  if (items.length === 0) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('照片写入事务中止'));
    const store = tx.objectStore(STORE_NAME);
    for (const item of items) {
      store.put(item.blob, item.hash);
    }
  });
}

/** 批量删除（GC：引用归零） */
export async function deletePhotoBlobs(hashes: string[]): Promise<void> {
  if (hashes.length === 0) return;
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('照片删除事务中止'));
    const store = tx.objectStore(STORE_NAME);
    for (const hash of hashes) {
      store.delete(hash);
    }
  });
}

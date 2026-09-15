/**
 * 照片独立存储层（v2，事务化）
 *
 * 原图字节与照片清单都存放在独立的 IndexedDB 中，与长椅档案数据
 * （localStorage 的 `bench-archive-data`）完全隔离，不挤占档案空间。
 *
 * 为什么用 IDB 而不再把清单放 localStorage：
 * 多标签页场景下，localStorage 的“整份读—整份写”会丢更新
 * （两侧同读一份清单后整份写回，后写覆盖先写）；而且引用计数变化
 * 与 blob 的写/删无法构成一个跨标签页串行的原子单元。
 *
 * 现在：
 * - blobs store：内容哈希 -> blob
 * - meta store：单记录（photos 内容表、links 长椅引用、revision 修订号）
 * - 每次改动（加照片 / 移除 / 排序 / 设封面 / 释放长椅引用）都在一个
 *   IDB readwrite 事务内完成：读清单 → 计算新清单 + 决定写/删哪些 blob
 *   → 全部同事务写入。IDB 事务在所有标签页间自动串行，因此不会覆盖，
 *   也不会出现先上传的照片刷新后消失。
 * - 内容相同只存一份：以 SHA-256 为 key；是否已存在由事务内的清单判定，
 *   两个标签页同时传同一份内容时只 put 同一个 key（幂等），引用各加各的。
 * - 引用归零的照片在同一事务内删 blob + 移除元数据。
 * - 写入前用 StorageManager.estimate 预检剩余空间；放不下明确拒绝，
 *   事务失败自动回滚，已有内容不受影响。
 */

const DB_NAME = 'bench-archive-photos';
const DB_VERSION = 2;
const BLOB_STORE = 'blobs';
const META_STORE = 'meta';
const META_KEY = 'manifest';
/** v1 时代的 localStorage 清单键，用于一次性迁移 */
const LEGACY_MANIFEST_KEY = 'bench-archive-photo-manifest';
/** 照片存储健康信号键（仅存时间戳），用于跨标签页通知 */
const SIGNAL_KEY = 'bench-archive-photo-signal';
/** 配额预检预留的安全余量（字节） */
const QUOTA_SAFETY_MARGIN = 256 * 1024;

export interface PhotoMeta {
  /** SHA-256 内容哈希，同时也是 blobs store 的 key */
  hash: string;
  type: string;
  size: number;
  /** 引用该照片的长椅 id 列表 */
  refs: string[];
}

export interface BenchPhotoLink {
  hash: string;
  /** 挂到该长椅时使用的文件名，仅用于展示 */
  name: string;
}

export interface PhotoManifest {
  /** hash -> 权威内容表 */
  photos: Record<string, PhotoMeta>;
  /** benchId -> 有序引用，第一个为封面 */
  links: Record<string, BenchPhotoLink[]>;
  /** 单调递增的修订号，每次提交递增 */
  revision: number;
}

export class QuotaError extends Error {
  constructor(
    public readonly required: number,
    public readonly available: number,
  ) {
    super(`剩余空间不足：需要约 ${formatBytes(required)}，可用约 ${formatBytes(available)}`);
    this.name = 'QuotaError';
  }
}

const emptyManifest = (): PhotoManifest => ({ photos: {}, links: {}, revision: 0 });

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      let migrated = false;
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(BLOB_STORE)) {
          db.createObjectStore(BLOB_STORE);
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
        // v1 -> v2：meta store 新建（必然为空），把旧 localStorage 清单迁入
        try {
          const raw = localStorage.getItem(LEGACY_MANIFEST_KEY);
          if (raw) {
            const parsed = JSON.parse(raw) as Partial<PhotoManifest>;
            const manifest: PhotoManifest = {
              photos: parsed.photos ?? {},
              links: parsed.links ?? {},
              revision: 0,
            };
            request.transaction?.objectStore(META_STORE).put(manifest, META_KEY);
            migrated = true;
          }
        } catch (error) {
          console.warn('旧照片清单迁移被跳过：', error);
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        // 仅当清单确实迁入事务后才删除旧键，损坏时保留以便人工处理
        if (migrated) {
          try {
            localStorage.removeItem(LEGACY_MANIFEST_KEY);
          } catch {
            /* ignore */
          }
        }
        resolve(db);
      };
      const fail = (reason: unknown) => {
        // 允许下次调用重新尝试打开（例如被其它标签页阻塞，关闭后可重试）
        dbPromise = null;
        reject(reason instanceof Error ? reason : new Error('照片数据库打开失败'));
      };
      request.onerror = () => fail(request.error);
      request.onblocked = () =>
        fail(new Error('照片数据库被其它标签页占用，请关闭其它标签页后重试'));
    });
  }
  return dbPromise;
}

export function initPhotoDb(): Promise<IDBDatabase> {
  return openDb();
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readManifest(): Promise<PhotoManifest> {
  const db = await openDb();
  const tx = db.transaction(META_STORE, 'readonly');
  const data = await req(tx.objectStore(META_STORE).get(META_KEY));
  if (!data) return emptyManifest();
  return {
    photos: data.photos ?? {},
    links: data.links ?? {},
    revision: typeof data.revision === 'number' ? data.revision : 0,
  };
}

export async function getPhotoBlob(hash: string): Promise<Blob | undefined> {
  const db = await openDb();
  const tx = db.transaction(BLOB_STORE, 'readonly');
  const result = await req(tx.objectStore(BLOB_STORE).get(hash));
  return (result as Blob | undefined) ?? undefined;
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

/** 计算文件 SHA-256（十六进制） */
export async function hashBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  if (crypto?.subtle?.digest) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // 兜底：极老环境无 subtle.digest，用 FNV 风格摘要（内容相同仍可幂等去重）
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  const view = new Uint8Array(buffer);
  for (let i = 0; i < view.length; i++) {
    h1 = Math.imul(h1 ^ view[i], 2654435761);
    h2 = Math.imul(h2 ^ view[i], 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex =
    (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  return `fallback-${hex}`;
}

/**
 * 在一个跨标签页串行的 readwrite 事务内执行一次修改。
 * mutate 基于事务内读出的权威清单 base 做纯计算，返回：
 * 新清单、要写入的 blob、要删除（GC）的 hash；revision 由本函数统一递增。
 * 两个标签页同时提交时，IDB 保证事务一先一后，后者看到的 base 已含前者结果。
 */
export async function commitManifest(
  mutate: (base: PhotoManifest) => {
    manifest: Omit<PhotoManifest, 'revision'>;
    putBlobs?: { hash: string; blob: Blob }[];
    deleteBlobs?: string[];
  },
): Promise<PhotoManifest> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, BLOB_STORE], 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const blobStore = tx.objectStore(BLOB_STORE);
    let committed: PhotoManifest | null = null;

    const getReq = metaStore.get(META_KEY);
    getReq.onsuccess = () => {
      const raw = getReq.result as PhotoManifest | undefined;
      const base: PhotoManifest = raw
        ? { photos: raw.photos ?? {}, links: raw.links ?? {}, revision: raw.revision ?? 0 }
        : emptyManifest();

      let plan: ReturnType<Parameters<typeof commitManifest>[0]>;
      try {
        plan = mutate(base);
      } catch (err) {
        tx.abort();
        reject(err);
        return;
      }

      const next: PhotoManifest = {
        photos: plan.manifest.photos,
        links: plan.manifest.links,
        revision: base.revision + 1,
      };

      // blob 的写/删与清单在同一事务：要么一起生效，要么一起回滚
      for (const item of plan.putBlobs ?? []) {
        blobStore.put(item.blob, item.hash);
      }
      for (const hash of plan.deleteBlobs ?? []) {
        blobStore.delete(hash);
      }
      metaStore.put(next, META_KEY);
      committed = next;
    };
    getReq.onerror = () => reject(getReq.error);
    tx.oncomplete = () => {
      signalOtherTabs();
      resolve(committed ?? emptyManifest());
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('照片事务中止，已回滚'));
  });
}

/** 通过 localStorage storage 事件通知其它标签页重新拉取（本页写入不触发自己） */
function signalOtherTabs() {
  try {
    localStorage.setItem(SIGNAL_KEY, String(Date.now()));
  } catch {
    /* 信号失败不影响本标签页 */
  }
}

/** 监听其它标签页的照片改动；返回退订函数 */
export function subscribePhotoChanges(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const handler = (e: StorageEvent) => {
    if (e.key !== SIGNAL_KEY) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, 60);
  };
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener('storage', handler);
    if (timer) clearTimeout(timer);
  };
}

/** 启动时清理孤儿 blob：以 meta 记录为准，只保留清单中存在的 hash */
export async function reconcileBlobs(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, BLOB_STORE], 'readwrite');
    const metaReq = tx.objectStore(META_STORE).get(META_KEY);
    metaReq.onsuccess = () => {
      const manifest = (metaReq.result as PhotoManifest | undefined) ?? emptyManifest();
      const referenced = new Set(Object.keys(manifest.photos));
      const keysReq = tx.objectStore(BLOB_STORE).getAllKeys();
      keysReq.onsuccess = () => {
        const orphans = keysReq.result
          .map((k) => String(k))
          .filter((k) => !referenced.has(k));
        for (const hash of orphans) {
          tx.objectStore(BLOB_STORE).delete(hash);
        }
        if (orphans.length > 0) signalOtherTabs();
        tx.oncomplete = () => resolve(orphans.length);
      };
      keysReq.onerror = () => reject(keysReq.error);
    };
    metaReq.onerror = () => reject(metaReq.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('照片对账事务中止'));
  });
}

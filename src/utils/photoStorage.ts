/**
 * 照片独立存储层（v3，带来源保护）
 *
 * 原图字节与照片清单都存放在独立的 IndexedDB 中，与长椅档案数据
 * （localStorage 的 `bench-archive-data`）完全隔离，不挤占档案空间。
 *
 * 来源保护（关键不变量）：
 * 在能够确认每个 blob 归属（被某张长椅引用）之前，绝不写入“空清单”，
 * 也绝不删除任何 blob。任何“有字节但清单来源不可用”的情形都会进入
 * blocked 保护态：字节原样保留、旧键保留、禁止写入与回收，并给出明确原因。
 *
 * - blobs store：内容哈希 -> blob
 * - meta store：单记录，要么是合法清单，要么是阻断标记 BlockMarker
 * - 加照片 / 移除 / 排序 / 设封面 / 释放引用都在一个跨标签页串行的
 *   IDB readwrite 事务内完成（读 meta + blob 键集 → 计算 → 写 blob 与清单），
 *   多标签页不会互相覆盖；引用归零的 blob 与清单删除同事务原子提交。
 * - 内容相同只存一份（SHA-256 为 key，事务内权威判重，put 幂等）。
 * - 写入前用 StorageManager.estimate 预检剩余空间；放不下明确拒绝，
 *   事务失败整体回滚。
 */

const DB_NAME = 'bench-archive-photos';
const DB_VERSION = 2;
const BLOB_STORE = 'blobs';
const META_STORE = 'meta';
const META_KEY = 'manifest';
/** v1 时代的 localStorage 清单键，迁移成功后才删除，失败则原样保留 */
const LEGACY_MANIFEST_KEY = 'bench-archive-photo-manifest';
/** 跨标签页通知信号键 */
const SIGNAL_KEY = 'bench-archive-photo-signal';
const QUOTA_SAFETY_MARGIN = 256 * 1024;

export interface PhotoMeta {
  hash: string;
  type: string;
  size: number;
  refs: string[];
}

export interface BenchPhotoLink {
  hash: string;
  name: string;
}

export interface PhotoManifest {
  photos: Record<string, PhotoMeta>;
  links: Record<string, BenchPhotoLink[]>;
  revision: number;
}

/** meta 记录为阻断标记时：保留现场，禁止一切写入/删除 */
interface BlockMarker {
  __blocked: true;
  reason: string;
  at: string;
}

export type Provenance =
  | { status: 'empty' }
  | { status: 'ready'; manifest: PhotoManifest }
  | { status: 'legacy-readable'; manifest: PhotoManifest }
  | { status: 'blocked'; reason: string };

export class QuotaError extends Error {
  constructor(
    public readonly required: number,
    public readonly available: number,
  ) {
    super(`剩余空间不足：需要约 ${formatBytes(required)}，可用约 ${formatBytes(available)}`);
    this.name = 'QuotaError';
  }
}

export class BlockedError extends Error {
  constructor(public readonly reason: string) {
    super(`照片库处于保护态，已停止写入：${reason}`);
    this.name = 'BlockedError';
  }
}

const emptyManifest = (): PhotoManifest => ({ photos: {}, links: {}, revision: 0 });

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** 结构校验清单；任何字段不对都视为不可用（调用方负责保留现场） */
function validateManifest(value: unknown): PhotoManifest | null {
  if (!isObject(value)) return null;
  const { photos, links } = value;
  if (!isObject(photos) || !isObject(links)) return null;

  for (const [hash, meta] of Object.entries(photos)) {
    if (!isObject(meta)) return null;
    if (typeof meta.hash !== 'string' || meta.hash !== hash) return null;
    if (typeof meta.type !== 'string' || typeof meta.size !== 'number') return null;
    if (!Array.isArray(meta.refs) || !meta.refs.every((r) => typeof r === 'string')) return null;
  }
  for (const linksOfBench of Object.values(links)) {
    if (!Array.isArray(linksOfBench)) return null;
    for (const link of linksOfBench) {
      if (!isObject(link) || typeof link.hash !== 'string' || typeof link.name !== 'string') {
        return null;
      }
    }
  }
  return {
    photos: photos as PhotoManifest['photos'],
    links: links as PhotoManifest['links'],
    revision: typeof value.revision === 'number' ? value.revision : 0,
  };
}

function isBlockMarker(value: unknown): value is BlockMarker {
  return isObject(value) && value.__blocked === true && typeof value.reason === 'string';
}

function readLegacy(): { raw: string | null; manifest: PhotoManifest | null } {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_MANIFEST_KEY);
  } catch {
    raw = null;
  }
  if (raw === null) return { raw: null, manifest: null };
  try {
    return { raw, manifest: validateManifest(JSON.parse(raw)) };
  } catch {
    return { raw, manifest: null };
  }
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      let migrated = false;

      request.onupgradeneeded = () => {
        const db = request.result;
        const tx = request.transaction;
        if (!db.objectStoreNames.contains(BLOB_STORE)) db.createObjectStore(BLOB_STORE);
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
        const metaStore = tx!.objectStore(META_STORE);

        // 迁移只在 meta 尚无记录时进行；已有合法记录/标记则一律不碰
        const checkReq = metaStore.get(META_KEY);
        checkReq.onsuccess = () => {
          if (checkReq.result !== undefined && checkReq.result !== null) return;

          const legacy = readLegacy();
          if (legacy.raw !== null) {
            if (legacy.manifest) {
              // 旧清单可用且结构合法：迁入，revision 从 0 开始
              metaStore.put(
                { photos: legacy.manifest.photos, links: legacy.manifest.links, revision: 0 },
                META_KEY,
              );
              migrated = true;
            } else {
              // 旧键在但读不出来：写阻断标记，绝不用空清单顶替
              metaStore.put(
                {
                  __blocked: true,
                  reason: '旧照片清单无法读取，已保留全部照片字节与旧数据，停止写入以防误删',
                  at: new Date().toISOString(),
                } satisfies BlockMarker,
                META_KEY,
              );
            }
            return;
          }

          // 没有旧清单键：必须确认 blob 库也是空的，否则来源不明，进入保护态
          const keysReq = tx!.objectStore(BLOB_STORE).getAllKeys();
          keysReq.onsuccess = () => {
            if (keysReq.result.length > 0) {
              metaStore.put(
                {
                  __blocked: true,
                  reason: '检测到没有任何清单归属的照片字节，已原样保留并停止写入',
                  at: new Date().toISOString(),
                } satisfies BlockMarker,
                META_KEY,
              );
            }
          };
        };
      };

      request.onsuccess = () => {
        const db = request.result;
        // 旧版本标签页持有连接时主动让路，避免升级被阻塞
        db.onversionchange = () => db.close();
        // 仅在清单确实随升级事务迁入后才删除旧键；保护态下旧键原样保留
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

/**
 * 判定当前照片字节的来源状态。这是“能不能写、能不能删”的唯一依据：
 * 只有 ready（有合法清单）或 empty（确认库为空）才允许写；
 * 只有 ready 才允许回收孤儿 blob。
 */
export async function getProvenance(): Promise<Provenance> {
  const db = await openDb();
  const tx = db.transaction([META_STORE, BLOB_STORE], 'readonly');
  const meta = await req(tx.objectStore(META_STORE).get(META_KEY));
  const keys = (await req(tx.objectStore(BLOB_STORE).getAllKeys())).map((k) => String(k));

  const manifest = validateManifest(meta);
  if (manifest) return { status: 'ready', manifest };
  if (isBlockMarker(meta)) return { status: 'blocked', reason: meta.reason };

  // meta 缺失或损坏：看旧清单能否救场
  const legacy = readLegacy();
  if (legacy.manifest) return { status: 'legacy-readable', manifest: legacy.manifest };

  if (keys.length === 0 && legacy.raw === null) return { status: 'empty' };

  const reason =
    legacy.raw !== null
      ? '旧照片清单无法读取，已保留全部照片字节与旧数据，停止写入以防误删'
      : isObject(meta)
        ? '照片清单记录已损坏，照片字节原样保留，停止写入'
        : '检测到没有任何清单归属的照片字节，已原样保留并停止写入';
  return { status: 'blocked', reason };
}

export async function readManifest(): Promise<PhotoManifest> {
  const provenance = await getProvenance();
  if (provenance.status === 'ready' || provenance.status === 'legacy-readable') {
    return provenance.manifest;
  }
  if (provenance.status === 'empty') return emptyManifest();
  throw new BlockedError(provenance.reason);
}

export async function getPhotoBlob(hash: string): Promise<Blob | undefined> {
  const db = await openDb();
  const tx = db.transaction(BLOB_STORE, 'readonly');
  const result = await req(tx.objectStore(BLOB_STORE).get(hash));
  return (result as Blob | undefined) ?? undefined;
}

/** 估算当前可用于照片的剩余字节；拿不到时返回 null */
export async function estimateAvailableBytes(): Promise<number | null> {
  if (!('storage' in navigator) || typeof navigator.storage.estimate !== 'function') return null;
  try {
    const est = await navigator.storage.estimate();
    if (typeof est.quota !== 'number' || typeof est.usage !== 'number') return null;
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

export async function hashBlob(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  if (crypto?.subtle?.digest) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
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
 * 跨标签页串行的原子修改。
 * 事务内同时读取 meta 与全部 blob 键：
 * - meta 是阻断标记 / 损坏记录 → 中止，抛 BlockedError，一个字节都不动
 * - meta 缺失但 blob 非空（来源不明）→ 同样中止
 * - meta 缺失且 blob 为空 → 以空清单起步（首次使用）
 * - meta 合法 → 在其基础上修改，revision + 1
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

    const metaReq = metaStore.get(META_KEY);
    const keysReq = blobStore.getAllKeys();

    metaReq.onsuccess = () => {
      keysReq.onsuccess = () => {
        const rawMeta = metaReq.result;
        const blobKeys = keysReq.result.map((k) => String(k));
        const valid = validateManifest(rawMeta);

        let base: PhotoManifest;
        if (valid) {
          base = valid;
        } else if (isBlockMarker(rawMeta)) {
          tx.abort();
          reject(new BlockedError(rawMeta.reason));
          return;
        } else if (rawMeta === undefined || rawMeta === null) {
          if (blobKeys.length > 0) {
            // 来源不明：绝不允许空清单提交，更不能让它随后清扫字节
            tx.abort();
            reject(new BlockedError('存在没有清单归属的照片字节，已停止写入并保留现场'));
            return;
          }
          base = emptyManifest();
        } else {
          tx.abort();
          reject(new BlockedError('照片清单记录已损坏，照片字节原样保留，停止写入'));
          return;
        }

        let plan: ReturnType<typeof mutate>;
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
        for (const item of plan.putBlobs ?? []) blobStore.put(item.blob, item.hash);
        for (const hash of plan.deleteBlobs ?? []) blobStore.delete(hash);
        metaStore.put(next, META_KEY);
        committed = next;
      };
      keysReq.onerror = () => reject(keysReq.error);
    };
    metaReq.onerror = () => reject(metaReq.error);
    tx.oncomplete = () => {
      signalOtherTabs();
      resolve(committed ?? emptyManifest());
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => {
      if (tx.error) reject(tx.error);
      // abort 由上面的保护检查触发时错误已通过 reject 抛出
    };
  });
}

/**
 * 把可读的旧清单迁入 meta（升级漏迁或运行时检测到 legacy-readable 时）。
 * 已有合法清单则原样返回；存在阻断标记时拒绝（须走 recoverFromLegacy）。
 */
export async function migrateLegacyIntoMeta(): Promise<PhotoManifest> {
  const legacy = readLegacy();
  if (!legacy.manifest) throw new BlockedError('旧照片清单无法读取，已保留现场');
  const incoming = legacy.manifest;

  const db = await openDb();
  const next: PhotoManifest = await new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    const metaStore = tx.objectStore(META_STORE);
    const getReq = metaStore.get(META_KEY);
    getReq.onsuccess = () => {
      const existing = getReq.result;
      const alreadyValid = validateManifest(existing);
      if (alreadyValid) {
        resolve(alreadyValid);
        return;
      }
      if (isBlockMarker(existing)) {
        // 已有保护标记：不自动覆盖，需显式 recoverFromLegacy
        tx.abort();
        reject(new BlockedError(existing.reason));
        return;
      }
      const candidate = { photos: incoming.photos, links: incoming.links, revision: 0 };
      metaStore.put(candidate, META_KEY);
      tx.oncomplete = () => {
        signalOtherTabs();
        resolve(candidate);
      };
    };
    getReq.onerror = () => reject(getReq.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => {
      if (tx.error) reject(tx.error);
    };
  });

  try {
    localStorage.removeItem(LEGACY_MANIFEST_KEY);
  } catch {
    /* ignore */
  }
  return next;
}

/**
 * 保护态恢复：重新读取旧清单；只有当旧键此刻可解析为合法清单时，
 * 才用它替换阻断标记。旧键仍不可读则继续保留现场，绝不清除任何字节。
 */
export async function recoverFromLegacy(): Promise<PhotoManifest> {
  const legacy = readLegacy();
  if (!legacy.manifest) throw new BlockedError('旧照片清单仍无法读取，继续保留现场');

  // 旧键此刻可解析为合法清单：替换阻断标记；字节一个都不删
  const next = await lowLevelReplaceMeta(legacy.manifest);
  try {
    localStorage.removeItem(LEGACY_MANIFEST_KEY);
  } catch {
    /* ignore */
  }
  return next;
}

async function lowLevelReplaceMeta(incoming: PhotoManifest): Promise<PhotoManifest> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readwrite');
    const next = { photos: incoming.photos, links: incoming.links, revision: 0 };
    tx.objectStore(META_STORE).put(next, META_KEY);
    tx.oncomplete = () => {
      signalOtherTabs();
      resolve(next);
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('恢复事务中止'));
  });
}

function signalOtherTabs() {
  try {
    localStorage.setItem(SIGNAL_KEY, String(Date.now()));
  } catch {
    /* ignore */
  }
}

/** 其它标签页提交后通知本页重新判定 */
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

export interface ReconcileResult {
  deleted: number;
  blocked: boolean;
}

/**
 * 孤儿回收：仅当存在合法清单时，删除清单中不存在的 blob。
 * 保护态 / 空库 / 来源不明：一个字节都不删。
 */
export async function reconcileBlobs(): Promise<ReconcileResult> {
  const provenance = await getProvenance();
  if (provenance.status !== 'ready') {
    return { deleted: 0, blocked: provenance.status === 'blocked' };
  }
  const referenced = new Set(Object.keys(provenance.manifest.photos));

  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, BLOB_STORE], 'readwrite');
    const blobStore = tx.objectStore(BLOB_STORE);
    const keysReq = blobStore.getAllKeys();
    keysReq.onsuccess = () => {
      const orphans = keysReq.result.map((k) => String(k)).filter((k) => !referenced.has(k));
      for (const hash of orphans) blobStore.delete(hash);
      if (orphans.length > 0) signalOtherTabs();
      tx.oncomplete = () => resolve({ deleted: orphans.length, blocked: false });
    };
    keysReq.onerror = () => reject(keysReq.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('照片回收事务中止'));
  });
}

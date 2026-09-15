import { create } from 'zustand';
import {
  initPhotoDb,
  getProvenance,
  commitManifest,
  migrateLegacyIntoMeta,
  recoverFromLegacy,
  subscribePhotoChanges,
  reconcileBlobs,
  estimateAvailableBytes,
  hashBlob,
  QuotaError,
  BlockedError,
} from '@/utils/photoStorage';
import type { PhotoManifest, BenchPhotoLink } from '@/utils/photoStorage';

export interface AddPhotosResult {
  ok: boolean;
  error?: string;
  addedCount: number;
  reusedCount: number;
}

type PhotoStatus = 'loading' | 'ready' | 'empty' | 'blocked';

interface HashedFile {
  file: File;
  hash: string;
}

interface PhotoState {
  manifest: PhotoManifest;
  initialized: boolean;
  status: PhotoStatus;
  /** 保护态原因（status === 'blocked' 时有值） */
  blockReason: string | null;
  initialize: () => void;
  /** 保护态下用户确认旧数据已修好后重试恢复；失败继续保留现场 */
  attemptRecovery: () => Promise<boolean>;
  addPhotos: (benchId: string, files: File[]) => Promise<AddPhotosResult>;
  removePhoto: (benchId: string, hash: string) => Promise<void>;
  reorderPhotos: (benchId: string, orderedHashes: string[]) => Promise<void>;
  setCover: (benchId: string, hash: string) => Promise<void>;
  releaseBenchPhotos: (benchId: string) => Promise<void>;
  getBenchPhotos: (benchId: string) => BenchPhotoLink[];
  getCoverHash: (benchId: string) => string | undefined;
}

const EMPTY_MANIFEST: PhotoManifest = { photos: {}, links: {}, revision: 0 };

export const usePhotoStore = create<PhotoState>((set, get) => {
  /** 根据来源状态装载内存；来源未证实时不装载空清单、不动字节 */
  const probe = async (): Promise<PhotoStatus> => {
    const provenance = await getProvenance();
    if (provenance.status === 'ready') {
      // 合法清单就位：可以安全回收孤儿
      reconcileBlobs().catch((e) => console.warn('照片回收跳过：', e));
      set({
        manifest: provenance.manifest,
        status: 'ready',
        blockReason: null,
      });
      return 'ready';
    }
    if (provenance.status === 'legacy-readable') {
      // 旧清单可读但尚未迁入：安全迁入（只在确认无阻断标记时生效）
      try {
        const manifest = await migrateLegacyIntoMeta();
        set({ manifest, status: 'ready', blockReason: null });
        return 'ready';
      } catch (error) {
        if (error instanceof BlockedError) {
          set({ status: 'blocked', blockReason: error.reason });
          return 'blocked';
        }
        throw error;
      }
    }
    if (provenance.status === 'empty') {
      set({ manifest: EMPTY_MANIFEST, status: 'empty', blockReason: null });
      return 'empty';
    }
    // blocked：保留现场，不装载空清单（内存仍为空，但 UI 依据 status 禁写并提示）
    set({ status: 'blocked', blockReason: provenance.reason });
    return 'blocked';
  };

  const guardWritable = (): void => {
    const { status, blockReason } = get();
    if (status === 'loading') {
      throw new Error('照片库尚在初始化');
    }
    if (status === 'blocked') {
      throw new BlockedError(blockReason ?? '来源不可用');
    }
  };

  return {
    manifest: EMPTY_MANIFEST,
    initialized: false,
    status: 'loading',
    blockReason: null,

    initialize: () => {
      if (get().initialized) return;
      set({ initialized: true });

      initPhotoDb()
        .then(() => probe())
        .then(() => {
          subscribePhotoChanges(() => {
            // 其它标签页提交后按权威来源重新装载（保护态也可能被对方解除）
            void probe().catch((e) => console.error('照片库跨标签页同步失败：', e));
          });
        })
        .catch((error) => {
          console.error('照片库初始化失败，照片以占位显示：', error);
          set({
            status: 'blocked',
            blockReason:
              error instanceof Error
                ? `照片库无法打开：${error.message}。照片字节未被改动。`
                : '照片库无法打开，照片字节未被改动。',
          });
        });
    },

    attemptRecovery: async () => {
      try {
        const manifest = await recoverFromLegacy();
        reconcileBlobs().catch((e) => console.warn('照片回收跳过：', e));
        set({ manifest, status: 'ready', blockReason: null });
        return true;
      } catch (error) {
        // 旧数据仍不可读：继续保留现场
        const reason =
          error instanceof BlockedError
            ? error.reason
            : error instanceof Error
              ? error.message
              : '恢复失败，继续保留现场';
        set({ status: 'blocked', blockReason: reason });
        return false;
      }
    },

    addPhotos: async (benchId, files) => {
      if (files.length === 0) {
        return { ok: false, error: '没有选择照片', addedCount: 0, reusedCount: 0 };
      }
      guardWritable();

      const invalid = files.find((f) => !f.type.startsWith('image/'));
      if (invalid) {
        return {
          ok: false,
          error: `“${invalid.name}”不是图片文件，已取消整批上传`,
          addedCount: 0,
          reusedCount: 0,
        };
      }

      const hashed: HashedFile[] = [];
      for (const file of files) {
        try {
          hashed.push({ file, hash: await hashBlob(file) });
        } catch (error) {
          console.error('照片读取失败：', error);
          return {
            ok: false,
            error: `“${file.name}”读取失败，已取消整批上传`,
            addedCount: 0,
            reusedCount: 0,
          };
        }
      }

      // 建议性配额预检；权威判重在事务内
      const snapshot = get().manifest;
      const knownHashes = new Set([
        ...Object.keys(snapshot.photos),
        ...(snapshot.links[benchId] ?? []).map((l) => l.hash),
      ]);
      const requiredBytes = hashed
        .filter((h) => !knownHashes.has(h.hash))
        .reduce((sum, h) => sum + h.file.size, 0);
      if (requiredBytes > 0) {
        const available = await estimateAvailableBytes();
        if (available !== null && requiredBytes > available) {
          throw new QuotaError(requiredBytes, available);
        }
      }

      const stats = { addedLinks: 0, reusedStorage: 0, duplicatePicks: 0, requiredInTx: 0 };
      let next: PhotoManifest;
      try {
        next = await commitManifest((base) => {
          const existingLinks = base.links[benchId] ?? [];
          const existingHashes = new Set(existingLinks.map((l) => l.hash));

          const photos = { ...base.photos };
          const appended: BenchPhotoLink[] = [];
          const putBlobs: { hash: string; blob: Blob }[] = [];
          const seen = new Set<string>();

          for (const { file, hash } of hashed) {
            if (existingHashes.has(hash) || seen.has(hash)) {
              stats.duplicatePicks += 1;
              continue;
            }
            seen.add(hash);
            appended.push({ hash, name: file.name });

            if (photos[hash]) {
              stats.reusedStorage += 1;
              if (!photos[hash].refs.includes(benchId)) {
                photos[hash] = { ...photos[hash], refs: [...photos[hash].refs, benchId] };
              }
            } else {
              photos[hash] = { hash, type: file.type, size: file.size, refs: [benchId] };
              putBlobs.push({ hash, blob: file });
              stats.requiredInTx += file.size;
            }
          }
          stats.addedLinks = appended.length;

          return {
            manifest: {
              photos,
              links: { ...base.links, [benchId]: [...existingLinks, ...appended] },
            },
            putBlobs,
          };
        });
      } catch (error) {
        if (error instanceof QuotaError) throw error;
        if (error instanceof BlockedError) {
          set({ status: 'blocked', blockReason: error.reason });
          return {
            ok: false,
            error: `照片库处于保护态：${error.reason}`,
            addedCount: 0,
            reusedCount: 0,
          };
        }
        console.error('照片事务提交失败，已回滚：', error);
        const available = await estimateAvailableBytes();
        if (available !== null && stats.requiredInTx > available) {
          throw new QuotaError(stats.requiredInTx, available);
        }
        return {
          ok: false,
          error: '照片保存失败，整批上传已取消，已有照片不受影响',
          addedCount: 0,
          reusedCount: 0,
        };
      }

      set({ manifest: next, status: 'ready' });
      return {
        ok: true,
        addedCount: stats.addedLinks,
        reusedCount: stats.reusedStorage + stats.duplicatePicks,
      };
    },

    removePhoto: async (benchId, hash) => {
      guardWritable();
      const next = await commitManifest((base) => {
        const links = base.links[benchId];
        if (!links?.some((l) => l.hash === hash)) {
          return { manifest: { photos: base.photos, links: base.links } };
        }

        const nextLinks = links.filter((l) => l.hash !== hash);
        const linksMap = { ...base.links };
        if (nextLinks.length === 0) delete linksMap[benchId];
        else linksMap[benchId] = nextLinks;

        const photos = { ...base.photos };
        let gcHash: string | null = null;
        const meta = photos[hash];
        if (meta) {
          const refs = meta.refs.filter((r) => r !== benchId);
          if (refs.length === 0) {
            delete photos[hash];
            gcHash = hash;
          } else {
            photos[hash] = { ...meta, refs };
          }
        }

        return {
          manifest: { photos, links: linksMap },
          deleteBlobs: gcHash ? [gcHash] : undefined,
        };
      });
      set({ manifest: next });
    },

    reorderPhotos: async (benchId, orderedHashes) => {
      guardWritable();
      const next = await commitManifest((base) => {
        const links = base.links[benchId];
        if (!links) return { manifest: { photos: base.photos, links: base.links } };
        const byHash = new Map(links.map((l) => [l.hash, l]));
        const reordered = orderedHashes
          .map((h) => byHash.get(h))
          .filter((l): l is BenchPhotoLink => Boolean(l));
        if (reordered.length !== links.length) {
          return { manifest: { photos: base.photos, links: base.links } };
        }
        return {
          manifest: { photos: base.photos, links: { ...base.links, [benchId]: reordered } },
        };
      });
      set({ manifest: next });
    },

    setCover: async (benchId, hash) => {
      guardWritable();
      const next = await commitManifest((base) => {
        const links = base.links[benchId];
        if (!links?.some((l) => l.hash === hash)) {
          return { manifest: { photos: base.photos, links: base.links } };
        }
        const target = links.find((l) => l.hash === hash)!;
        const reordered = [target, ...links.filter((l) => l.hash !== hash)];
        return {
          manifest: { photos: base.photos, links: { ...base.links, [benchId]: reordered } },
        };
      });
      set({ manifest: next });
    },

    releaseBenchPhotos: async (benchId) => {
      // 保护态下不做任何改动（长椅档案仍可正常删除）
      if (get().status === 'blocked') return;
      if (get().status === 'loading') return;
      const next = await commitManifest((base) => {
        const links = base.links[benchId];
        if (!links) return { manifest: { photos: base.photos, links: base.links } };

        const linksMap = { ...base.links };
        delete linksMap[benchId];

        const photos = { ...base.photos };
        const gcHashes: string[] = [];
        for (const link of links) {
          const meta = photos[link.hash];
          if (!meta) continue;
          const refs = meta.refs.filter((r) => r !== benchId);
          if (refs.length === 0) {
            delete photos[link.hash];
            gcHashes.push(link.hash);
          } else {
            photos[link.hash] = { ...meta, refs };
          }
        }

        return {
          manifest: { photos, links: linksMap },
          deleteBlobs: gcHashes.length > 0 ? gcHashes : undefined,
        };
      });
      set({ manifest: next });
    },

    getBenchPhotos: (benchId) => get().manifest.links[benchId] ?? [],
    getCoverHash: (benchId) => get().manifest.links[benchId]?.[0]?.hash,
  };
});

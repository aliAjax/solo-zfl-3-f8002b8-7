import { create } from 'zustand';
import {
  initPhotoDb,
  readManifest,
  commitManifest,
  subscribePhotoChanges,
  reconcileBlobs,
  estimateAvailableBytes,
  hashBlob,
  QuotaError,
} from '@/utils/photoStorage';
import type { PhotoManifest, BenchPhotoLink } from '@/utils/photoStorage';

export interface AddPhotosResult {
  ok: boolean;
  error?: string;
  addedCount: number;
  reusedCount: number;
}

interface HashedFile {
  file: File;
  hash: string;
}

interface PhotoState {
  manifest: PhotoManifest;
  initialized: boolean;
  /** 数据库/清单不可用时为 true：可浏览（占位），禁止写入 */
  manifestCorrupt: boolean;
  initialize: () => void;
  /**
   * 为一张长椅批量添加照片。
   * 哈希与预检在事务外完成；最终去重、引用计数、blob 写入与清单更新
   * 在一个跨标签页串行的 IDB 事务内原子提交。
   * 任一步失败整体回滚，不留下断链；两个标签页同时上传不会互相覆盖。
   */
  addPhotos: (benchId: string, files: File[]) => Promise<AddPhotosResult>;
  /** 从长椅移除一张照片；该照片引用归零时同一事务内清走 blob */
  removePhoto: (benchId: string, hash: string) => Promise<void>;
  /** 调整某张长椅内照片顺序 */
  reorderPhotos: (benchId: string, orderedHashes: string[]) => Promise<void>;
  /** 把某张照片设为封面（移到第一位） */
  setCover: (benchId: string, hash: string) => Promise<void>;
  /** 删除长椅时调用：释放其全部照片引用并 GC */
  releaseBenchPhotos: (benchId: string) => Promise<void>;
  getBenchPhotos: (benchId: string) => BenchPhotoLink[];
  getCoverHash: (benchId: string) => string | undefined;
}

const EMPTY_MANIFEST: PhotoManifest = { photos: {}, links: {}, revision: 0 };

export const usePhotoStore = create<PhotoState>((set, get) => {
  /** 把数据库的最新清单同步进内存（跨标签页改动后调用） */
  const refresh = async () => {
    try {
      const manifest = await readManifest();
      set({ manifest, manifestCorrupt: false });
    } catch (error) {
      console.error('照片清单刷新失败：', error);
    }
  };

  /** 跨标签页的并发安全：仅当新清单修订号更新时才覆盖内存 */
  const refreshIfNewer = async () => {
    try {
      const latest = await readManifest();
      if (latest.revision > get().manifest.revision) {
        set({ manifest: latest, manifestCorrupt: false });
      }
    } catch (error) {
      console.error('照片清单跨标签页同步失败：', error);
    }
  };

  return {
    manifest: EMPTY_MANIFEST,
    initialized: false,
    manifestCorrupt: false,

    initialize: () => {
      if (get().initialized) return;
      // 先标记，避免 StrictMode / 多入口重复初始化
      set({ initialized: true });

      initPhotoDb()
        .then(async () => {
          // 后台对账：清掉无引用孤儿 blob（与清单同库串行，不会误删在途上传）
          reconcileBlobs().catch((e) => console.warn('照片对账跳过：', e));
          await refresh();
          // 订阅其它标签页的提交
          subscribePhotoChanges(() => {
            void refreshIfNewer();
          });
        })
        .catch((error) => {
          console.error('照片库初始化失败，照片以占位显示：', error);
          set({ manifestCorrupt: true });
        });
    },

    addPhotos: async (benchId, files) => {
      if (files.length === 0) {
        return { ok: false, error: '没有选择照片', addedCount: 0, reusedCount: 0 };
      }
      if (get().manifestCorrupt) {
        return {
          ok: false,
          error: '照片库当前不可用，已禁止写入，已有内容不受影响',
          addedCount: 0,
          reusedCount: 0,
        };
      }

      // 1. 类型校验：任一非图片，整批拒绝
      const invalid = files.find((f) => !f.type.startsWith('image/'));
      if (invalid) {
        return {
          ok: false,
          error: `“${invalid.name}”不是图片文件，已取消整批上传`,
          addedCount: 0,
          reusedCount: 0,
        };
      }

      // 2. 哈希（只读，不改数据）
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

      // 3. 建议性配额预检（以已知清单估算真正要新写的字节；
      //    权威判定在事务内；预检仅用于尽早、明确地拒绝）
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

      // 4. 事务内权威提交。闭包回传统计结果。
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
          let txRequired = 0;

          for (const { file, hash } of hashed) {
            if (existingHashes.has(hash) || seen.has(hash)) {
              stats.duplicatePicks += 1;
              continue;
            }
            seen.add(hash);
            appended.push({ hash, name: file.name });

            if (photos[hash]) {
              // 内容已存在（可能正是另一个标签页刚提交的）：共用这份存储
              stats.reusedStorage += 1;
              if (!photos[hash].refs.includes(benchId)) {
                photos[hash] = { ...photos[hash], refs: [...photos[hash].refs, benchId] };
              }
            } else {
              photos[hash] = { hash, type: file.type, size: file.size, refs: [benchId] };
              putBlobs.push({ hash, blob: file });
              txRequired += file.size;
            }
          }
          stats.addedLinks = appended.length;
          stats.requiredInTx = txRequired;

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
        console.error('照片事务提交失败，已回滚：', error);
        // 可能是预检后空间被占用：给出明确的空间类提示
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

      set({ manifest: next, manifestCorrupt: false });
      return {
        ok: true,
        addedCount: stats.addedLinks,
        reusedCount: stats.reusedStorage + stats.duplicatePicks,
      };
    },

    removePhoto: async (benchId, hash) => {
      if (get().manifestCorrupt) throw new Error('照片库当前不可用，已禁止改动');
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
      if (get().manifestCorrupt) throw new Error('照片库当前不可用，已禁止改动');
      const next = await commitManifest((base) => {
        const links = base.links[benchId];
        if (!links) return { manifest: { photos: base.photos, links: base.links } };
        const byHash = new Map(links.map((l) => [l.hash, l]));
        const reordered = orderedHashes
          .map((h) => byHash.get(h))
          .filter((l): l is BenchPhotoLink => Boolean(l));
        // 只允许重排、不允许增删；集合不一致则放弃本次改动
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
      if (get().manifestCorrupt) throw new Error('照片库当前不可用，已禁止改动');
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
      if (get().manifestCorrupt) return;
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

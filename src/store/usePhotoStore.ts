import { create } from 'zustand';
import {
  loadManifest,
  saveManifest,
  hashBlob,
  putPhotoBlobs,
  deletePhotoBlobs,
  listAllBlobKeys,
  estimateAvailableBytes,
  QuotaError,
} from '@/utils/photoStorage';
import type { PhotoManifest, BenchPhotoLink } from '@/utils/photoStorage';

export interface AddPhotosResult {
  ok: boolean;
  error?: string;
  addedCount: number;
  reusedCount: number;
}

interface PhotoState {
  manifest: PhotoManifest;
  initialized: boolean;
  /** 清单损坏时为 true：可读、可上传，但不再自动写回以免覆盖残留数据 */
  manifestCorrupt: boolean;
  initialize: () => void;
  /** 删除 IDB 中清单已无引用的孤儿 blob */
  reconcileBlobs: () => Promise<void>;
  /**
   * 为一张长椅批量添加照片。
   * 先完成校验 / 哈希去重 / 配额预检，再在一个事务里写 blob，最后更新清单；
   * 任一步失败全部回滚，不留下断链。
   */
  addPhotos: (benchId: string, files: File[]) => Promise<AddPhotosResult>;
  /** 从长椅移除一张照片；该照片引用归零时连 blob 一起清走 */
  removePhoto: (benchId: string, hash: string) => Promise<void>;
  /** 调整某张长椅内照片顺序 */
  reorderPhotos: (benchId: string, orderedHashes: string[]) => void;
  /** 把某张照片设为封面（移到第一位） */
  setCover: (benchId: string, hash: string) => void;
  /** 删除长椅时调用：释放其全部照片引用并 GC */
  releaseBenchPhotos: (benchId: string) => Promise<void>;
  getBenchPhotos: (benchId: string) => BenchPhotoLink[];
  getCoverHash: (benchId: string) => string | undefined;
}

export const usePhotoStore = create<PhotoState>((set, get) => ({
  manifest: { photos: {}, links: {}, version: 1 },
  initialized: false,
  manifestCorrupt: false,

  initialize: () => {
    if (get().initialized) return;
    try {
      const manifest = loadManifest();
      set({ manifest, initialized: true, manifestCorrupt: false });
      // 后台对账：清掉清单中已不存在引用的孤儿 blob（上次 GC 事务失败的残留）
      void get().reconcileBlobs();
    } catch (error) {
      // 清单损坏：用空清单继续提供只读浏览，绝不写回，避免覆盖残留数据
      console.error('照片清单损坏，照片暂不可用：', error);
      set({
        manifest: { photos: {}, links: {}, version: 1 },
        initialized: true,
        manifestCorrupt: true,
      });
    }
  },

  reconcileBlobs: async () => {
    try {
      const keys = await listAllBlobKeys();
      const referenced = new Set(Object.keys(get().manifest.photos));
      const orphans = keys.filter((key) => !referenced.has(key));
      if (orphans.length > 0) {
        await deletePhotoBlobs(orphans);
      }
    } catch (error) {
      // 对账失败不影响使用，下次启动再试
      console.warn('照片存储对账失败，已跳过：', error);
    }
  },

  addPhotos: async (benchId, files) => {
    if (files.length === 0) {
      return { ok: false, error: '没有选择照片', addedCount: 0, reusedCount: 0 };
    }
    if (get().manifestCorrupt) {
      return {
        ok: false,
        error: '照片清单已损坏，为避免覆盖数据已禁止写入。请刷新页面；若仍失败，需清空照片存储后重试。',
        addedCount: 0,
        reusedCount: 0,
      };
    }

    // 1. 类型校验：任何一个不是图片，整批拒绝（互不影响已有内容）
    const invalid = files.find((f) => !f.type.startsWith('image/'));
    if (invalid) {
      return {
        ok: false,
        error: `“${invalid.name}”不是图片文件，已取消整批上传`,
        addedCount: 0,
        reusedCount: 0,
      };
    }

    // 2. 哈希（计算本身不改任何数据）
    const hashed: { file: File; hash: string }[] = [];
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

    const manifest = get().manifest;
    const existingLinks = manifest.links[benchId] ?? [];
    const existingHashes = new Set(existingLinks.map((l) => l.hash));

    // 3. 批内去重 + 与该长椅已有引用去重
    const seen = new Set<string>();
    const uniqueNew: { file: File; hash: string }[] = [];
    let duplicatePicks = 0;
    let reusedStorage = 0;
    for (const item of hashed) {
      if (existingHashes.has(item.hash)) {
        // 该长椅已经挂着同样内容
        duplicatePicks += 1;
        continue;
      }
      if (seen.has(item.hash)) {
        // 本批次里重复选择
        duplicatePicks += 1;
        continue;
      }
      seen.add(item.hash);
      if (manifest.photos[item.hash]) {
        // 其它长椅已存有同样内容：共用这份存储，不再写 blob
        reusedStorage += 1;
      } else {
        uniqueNew.push(item);
      }
    }
    const addedLinks = seen.size;

    // 4. 配额预检：只统计真正需要新写入的字节
    const requiredBytes = uniqueNew.reduce((sum, item) => sum + item.file.size, 0);
    if (requiredBytes > 0) {
      const available = await estimateAvailableBytes();
      if (available !== null && requiredBytes > available) {
        throw new QuotaError(requiredBytes, available);
      }
    }

    // 5. 一个 IndexedDB 事务写全部新 blob；失败则整体中止，清单不动
    try {
      await putPhotoBlobs(uniqueNew.map(({ file, hash }) => ({ hash, blob: file })));
    } catch (error) {
      console.error('照片写入失败，整批回滚：', error);
      const available = await estimateAvailableBytes();
      if (available !== null && requiredBytes > available) {
        throw new QuotaError(requiredBytes, available);
      }
      return {
        ok: false,
        error: '照片写入失败，已取消整批上传，已有照片不受影响',
        addedCount: 0,
        reusedCount: 0,
      };
    }

    // 全部是该长椅已挂过的照片：没有任何新引用，无需改动清单
    if (addedLinks === 0) {
      return {
        ok: true,
        addedCount: 0,
        reusedCount: duplicatePicks,
      };
    }

    // 6. blob 落盘成功后才更新清单（引用）；manifest 极小，localStorage 失败视为整体失败
    const nextManifest: PhotoManifest = {
      version: 1,
      photos: { ...manifest.photos },
      links: {
        ...manifest.links,
        [benchId]: [...existingLinks],
      },
    };

    for (const { file, hash } of uniqueNew) {
      nextManifest.photos[hash] = { hash, type: file.type, size: file.size, refs: [benchId] };
    }
    for (const hash of seen) {
      if (nextManifest.photos[hash] && !nextManifest.photos[hash].refs.includes(benchId)) {
        nextManifest.photos[hash] = {
          ...nextManifest.photos[hash],
          refs: [...nextManifest.photos[hash].refs, benchId],
        };
      }
    }
    for (const { file, hash } of hashed) {
      if (!existingHashes.has(hash) && !nextManifest.links[benchId].some((l) => l.hash === hash)) {
        nextManifest.links[benchId].push({ hash, name: file.name });
      }
    }

    try {
      saveManifest(nextManifest);
    } catch (error) {
      console.error('照片清单写入失败，回滚新写入的 blob：', error);
      await deletePhotoBlobs(uniqueNew.map(({ hash }) => hash)).catch(() => undefined);
      const available = await estimateAvailableBytes();
      if (available !== null) {
        throw new QuotaError(requiredBytes, available);
      }
      throw error;
    }

    set({ manifest: nextManifest });
    return { ok: true, addedCount: addedLinks, reusedCount: reusedStorage + duplicatePicks };
  },

  removePhoto: async (benchId, hash) => {
    if (get().manifestCorrupt) throw new Error('照片清单已损坏，已禁止改动');
    const manifest = get().manifest;
    const links = manifest.links[benchId];
    if (!links?.some((l) => l.hash === hash)) return;

    const nextLinks = links.filter((l) => l.hash !== hash);
    const nextManifest: PhotoManifest = {
      version: 1,
      photos: { ...manifest.photos },
      links: { ...manifest.links },
    };
    if (nextLinks.length === 0) {
      delete nextManifest.links[benchId];
    } else {
      nextManifest.links[benchId] = nextLinks;
    }

    // 引用计数减一
    const meta = nextManifest.photos[hash];
    let gcHash: string | null = null;
    if (meta) {
      const refs = meta.refs.filter((r) => r !== benchId);
      if (refs.length === 0) {
        delete nextManifest.photos[hash];
        gcHash = hash;
      } else {
        nextManifest.photos[hash] = { ...meta, refs };
      }
    }

    // 先持久化清单再 GC blob；即使 blob 删除失败也不会产生断链
    saveManifest(nextManifest);
    set({ manifest: nextManifest });
    if (gcHash) {
      await deletePhotoBlobs([gcHash]).catch((error) =>
        console.error('无引用照片清理失败（将在下次清理时重试）：', error),
      );
    }
  },

  reorderPhotos: (benchId, orderedHashes) => {
    if (get().manifestCorrupt) throw new Error('照片清单已损坏，已禁止改动');
    const manifest = get().manifest;
    const links = manifest.links[benchId];
    if (!links) return;
    const byHash = new Map(links.map((l) => [l.hash, l]));
    const reordered = orderedHashes
      .map((hash) => byHash.get(hash))
      .filter((l): l is BenchPhotoLink => Boolean(l));
    // 保持集合一致，仅改顺序
    if (reordered.length !== links.length) return;

    const nextManifest: PhotoManifest = {
      ...manifest,
      links: { ...manifest.links, [benchId]: reordered },
    };
    saveManifest(nextManifest);
    set({ manifest: nextManifest });
  },

  setCover: (benchId, hash) => {
    if (get().manifestCorrupt) throw new Error('照片清单已损坏，已禁止改动');
    const manifest = get().manifest;
    const links = manifest.links[benchId];
    if (!links?.some((l) => l.hash === hash)) return;
    const target = links.find((l) => l.hash === hash)!;
    const reordered = [target, ...links.filter((l) => l.hash !== hash)];
    const nextManifest: PhotoManifest = {
      ...manifest,
      links: { ...manifest.links, [benchId]: reordered },
    };
    saveManifest(nextManifest);
    set({ manifest: nextManifest });
  },

  releaseBenchPhotos: async (benchId) => {
    if (get().manifestCorrupt) return;
    const manifest = get().manifest;
    const links = manifest.links[benchId];
    if (!links) return;

    const nextManifest: PhotoManifest = {
      version: 1,
      photos: { ...manifest.photos },
      links: { ...manifest.links },
    };
    delete nextManifest.links[benchId];

    const gcHashes: string[] = [];
    for (const link of links) {
      const meta = nextManifest.photos[link.hash];
      if (!meta) continue;
      const refs = meta.refs.filter((r) => r !== benchId);
      if (refs.length === 0) {
        delete nextManifest.photos[link.hash];
        gcHashes.push(link.hash);
      } else {
        nextManifest.photos[link.hash] = { ...meta, refs };
      }
    }

    saveManifest(nextManifest);
    set({ manifest: nextManifest });
    if (gcHashes.length > 0) {
      await deletePhotoBlobs(gcHashes).catch((error) =>
        console.error('删除长椅后照片清理失败：', error),
      );
    }
  },

  getBenchPhotos: (benchId) => get().manifest.links[benchId] ?? [],
  getCoverHash: (benchId) => get().manifest.links[benchId]?.[0]?.hash,
}));

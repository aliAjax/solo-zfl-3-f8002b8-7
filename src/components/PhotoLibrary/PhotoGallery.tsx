import { useRef, useState } from 'react';
import {
  ImagePlus,
  Trash2,
  Star,
  ChevronLeft,
  ChevronRight,
  X,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import { usePhotoStore } from '@/store/usePhotoStore';
import { QuotaError } from '@/utils/photoStorage';
import type { BenchPhotoLink } from '@/utils/photoStorage';
import PhotoImg from './PhotoImg';

const EMPTY_LINKS: BenchPhotoLink[] = [];

interface PhotoGalleryProps {
  benchId: string;
  /** 是否允许添加 / 移除 / 排序 / 设封面；详情页开放管理 */
  editable?: boolean;
}

export default function PhotoGallery({ benchId, editable = true }: PhotoGalleryProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lightboxHash, setLightboxHash] = useState<string | null>(null);

  // 订阅该长椅的引用变化（返回稳定引用，避免无照片时重复渲染）
  const photos = usePhotoStore((s) => s.manifest.links[benchId] ?? EMPTY_LINKS);
  const addPhotos = usePhotoStore((s) => s.addPhotos);
  const removePhoto = usePhotoStore((s) => s.removePhoto);
  const reorderPhotos = usePhotoStore((s) => s.reorderPhotos);
  const setCover = usePhotoStore((s) => s.setCover);

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    // 允许重复选择同一文件
    e.target.value = '';
    if (files.length === 0) return;

    setError(null);
    setNotice(null);
    setUploading(true);
    try {
      const result = await addPhotos(benchId, files);
      if (!result.ok) {
        setError(result.error ?? '上传失败');
      } else if (result.reusedCount > 0) {
        setNotice(`已添加 ${result.addedCount} 张，${result.reusedCount} 张相同照片复用了已有存储`);
      }
    } catch (err) {
      if (err instanceof QuotaError) {
        setError(`${err.message}，本次上传已全部取消，已有照片不受影响`);
      } else {
        console.error(err);
        setError('照片保存失败，本次上传已全部取消，已有照片不受影响');
      }
    } finally {
      setUploading(false);
    }
  };

  const handleRemove = async (hash: string) => {
    setError(null);
    try {
      await removePhoto(benchId, hash);
    } catch (err) {
      console.error(err);
      setError('移除失败：存储空间可能已满，照片未被改动');
    }
    if (lightboxHash === hash) setLightboxHash(null);
  };

  const move = (index: number, direction: -1 | 1) => {
    const next = index + direction;
    if (next < 0 || next >= photos.length) return;
    const hashes = photos.map((p) => p.hash);
    [hashes[index], hashes[next]] = [hashes[next], hashes[index]];
    try {
      reorderPhotos(benchId, hashes);
    } catch (err) {
      console.error(err);
      setError('排序保存失败：存储空间可能已满，顺序未被改动');
    }
  };

  const handleSetCover = (hash: string) => {
    try {
      setCover(benchId, hash);
    } catch (err) {
      console.error(err);
      setError('设置封面失败：存储空间可能已满，未被改动');
    }
  };

  const lightboxIndex = lightboxHash ? photos.findIndex((p) => p.hash === lightboxHash) : -1;
  const lightboxPhoto = lightboxIndex >= 0 ? photos[lightboxIndex] : null;

  return (
    <div className="paper-texture rounded-xl shadow-paper p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-serif text-lg font-semibold text-deep-brown">
          照片库
          {photos.length > 0 && (
            <span className="ml-2 text-sm font-normal text-ink-light">{photos.length} 张</span>
          )}
        </h2>
        {editable && (
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleFiles}
            />
            <button
              type="button"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-moss-green hover:bg-moss-green/10 rounded-lg transition-colors disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ImagePlus className="w-4 h-4" />
              )}
              {uploading ? '保存中...' : '添加照片'}
            </button>
          </>
        )}
      </div>

      {error && (
        <div className="mb-4 flex items-start gap-2 px-3 py-2.5 bg-red-50 border border-red-200/60 rounded-lg text-sm text-red-600">
          <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {notice && !error && (
        <div className="mb-4 px-3 py-2.5 bg-moss-green/5 border border-moss-green/20 rounded-lg text-sm text-moss-green">
          {notice}
        </div>
      )}

      {photos.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {photos.map((photo, index) => (
            <div
              key={photo.hash}
              className="group relative aspect-square rounded-lg overflow-hidden bg-warm-beige/40 border border-deep-brown/5"
            >
              <button
                type="button"
                onClick={() => setLightboxHash(photo.hash)}
                className="absolute inset-0 cursor-zoom-in"
                title={photo.name}
              >
                <PhotoImg
                  hash={photo.hash}
                  alt={photo.name}
                  mode="thumb"
                  className="w-full h-full object-cover"
                />
              </button>

              {index === 0 && (
                <span className="absolute top-1.5 left-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 bg-white/85 backdrop-blur-sm rounded-full text-[10px] font-medium text-ochre">
                  <Star className="w-3 h-3 fill-ochre" />
                  封面
                </span>
              )}

              {editable && (
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between px-1.5 py-1 bg-gradient-to-t from-black/55 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                      title="前移"
                      className="p-1 text-white/90 hover:text-white disabled:opacity-30"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      disabled={index === photos.length - 1}
                      onClick={() => move(index, 1)}
                      title="后移"
                      className="p-1 text-white/90 hover:text-white disabled:opacity-30"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex items-center gap-0.5">
                    {index !== 0 && (
                      <button
                        type="button"
                        onClick={() => handleSetCover(photo.hash)}
                        title="设为封面"
                        className="p-1 text-white/90 hover:text-ochre"
                      >
                        <Star className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRemove(photo.hash)}
                      title="移除"
                      className="p-1 text-white/90 hover:text-red-400"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center py-8">
          <div className="w-12 h-12 rounded-full bg-moss-green/10 flex items-center justify-center mx-auto mb-3">
            <ImagePlus className="w-6 h-6 text-moss-green/50" />
          </div>
          <p className="text-sm text-ink-light">还没有照片</p>
          <p className="text-xs text-ink-light/60 mt-1">
            相同内容的照片只存一份，多张长椅可以共用
          </p>
        </div>
      )}

      {lightboxPhoto && (
        <div
          className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4"
          onClick={() => setLightboxHash(null)}
        >
          <button
            type="button"
            className="absolute top-4 right-4 p-2 text-white/80 hover:text-white"
            onClick={() => setLightboxHash(null)}
          >
            <X className="w-6 h-6" />
          </button>
          <div className="max-w-4xl max-h-[85vh] flex flex-col items-center gap-3" onClick={(e) => e.stopPropagation()}>
            <PhotoImg
              hash={lightboxPhoto.hash}
              alt={lightboxPhoto.name}
              mode="full"
              className="max-w-full max-h-[75vh] object-contain rounded-lg shadow-2xl"
            />
            <div className="flex items-center gap-4 text-white/80 text-sm">
              <button
                type="button"
                disabled={lightboxIndex === 0}
                onClick={() => setLightboxHash(photos[lightboxIndex - 1].hash)}
                className="p-1 hover:text-white disabled:opacity-30"
              >
                <ChevronLeft className="w-5 h-5" />
              </button>
              <span className="truncate max-w-[60vw]">{lightboxPhoto.name}</span>
              <button
                type="button"
                disabled={lightboxIndex === photos.length - 1}
                onClick={() => setLightboxHash(photos[lightboxIndex + 1].hash)}
                className="p-1 hover:text-white disabled:opacity-30"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

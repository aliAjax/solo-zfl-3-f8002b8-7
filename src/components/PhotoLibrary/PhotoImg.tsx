import { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { getPhotoBlob } from '@/utils/photoStorage';

/** 会话级缩略图缓存：hash -> 缩略图 objectURL */
const thumbCache = new Map<string, string>();
const THUMB_MAX_SIZE = 320;

async function makeThumbnail(hash: string, blob: Blob): Promise<string> {
  const cached = thumbCache.get(hash);
  if (cached) return cached;

  const url = URL.createObjectURL(blob);
  try {
    const image = await loadImage(url);
    const scale = Math.min(1, THUMB_MAX_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
    if (scale >= 1) {
      thumbCache.set(hash, url);
      return url;
    }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      thumbCache.set(hash, url);
      return url;
    }
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const thumbBlob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, blob.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.82),
    );
    URL.revokeObjectURL(url);
    if (!thumbBlob) {
      const original = URL.createObjectURL(blob);
      thumbCache.set(hash, original);
      return original;
    }
    const thumbUrl = URL.createObjectURL(thumbBlob);
    thumbCache.set(hash, thumbUrl);
    return thumbUrl;
  } catch (error) {
    // 解码失败：文件损坏
    URL.revokeObjectURL(url);
    throw error;
  }
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('图片解码失败'));
    image.src = url;
  });
}

interface PhotoImgProps {
  hash: string;
  alt: string;
  /** thumb：列表/缩略图（canvas 缩放）；full：详情看原图 */
  mode?: 'thumb' | 'full';
  className?: string;
}

/**
 * 读取并渲染照片库中的一张照片。
 * 读取失败或内容损坏时显示占位，错误只影响这一张。
 */
export default function PhotoImg({ hash, alt, mode = 'thumb', className = '' }: PhotoImgProps) {
  const [src, setSrc] = useState<string | null>(null);
  const [broken, setBroken] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;

    setBroken(false);
    getPhotoBlob(hash)
      .then(async (blob) => {
        if (!blob) throw new Error('照片数据缺失');
        if (cancelled) return;
        if (mode === 'thumb') {
          return makeThumbnail(hash, blob);
        }
        objectUrl = URL.createObjectURL(blob);
        return objectUrl;
      })
      .then((url) => {
        if (cancelled) {
          if (url && !thumbCache.has(hash)) URL.revokeObjectURL(url);
          return;
        }
        if (url) setSrc(url);
        else setBroken(true);
      })
      .catch((error) => {
        console.error(`照片 ${hash} 读取失败：`, error);
        if (!cancelled) setBroken(true);
      });

    return () => {
      cancelled = true;
      // full 模式的 URL 由本组件创建并回收；缩略图 URL 缓存在会话中复用
      if (objectUrl && mode === 'full') URL.revokeObjectURL(objectUrl);
    };
  }, [hash, mode]);

  if (broken || !src) {
    return (
      <div
        className={`flex items-center justify-center bg-warm-beige/60 text-ink-light/50 ${className}`}
        title={broken ? '照片损坏或丢失' : '加载中'}
      >
        <ImageOff className="w-6 h-6" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setBroken(true)}
      className={className}
    />
  );
}

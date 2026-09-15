import { Search, X } from 'lucide-react';
import { useBenchStore } from '@/store/useBenchStore';
import { MATERIAL_LABELS, ORIENTATION_LABELS, SHADE_LABELS, NOISE_LABELS } from '@/types';
import type { MaterialType, OrientationType, ShadeLevelType, NoiseLevelType } from '@/types';

export default function FilterBar() {
  const {
    searchQuery,
    materialFilter,
    orientationFilter,
    shadeFilter,
    noiseFilter,
    setSearchQuery,
    setMaterialFilter,
    setOrientationFilter,
    setShadeFilter,
    setNoiseFilter,
    clearFilters,
    getFilteredBenches,
  } = useBenchStore();

  const hasFilters = searchQuery || materialFilter || orientationFilter || shadeFilter || noiseFilter;
  const filteredCount = getFilteredBenches().length;

  return (
    <div className="paper-texture rounded-xl shadow-paper p-4 mb-6">
      <div className="flex flex-col gap-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-light" />
          <input
            type="text"
            placeholder="搜索长椅名称、位置或评价..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2.5 bg-white/50 border border-deep-brown/10 rounded-lg text-deep-brown placeholder:text-ink-light/60 focus:bg-white transition-colors"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-light hover:text-deep-brown"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2">
            <select
              value={materialFilter || ''}
              onChange={(e) => setMaterialFilter(e.target.value as MaterialType || null)}
              className="px-3 py-1.5 text-sm bg-white/50 border border-deep-brown/10 rounded-lg text-deep-brown focus:bg-white cursor-pointer"
            >
              <option value="">全部材质</option>
              {Object.entries(MATERIAL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>

            <select
              value={shadeFilter || ''}
              onChange={(e) => setShadeFilter(e.target.value as ShadeLevelType || null)}
              className="px-3 py-1.5 text-sm bg-white/50 border border-deep-brown/10 rounded-lg text-deep-brown focus:bg-white cursor-pointer"
            >
              <option value="">全部遮阴</option>
              {Object.entries(SHADE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>

            <select
              value={noiseFilter || ''}
              onChange={(e) => setNoiseFilter(e.target.value as NoiseLevelType || null)}
              className="px-3 py-1.5 text-sm bg-white/50 border border-deep-brown/10 rounded-lg text-deep-brown focus:bg-white cursor-pointer"
            >
              <option value="">全部噪音</option>
              {Object.entries(NOISE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>

            <select
              value={orientationFilter || ''}
              onChange={(e) => setOrientationFilter(e.target.value as OrientationType || null)}
              className="px-3 py-1.5 text-sm bg-white/50 border border-deep-brown/10 rounded-lg text-deep-brown focus:bg-white cursor-pointer"
            >
              <option value="">全部朝向</option>
              {Object.entries(ORIENTATION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3 ml-auto">
            <span className="text-sm text-ink-light">
              共 <span className="font-medium text-deep-brown">{filteredCount}</span> 条记录
            </span>
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-ochre hover:text-ochre-light hover:bg-ochre/5 rounded-lg transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                清除筛选
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

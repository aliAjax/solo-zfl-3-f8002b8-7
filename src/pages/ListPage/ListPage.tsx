import { useEffect } from 'react';
import { useBenchStore } from '@/store/useBenchStore';
import FilterBar from '@/components/FilterBar/FilterBar';
import BenchCard from '@/components/BenchCard/BenchCard';
import { Armchair } from 'lucide-react';

export default function ListPage() {
  const { benches, getFilteredBenches, initialize, initialized } = useBenchStore();
  const filteredBenches = getFilteredBenches();

  useEffect(() => {
    if (!initialized) {
      initialize();
    }
  }, [initialized, initialize]);

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-6">
        <h2 className="font-serif text-2xl font-semibold text-deep-brown mb-1">
          长椅档案
        </h2>
        <p className="text-ink-light text-sm">
          记录城市中那些被忽略的休憩角落
        </p>
      </div>

      <FilterBar />

      {filteredBenches.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredBenches.map((bench, index) => (
            <BenchCard key={bench.id} bench={bench} index={index} />
          ))}
        </div>
      ) : (
        <div className="paper-texture rounded-xl shadow-paper p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-moss-green/10 flex items-center justify-center mx-auto mb-4">
            <Armchair className="w-8 h-8 text-moss-green/50" />
          </div>
          <h3 className="font-serif text-lg font-medium text-deep-brown mb-2">
            {benches.length === 0 ? '还没有长椅档案' : '没有找到匹配的长椅'}
          </h3>
          <p className="text-ink-light text-sm">
            {benches.length === 0
              ? '点击右上角的添加按钮，记录第一张长椅档案吧'
              : '试试调整筛选条件或搜索关键词'}
          </p>
        </div>
      )}
    </div>
  );
}

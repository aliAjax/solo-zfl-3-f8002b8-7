import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trophy, MapPin, Star, Crown, Medal, Award } from 'lucide-react';
import { useBenchStore } from '@/store/useBenchStore';
import { calculateComfortScore, getComfortLevel, getComfortColor } from '@/utils/comfort';
import { MATERIAL_LABELS, SHADE_LABELS } from '@/types';
import type { Bench } from '@/types';

export default function RankingPage() {
  const { benches, initialize, initialized } = useBenchStore();
  const navigate = useNavigate();

  useEffect(() => {
    if (!initialized) {
      initialize();
    }
  }, [initialized, initialize]);

  const rankedBenches = [...benches]
    .sort((a, b) => calculateComfortScore(b) - calculateComfortScore(a))
    .map((bench, index) => ({ bench, rank: index + 1 }));

  const getRankIcon = (rank: number) => {
    if (rank === 1) return <Crown className="w-5 h-5 text-yellow-500" />;
    if (rank === 2) return <Medal className="w-5 h-5 text-gray-400" />;
    if (rank === 3) return <Award className="w-5 h-5 text-amber-600" />;
    return <span className="text-base font-bold text-ink-light">{rank}</span>;
  };

  const getRankBg = (rank: number) => {
    if (rank === 1) return 'bg-gradient-to-r from-yellow-50/80 to-amber-50/80 border-yellow-200/50';
    if (rank === 2) return 'bg-gradient-to-r from-gray-50/80 to-slate-50/80 border-gray-200/50';
    if (rank === 3) return 'bg-gradient-to-r from-orange-50/80 to-amber-50/80 border-orange-200/50';
    return 'bg-white/50 border-deep-brown/5';
  };

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-6">
        <h2 className="font-serif text-2xl font-semibold text-deep-brown mb-1">
          舒适度排行
        </h2>
        <p className="text-ink-light text-sm">
          综合评分最高的长椅
        </p>
      </div>

      <div className="space-y-3">
        {rankedBenches.map(({ bench, rank }) => {
          const comfortScore = calculateComfortScore(bench);
          const comfortLevel = getComfortLevel(comfortScore);
          const comfortColor = getComfortColor(comfortScore);

          return (
            <div
              key={bench.id}
              onClick={() => navigate(`/bench/${bench.id}`)}
              className={`paper-texture rounded-xl shadow-paper p-4 border ${
                getRankBg(rank)
              } cursor-pointer card-hover fade-in opacity-0 stagger-${Math.min(rank, 6)}`}
            >
              <div className="flex items-center gap-4">
                <div className="w-12 h-12 rounded-xl bg-warm-beige flex items-center justify-center flex-shrink-0">
                  {getRankIcon(rank)}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <h3 className="font-serif font-semibold text-deep-brown truncate">
                      {bench.name}
                    </h3>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${comfortColor} bg-white/80`}>
                      {comfortLevel}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 text-ink-light text-sm mb-2">
                    <MapPin className="w-3.5 h-3.5 flex-shrink-0" />
                    <span className="truncate">{bench.location}</span>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <span className="text-xs text-ink-light px-2 py-0.5 bg-white/60 rounded">
                      {MATERIAL_LABELS[bench.material]}
                    </span>
                    <span className="text-xs text-ink-light px-2 py-0.5 bg-white/60 rounded">
                      {SHADE_LABELS[bench.shadeLevel]}
                    </span>
                    <div className="flex items-center gap-1 text-xs text-ink-light px-2 py-0.5 bg-white/60 rounded">
                      <Star className="w-3 h-3 fill-ochre text-ochre" />
                      <span>{bench.rating.toFixed(1)}</span>
                    </div>
                  </div>
                </div>

                <div className="text-right flex-shrink-0">
                  <div className={`text-2xl font-bold font-serif ${comfortColor}`}>
                    {comfortScore}
                  </div>
                  <div className="text-xs text-ink-light">
                    舒适度
                  </div>
                </div>
              </div>

              <div className="mt-3 pl-16">
                <div className="h-2 bg-warm-beige rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-700 ${
                      comfortScore >= 4 ? 'bg-moss-green' :
                      comfortScore >= 3 ? 'bg-ochre' :
                      'bg-ink-light'
                    }`}
                    style={{ width: `${(comfortScore / 5) * 100}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {rankedBenches.length === 0 && (
        <div className="paper-texture rounded-xl shadow-paper p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-moss-green/10 flex items-center justify-center mx-auto mb-4">
            <Trophy className="w-8 h-8 text-moss-green/50" />
          </div>
          <h3 className="font-serif text-lg font-medium text-deep-brown mb-2">
            还没有排行数据
          </h3>
          <p className="text-ink-light text-sm">
            添加一些长椅档案后，这里会显示舒适度排行榜
          </p>
        </div>
      )}
    </div>
  );
}

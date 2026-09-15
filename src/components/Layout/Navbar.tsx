import { useLocation, useNavigate } from 'react-router-dom';
import { MapPin, List, Trophy, Plus, TreeDeciduous } from 'lucide-react';

export default function Navbar() {
  const location = useLocation();
  const navigate = useNavigate();

  const navItems = [
    { path: '/', icon: List, label: '列表' },
    { path: '/map', icon: MapPin, label: '地图' },
    { path: '/ranking', icon: Trophy, label: '排行' },
  ];

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/';
    return location.pathname.startsWith(path);
  };

  return (
    <header className="sticky top-0 z-50 bg-warm-beige/90 backdrop-blur-sm border-b border-deep-brown/10">
      <div className="container mx-auto px-4 py-3">
        <div className="flex items-center justify-between">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-2 group"
          >
            <div className="w-10 h-10 rounded-xl bg-moss-green/10 flex items-center justify-center group-hover:bg-moss-green/20 transition-colors">
              <TreeDeciduous className="w-5 h-5 text-moss-green" />
            </div>
            <div>
              <h1 className="font-serif text-lg font-semibold text-deep-brown leading-tight">
                长椅观察
              </h1>
              <p className="text-xs text-ink-light">城市休憩档案</p>
            </div>
          </button>

          <nav className="flex items-center gap-1">
            {navItems.map((item) => (
              <button
                key={item.path}
                onClick={() => navigate(item.path)}
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  isActive(item.path)
                    ? 'bg-moss-green text-white shadow-md'
                    : 'text-ink-light hover:bg-deep-brown/5 hover:text-deep-brown'
                }`}
              >
                <item.icon className="w-4 h-4" />
                <span className="hidden sm:inline">{item.label}</span>
              </button>
            ))}
          </nav>

          <button
            onClick={() => navigate('/add')}
            className="flex items-center gap-1.5 px-4 py-2 bg-ochre text-white rounded-lg font-medium text-sm hover:bg-ochre-light transition-colors shadow-md hover:shadow-lg"
          >
            <Plus className="w-4 h-4" />
            <span className="hidden sm:inline">添加长椅</span>
          </button>
        </div>
      </div>
    </header>
  );
}

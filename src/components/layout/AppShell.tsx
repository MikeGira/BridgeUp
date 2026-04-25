import { useLocation } from 'wouter';
import { Map, Heart, Users, User, BarChart2 } from 'lucide-react';
import { useAuthStore } from '@/store/auth';

interface AppShellProps {
  children: React.ReactNode;
  hideNav?: boolean;
}

const NAV_ITEMS = [
  { path: '/home',    icon: Map,     label: 'Explore' },
  { path: '/needs',   icon: Heart,   label: 'My Needs' },
  { path: '/matches', icon: Users,   label: 'Matches' },
  { path: '/profile', icon: User,    label: 'Profile' },
];

const ADMIN_NAV = [
  { path: '/admin', icon: BarChart2, label: 'Admin' },
];

export function AppShell({ children, hideNav = false }: AppShellProps) {
  const [location, navigate] = useLocation();
  const { user } = useAuthStore();

  const navItems = user && ['admin', 'superadmin'].includes(user.role)
    ? [...NAV_ITEMS, ...ADMIN_NAV]
    : NAV_ITEMS;

  return (
    <div className="relative h-screen w-full overflow-hidden bg-background">
      {/* Main content */}
      <div className={`absolute inset-0 ${hideNav ? '' : 'bottom-[60px]'}`}>
        {children}
      </div>

      {/* Bottom navigation */}
      {!hideNav && (
        <nav className="absolute bottom-0 left-0 right-0 h-[60px] bg-card border-t border-border z-50 safe-area-bottom">
          <div className="flex h-full">
            {navItems.map(({ path, icon: Icon, label }) => {
              const active = location === path || location.startsWith(path + '/');
              return (
                <button
                  key={path}
                  type="button"
                  onClick={() => navigate(path)}
                  className="flex-1 flex flex-col items-center justify-center gap-0.5 transition-colors"
                >
                  <Icon
                    className={`w-5 h-5 transition-colors ${active ? 'text-primary' : 'text-muted-foreground'}`}
                    strokeWidth={active ? 2.5 : 1.8}
                  />
                  <span
                    className={`text-[10px] font-medium transition-colors ${active ? 'text-primary' : 'text-muted-foreground'}`}
                  >
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}

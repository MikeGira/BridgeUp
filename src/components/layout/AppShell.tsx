import { useLocation } from 'wouter';
import { Map, Heart, Users, User, BarChart2 } from 'lucide-react';
import { useAuthStore } from '@/store/auth';

interface AppShellProps {
  children: React.ReactNode;
  hideNav?: boolean;
}

const NAV_ITEMS = [
  { path: '/home',    icon: Map,      label: 'Explore'  },
  { path: '/needs',   icon: Heart,    label: 'My Needs' },
  { path: '/matches', icon: Users,    label: 'Matches'  },
  { path: '/profile', icon: User,     label: 'Profile'  },
];

const ADMIN_NAV = [{ path: '/admin', icon: BarChart2, label: 'Admin' }];

// Nav height + iOS safe area
const NAV_HEIGHT = 60;

export function AppShell({ children, hideNav = false }: AppShellProps) {
  const [location, navigate] = useLocation();
  const { user } = useAuthStore();

  const navItems = user && ['admin', 'superadmin'].includes(user.role)
    ? [...NAV_ITEMS, ...ADMIN_NAV]
    : NAV_ITEMS;

  return (
    <div style={{ position: 'relative', height: '100dvh', width: '100%', overflow: 'hidden', background: '#f5f5f5' }}>
      {/* Main content area — sits above the nav bar */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        bottom: hideNav ? 0 : NAV_HEIGHT,
        overflow: 'hidden',
      }}>
        {children}
      </div>

      {/* Bottom navigation — uses padding-bottom for iOS home indicator */}
      {!hideNav && (
        <nav style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          height: NAV_HEIGHT,
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          background: '#ffffff',
          borderTop: '1px solid #e5e7eb',
          display: 'flex',
          zIndex: 100,
          boxShadow: '0 -1px 8px rgba(0,0,0,0.06)',
        }}>
          {navItems.map(({ path, icon: Icon, label }) => {
            const active = location === path || location.startsWith(path + '/');
            return (
              <button
                key={path}
                type="button"
                onClick={() => navigate(path)}
                style={{
                  flex: 1, display: 'flex', flexDirection: 'column',
                  alignItems: 'center', justifyContent: 'center', gap: 2,
                  background: 'none', border: 'none', cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                  color: active ? '#2563eb' : '#9ca3af',
                  padding: '6px 0',
                }}
              >
                <Icon
                  style={{ width: 22, height: 22 }}
                  strokeWidth={active ? 2.5 : 1.8}
                />
                <span style={{
                  fontSize: 10, fontWeight: active ? 600 : 500,
                  fontFamily: 'inherit', lineHeight: 1.2,
                }}>
                  {label}
                </span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
}

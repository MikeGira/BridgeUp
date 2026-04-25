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

const NAV_HEIGHT = 68;

export function AppShell({ children, hideNav = false }: AppShellProps) {
  const [location, navigate] = useLocation();
  const { user } = useAuthStore();

  const navItems = user && ['admin', 'superadmin'].includes(user.role)
    ? [...NAV_ITEMS, ...ADMIN_NAV]
    : NAV_ITEMS;

  return (
    <div style={{ position: 'relative', height: '100dvh', width: '100%', overflow: 'hidden', background: '#f5f5f5' }}>
      {/* Main content area */}
      <div style={{
        position: 'absolute', top: 0, left: 0, right: 0,
        bottom: hideNav ? 0 : NAV_HEIGHT,
        overflow: 'hidden',
      }}>
        {children}
      </div>

      {!hideNav && (
        <nav style={{
          position: 'absolute', bottom: 0, left: 0, right: 0,
          height: NAV_HEIGHT,
          paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          background: 'rgba(255,255,255,0.97)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          borderTop: '1px solid rgba(0,0,0,0.07)',
          display: 'flex',
          zIndex: 100,
        }}>
          {navItems.map(({ path, icon: Icon, label }) => {
            const active = location === path || location.startsWith(path + '/');
            return (
              <button
                key={path}
                type="button"
                onClick={() => navigate(path)}
                style={{
                  flex: 1,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 4,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  WebkitTapHighlightColor: 'transparent',
                  color: active ? '#111827' : '#a3a3a3',
                  padding: '6px 0',
                  position: 'relative',
                }}
              >
                {/* Active indicator line */}
                {active && (
                  <div style={{
                    position: 'absolute',
                    top: 0,
                    left: '50%',
                    transform: 'translateX(-50%)',
                    width: 24,
                    height: 2.5,
                    borderRadius: 2,
                    background: '#111827',
                  }} />
                )}
                <Icon
                  style={{ width: 22, height: 22 }}
                  strokeWidth={active ? 2.4 : 1.7}
                />
                <span style={{
                  fontSize: 10,
                  fontWeight: active ? 700 : 500,
                  fontFamily: 'inherit',
                  lineHeight: 1.2,
                  letterSpacing: '0.01em',
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

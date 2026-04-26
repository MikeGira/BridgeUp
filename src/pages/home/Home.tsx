import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
  User, MapPin,
  UtensilsCrossed, Home as HomeIcon, Briefcase,
  Heart, GraduationCap, Banknote,
  Navigation, Search, Sparkles,
} from 'lucide-react';
import { needsApi, matchesApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { AppShell } from '@/components/layout/AppShell';
import { MapView } from '@/components/map/MapView';
import type { TileType } from '@/components/map/MapView';
import { NeedCard } from '@/components/needs/NeedCard';

// ─── Category filter pills (no "All" — redundant on a map view) ──────────────
type Category = 'food' | 'housing' | 'employment' | 'medical' | 'training' | 'funding';

const PILLS: { key: Category; icon: React.ComponentType<{ style?: React.CSSProperties }>; label: string; color: string }[] = [
  { key: 'food',       icon: UtensilsCrossed, label: 'Food',     color: '#ea580c' },
  { key: 'housing',    icon: HomeIcon,        label: 'Housing',  color: '#2563eb' },
  { key: 'employment', icon: Briefcase,       label: 'Jobs',     color: '#7c3aed' },
  { key: 'medical',    icon: Heart,           label: 'Medical',  color: '#e11d48' },
  { key: 'training',   icon: GraduationCap,   label: 'Training', color: '#0d9488' },
  { key: 'funding',    icon: Banknote,        label: 'Funding',  color: '#16a34a' },
];

type SheetState = 'peek' | 'half' | 'full';
const SHEET_HEIGHTS: Record<SheetState, string> = {
  peek: '220px',
  half: '52vh',
  full: '88vh',
};

export default function Home() {
  const [, navigate] = useLocation();
  const { user } = useAuthStore();
  const [sheetState, setSheetState] = useState<SheetState>('peek');
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [activeFilter, setActiveFilter] = useState<Category | null>(null);
  const [tileType,     setTileType]     = useState<TileType>('standard');

  const { data: needsData } = useQuery({
    queryKey: ['my-needs'],
    queryFn: () => needsApi.myNeeds(),
    enabled: !!user,
  });

  const { data: matchesData } = useQuery({
    queryKey: ['matches'],
    queryFn: () => matchesApi.list(),
    enabled: !!user,
    refetchInterval: 15_000,
  });

  useEffect(() => {
    navigator.geolocation?.getCurrentPosition(
      (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {}
    );
  }, []);

  const allNeeds      = needsData?.needs ?? [];
  const activeNeeds   = allNeeds.filter((n) => !['resolved', 'closed', 'cancelled'].includes(n.status));
  const activeMatches = matchesData?.matches?.filter((m) => ['accepted', 'in_progress'].includes(m.status)) ?? [];
  const latestNeed    = activeNeeds[0];
  const latestMatch   = activeMatches[0];

  const mapNeeds = activeFilter ? allNeeds.filter((n) => n.category === activeFilter) : allNeeds;
  const sheetH   = SHEET_HEIGHTS[sheetState];

  function geoLocate() {
    navigator.geolocation?.getCurrentPosition(
      (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => {}
    );
  }

  return (
    <AppShell>
      {/* ── Full-screen map (zIndex:0 isolates Leaflet's internal z-indices) ── */}
      <div className="absolute inset-0" style={{ zIndex: 0 }}>
        <MapView
          center={userLocation ?? { lat: -1.9441, lng: 30.0619 }}
          needs={mapNeeds}
          userLocation={userLocation}
          tileType={tileType}
        />
      </div>

      {/* ── TOP: Google Maps-style search bar + filter pills ── */}
      <div
        className="absolute top-0 left-0 right-0 safe-area-top"
        style={{ zIndex: 50, pointerEvents: 'none' }}
      >
        {/* Search bar row */}
        <div className="flex items-center gap-2 px-3 pt-12 pb-2" style={{ pointerEvents: 'auto' }}>
          <button
            type="button"
            onClick={() => navigate('/post-need')}
            className="flex-1 flex items-center gap-3 rounded-full text-left active:scale-[0.98] transition-transform"
            style={{
              background: '#fff',
              boxShadow: '0 2px 12px rgba(0,0,0,0.15)',
              padding: '12px 18px',
              border: 'none', cursor: 'pointer',
            }}
          >
            <Search style={{ width: 18, height: 18, color: '#9ca3af', flexShrink: 0 }} />
            <span style={{ flex: 1, fontSize: 15, color: '#9ca3af', fontFamily: 'Inter, system-ui, sans-serif' }}>
              Where do you need help?
            </span>
            {/* Profile avatar inside search bar — like Google Maps */}
            <div
              onClick={(e) => { e.stopPropagation(); navigate('/profile'); }}
              style={{
                width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
                background: 'linear-gradient(135deg,#2563eb,#7c3aed)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              {user?.avatarUrl ? (
                <img src={user.avatarUrl} style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover' }} alt="" />
              ) : (
                <User style={{ width: 16, height: 16, color: '#fff' }} />
              )}
            </div>
          </button>
        </div>

        {/* Filter pills row — horizontal scroll, no "All" */}
        <div
          style={{ display: 'flex', gap: 8, padding: '0 12px 10px', overflowX: 'auto', scrollbarWidth: 'none', pointerEvents: 'auto' }}
        >
          {PILLS.map(({ key, icon: Icon, label, color }) => {
            const active = activeFilter === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setActiveFilter(active ? null : key)}
                className="flex items-center gap-1.5 flex-shrink-0 active:scale-95 transition-transform"
                style={{
                  padding: '7px 14px', borderRadius: 99, border: 'none', cursor: 'pointer',
                  background: active ? color : 'rgba(255,255,255,0.96)',
                  color: active ? '#fff' : '#374151',
                  fontSize: 13, fontWeight: 600,
                  boxShadow: '0 1px 6px rgba(0,0,0,0.12)',
                  backdropFilter: 'blur(8px)',
                  fontFamily: 'Inter, system-ui, sans-serif',
                }}
              >
                <Icon style={{ width: 14, height: 14, color: active ? '#fff' : color, flexShrink: 0 }} />
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── AI Assistant FAB — fixed bottom-left, always visible ── */}
      <div style={{ position: 'absolute', left: 16, bottom: 90, zIndex: 50 }}>
        {/* Pulse ring */}
        <div style={{
          position: 'absolute', inset: -8, borderRadius: '50%',
          background: 'rgba(124,58,237,0.2)',
          animation: 'bridge-ai-pulse 2.5s ease-in-out infinite',
          pointerEvents: 'none',
        }} />
        <button
          type="button"
          onClick={() => navigate('/intake')}
          style={{
            position: 'relative', width: 52, height: 52, borderRadius: '50%',
            background: 'linear-gradient(135deg,#2563eb,#7c3aed)',
            border: 'none', cursor: 'pointer',
            boxShadow: '0 4px 20px rgba(124,58,237,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'transform 0.15s',
          }}
          title="Bridge AI Assistant"
          onMouseDown={(e) => (e.currentTarget.style.transform = 'scale(0.9)')}
          onMouseUp={(e)   => (e.currentTarget.style.transform = 'scale(1)')}
        >
          <Sparkles style={{ width: 22, height: 22, color: '#fff' }} />
        </button>
      </div>

      {/* ── Satellite/Map layers toggle — bottom-right ── */}
      <button
        type="button"
        onClick={() => setTileType((t) => t === 'standard' ? 'satellite' : 'standard')}
        style={{
          position: 'absolute', right: 16, bottom: 148, zIndex: 50,
          width: 44, height: 44, borderRadius: 10,
          background: tileType === 'satellite' ? '#1e293b' : '#fff',
          border: tileType === 'satellite' ? '2px solid #2563eb' : 'none',
          cursor: 'pointer',
          boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2,
          padding: 0,
        }}
        title={tileType === 'standard' ? 'Switch to Satellite' : 'Switch to Map'}
      >
        {/* Mini map preview icon */}
        <div style={{
          width: 28, height: 18, borderRadius: 3,
          background: tileType === 'standard'
            ? 'linear-gradient(135deg,#4ade80,#22d3ee,#818cf8)'
            : 'linear-gradient(135deg,#e5e7eb,#d1d5db)',
          border: '1.5px solid rgba(0,0,0,0.15)',
          position: 'relative', overflow: 'hidden',
        }}>
          {tileType === 'standard' ? (
            // Satellite icon when in standard mode
            <div style={{ position: 'absolute', inset: 0, background: 'repeating-linear-gradient(45deg,rgba(0,0,0,0.1) 0,rgba(0,0,0,0.1) 1px,transparent 1px,transparent 4px)' }} />
          ) : (
            // Map icon when in satellite mode
            <div style={{ position: 'absolute', inset: 0 }}>
              <div style={{ position: 'absolute', top: 6, left: 0, right: 0, height: 2, background: '#9ca3af' }} />
              <div style={{ position: 'absolute', top: 11, left: 0, right: 0, height: 1, background: '#d1d5db' }} />
            </div>
          )}
        </div>
        <span style={{ fontSize: 8, fontWeight: 700, color: tileType === 'satellite' ? '#e2e8f0' : '#374151', fontFamily: 'inherit' }}>
          {tileType === 'standard' ? 'SAT' : 'MAP'}
        </span>
      </button>

      {/* ── Location button — fixed bottom-right, always visible ── */}
      <button
        type="button"
        onClick={geoLocate}
        style={{
          position: 'absolute', right: 16, bottom: 90, zIndex: 50,
          width: 44, height: 44, borderRadius: '50%',
          background: '#fff', border: 'none', cursor: 'pointer',
          boxShadow: '0 2px 12px rgba(0,0,0,0.13)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <Navigation style={{ width: 18, height: 18, color: '#2563eb' }} />
      </button>

      {/* ── Bottom sheet ── */}
      <div
        className="absolute bottom-0 left-0 right-0 bg-white rounded-t-[28px]"
        style={{
          zIndex: 60,
          height: sheetH,
          boxShadow: '0 -4px 32px rgba(0,0,0,0.12)',
          transition: 'height 300ms cubic-bezier(0.32,0.72,0,1)',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Drag handle */}
        <button
          type="button"
          className="w-full flex items-center justify-center pt-3 pb-1 flex-shrink-0"
          onClick={() => setSheetState((s) => s === 'peek' ? 'half' : s === 'half' ? 'full' : 'peek')}
          aria-label="Toggle sheet"
        >
          <div style={{ width: 36, height: 3.5, borderRadius: 2, background: '#e5e7eb' }} />
        </button>

        <div className="overflow-y-auto flex-1 pb-6 px-4">
          {/* Greeting */}
          <div className="flex items-center justify-between mb-4 mt-1">
            <div>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: '#111827', letterSpacing: '-0.3px', lineHeight: 1.2 }}>
                {user?.displayName ? `Hi, ${user.displayName.split(' ')[0]}` : 'Welcome back'}
              </h2>
              <p style={{ margin: '3px 0 0', fontSize: 13, color: '#6b7280' }}>
                {activeNeeds.length > 0
                  ? `${activeNeeds.length} active request${activeNeeds.length > 1 ? 's' : ''}`
                  : 'What do you need today?'}
              </p>
            </div>
            {activeMatches.length > 0 && (
              <button
                type="button"
                onClick={() => navigate('/matches')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5, padding: '6px 12px',
                  borderRadius: 99, border: 'none', background: '#dcfce7', cursor: 'pointer',
                }}
              >
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#16a34a' }} />
                <span style={{ fontSize: 12, fontWeight: 700, color: '#15803d' }}>{activeMatches.length} active</span>
              </button>
            )}
          </div>

          {/* Category grid — 4 across, Uber style */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
            {([
              { key: 'food',       icon: UtensilsCrossed, label: 'Food',    bg: '#fff4ed', color: '#ea580c' },
              { key: 'housing',    icon: HomeIcon,        label: 'Housing', bg: '#eff6ff', color: '#2563eb' },
              { key: 'employment', icon: Briefcase,       label: 'Jobs',    bg: '#f5f3ff', color: '#7c3aed' },
              { key: 'medical',    icon: Heart,           label: 'Medical', bg: '#fff1f2', color: '#e11d48' },
            ] as const).map(({ key, icon: Icon, label, bg, color }) => (
              <button
                key={key}
                type="button"
                onClick={() => navigate(`/post-need?category=${key}`)}
                style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}
              >
                <div style={{
                  width: 56, height: 56, borderRadius: 18,
                  background: bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>
                  <Icon style={{ width: 26, height: 26, color }} strokeWidth={1.8} />
                </div>
                <span style={{ fontSize: 11, fontWeight: 600, color: '#374151' }}>{label}</span>
              </button>
            ))}
          </div>

          {/* Active match card */}
          {latestMatch && (
            <button
              type="button"
              onClick={() => navigate(`/matches/${latestMatch.id}`)}
              style={{
                all: 'unset', cursor: 'pointer', display: 'block',
                width: '100%', marginBottom: 10,
              }}
            >
              <div style={{
                background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 16, padding: '12px 14px',
                display: 'flex', alignItems: 'center', gap: 12,
              }}>
                <div style={{ width: 38, height: 38, borderRadius: '50%', background: '#dcfce7', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <Navigation style={{ width: 18, height: 18, color: '#16a34a' }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: '#166534' }}>Helper on the way</p>
                  <p style={{ margin: '2px 0 0', fontSize: 12, color: '#16a34a' }}>
                    {latestMatch.distanceKm ? `${latestMatch.distanceKm.toFixed(1)} km away` : 'Tracking…'}
                  </p>
                </div>
                <span style={{ fontSize: 10, fontWeight: 800, color: '#16a34a', background: '#dcfce7', borderRadius: 99, padding: '3px 8px' }}>LIVE</span>
              </div>
            </button>
          )}

          {/* Latest active need */}
          {latestNeed && !latestMatch && (
            <button
              type="button"
              onClick={() => navigate(`/needs/${latestNeed.id}`)}
              style={{ all: 'unset', cursor: 'pointer', display: 'block', width: '100%', marginBottom: 10 }}
            >
              <NeedCard need={latestNeed} compact />
            </button>
          )}

          {/* Requests list (half / full state) */}
          {activeNeeds.length > 0 && sheetState !== 'peek' && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#374151' }}>Your requests</span>
                <button
                  type="button"
                  onClick={() => navigate('/needs')}
                  style={{ background: 'none', border: 'none', fontSize: 12, fontWeight: 700, color: '#2563eb', cursor: 'pointer' }}
                >
                  See all
                </button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {activeNeeds.slice(0, 3).map((need) => (
                  <button
                    key={need.id}
                    type="button"
                    onClick={() => navigate(`/needs/${need.id}`)}
                    style={{ all: 'unset', cursor: 'pointer', display: 'block' }}
                  >
                    <NeedCard need={need} compact />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Empty state (half / full) */}
          {activeNeeds.length === 0 && sheetState !== 'peek' && (
            <div style={{ textAlign: 'center', padding: '16px 0 8px' }}>
              <div style={{ width: 44, height: 44, borderRadius: 14, background: '#f3f4f6', margin: '0 auto 10px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <MapPin style={{ width: 20, height: 20, color: '#9ca3af' }} />
              </div>
              <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 700, color: '#111827' }}>No active requests</p>
              <p style={{ margin: '0 0 16px', fontSize: 12, color: '#6b7280' }}>Tap the search bar or ask the AI agent</p>
              <button
                type="button"
                onClick={() => navigate('/intake')}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, margin: '0 auto',
                  padding: '10px 20px', borderRadius: 99, border: 'none', cursor: 'pointer',
                  background: 'linear-gradient(135deg,#2563eb,#7c3aed)', color: '#fff',
                  fontSize: 13, fontWeight: 700,
                }}
              >
                <Sparkles style={{ width: 14, height: 14 }} />
                Ask Bridge AI
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Animations */}
      <style>{`
        @keyframes bridge-ai-pulse {
          0%, 100% { transform: scale(1); opacity: 0.6; }
          50%       { transform: scale(1.4); opacity: 0; }
        }
      `}</style>
    </AppShell>
  );
}

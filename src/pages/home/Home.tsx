import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
  User, MapPin,
  UtensilsCrossed, Home as HomeIcon, Briefcase,
  Heart, GraduationCap, Banknote, HelpCircle,
  Navigation, Search, Sparkles,
} from 'lucide-react';
import { needsApi, matchesApi } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { AppShell } from '@/components/layout/AppShell';
import { MapView } from '@/components/map/MapView';
import { NeedCard } from '@/components/needs/NeedCard';

type Category = 'all' | 'food' | 'housing' | 'employment' | 'medical' | 'training' | 'funding';

const FILTER_PILLS: { key: Category; icon: React.ComponentType<{ style?: React.CSSProperties }>; label: string; color: string }[] = [
  { key: 'all',        icon: HelpCircle,     label: 'All',        color: '#6b7280' },
  { key: 'food',       icon: UtensilsCrossed, label: 'Food',      color: '#ea580c' },
  { key: 'housing',    icon: HomeIcon,        label: 'Housing',   color: '#2563eb' },
  { key: 'employment', icon: Briefcase,       label: 'Jobs',      color: '#7c3aed' },
  { key: 'medical',    icon: Heart,           label: 'Medical',   color: '#e11d48' },
  { key: 'training',   icon: GraduationCap,   label: 'Training',  color: '#0d9488' },
  { key: 'funding',    icon: Banknote,        label: 'Funding',   color: '#16a34a' },
];

type SheetState = 'peek' | 'half' | 'full';
const SHEET_HEIGHTS: Record<SheetState, string> = {
  peek: '228px',
  half: '52vh',
  full: '88vh',
};

export default function Home() {
  const [, navigate] = useLocation();
  const { user } = useAuthStore();
  const [sheetState, setSheetState] = useState<SheetState>('peek');
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [activeFilter, setActiveFilter] = useState<Category>('all');

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

  const allNeeds     = needsData?.needs ?? [];
  const activeNeeds  = allNeeds.filter((n) => !['resolved', 'closed', 'cancelled'].includes(n.status));
  const activeMatches = matchesData?.matches?.filter((m) => ['accepted', 'in_progress'].includes(m.status)) ?? [];
  const latestNeed   = activeNeeds[0];
  const latestMatch  = activeMatches[0];

  const filteredNeeds = activeFilter === 'all'
    ? allNeeds
    : allNeeds.filter((n) => n.category === activeFilter);

  const sheetH = SHEET_HEIGHTS[sheetState];

  return (
    <AppShell>
      {/* Full-screen map */}
      <div className="absolute inset-0">
        <MapView
          center={userLocation ?? { lat: -1.9441, lng: 30.0619 }}
          needs={filteredNeeds}
          userLocation={userLocation}
        />
      </div>

      {/* ── Top bar: search pill + profile avatar ── */}
      <div className="absolute top-0 left-0 right-0 z-20 safe-area-top">
        <div className="flex items-center gap-2.5 px-4 pt-12 pb-2">
          <button
            type="button"
            onClick={() => navigate('/post-need')}
            className="flex-1 flex items-center gap-3 bg-white rounded-full px-5 py-3.5 text-left active:scale-[0.98] transition-transform"
            style={{ boxShadow: '0 2px 20px rgba(0,0,0,0.13)' }}
          >
            <Search className="w-[18px] h-[18px] text-gray-400 flex-shrink-0" />
            <span className="text-gray-400 text-[15px] select-none">Where do you need help?</span>
          </button>
          <button
            type="button"
            onClick={() => navigate('/profile')}
            className="w-12 h-12 rounded-full bg-white flex items-center justify-center flex-shrink-0 active:scale-95 transition-transform"
            style={{ boxShadow: '0 2px 20px rgba(0,0,0,0.13)' }}
          >
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} className="w-10 h-10 rounded-full object-cover" alt="" />
            ) : (
              <User className="w-[18px] h-[18px] text-gray-600" />
            )}
          </button>
        </div>

        {/* ── Category filter pills ── */}
        <div className="px-4 pb-3">
          <div
            className="flex gap-2 overflow-x-auto"
            style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
          >
            {FILTER_PILLS.map(({ key, icon: Icon, label, color }) => {
              const active = activeFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setActiveFilter(key)}
                  className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[13px] font-semibold flex-shrink-0 transition-all active:scale-95"
                  style={{
                    background: active ? color : 'rgba(255,255,255,0.95)',
                    color: active ? '#ffffff' : '#374151',
                    boxShadow: '0 1px 8px rgba(0,0,0,0.12)',
                    backdropFilter: 'blur(8px)',
                  }}
                >
                  <Icon style={{ width: 14, height: 14, color: active ? '#ffffff' : color, flexShrink: 0 }} />
                  {label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Location button — floats above bottom sheet ── */}
      <button
        type="button"
        onClick={() => {
          navigator.geolocation?.getCurrentPosition(
            (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            () => {}
          );
        }}
        className="absolute right-4 z-20 w-12 h-12 rounded-full bg-white flex items-center justify-center active:scale-95"
        style={{
          bottom: `calc(${sheetH} + 72px)`,
          boxShadow: '0 2px 16px rgba(0,0,0,0.13)',
          transition: 'bottom 300ms cubic-bezier(0.32,0.72,0,1)',
        }}
      >
        <Navigation className="w-[18px] h-[18px] text-blue-600" />
      </button>

      {/* ── AI Assistant FAB ── */}
      <button
        type="button"
        onClick={() => navigate('/intake')}
        className="absolute right-4 z-20 flex items-center gap-2 rounded-full px-4 py-3 active:scale-95 transition-all"
        style={{
          bottom: `calc(${sheetH} + 16px)`,
          background: 'linear-gradient(135deg,#2563eb,#7c3aed)',
          boxShadow: '0 4px 20px rgba(37,99,235,0.45)',
          transition: 'bottom 300ms cubic-bezier(0.32,0.72,0,1)',
        }}
      >
        <Sparkles style={{ width: 18, height: 18, color: '#fff', flexShrink: 0 }} />
        <span style={{ color: '#fff', fontSize: 13, fontWeight: 700, letterSpacing: '-0.1px' }}>AI Help</span>
      </button>

      {/* ── Bottom sheet ── */}
      <div
        className="absolute bottom-0 left-0 right-0 z-30 bg-white rounded-t-[28px]"
        style={{
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
          <div className="w-9 h-[3.5px] rounded-full bg-gray-200" />
        </button>

        <div className="overflow-y-auto flex-1 pb-6 px-5">
          {/* Greeting */}
          <div className="flex items-center justify-between mb-4 mt-1">
            <div>
              <h2 className="text-[20px] font-bold text-gray-900 tracking-tight leading-tight">
                {user?.displayName ? `Hi, ${user.displayName.split(' ')[0]}` : 'Welcome back'}
              </h2>
              <p className="text-[13px] text-gray-500 mt-0.5">
                {activeNeeds.length > 0
                  ? `${activeNeeds.length} active request${activeNeeds.length > 1 ? 's' : ''}`
                  : 'What do you need today?'}
              </p>
            </div>
            {activeMatches.length > 0 && (
              <button
                type="button"
                onClick={() => navigate('/matches')}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-full"
                style={{ background: '#dcfce7' }}
              >
                <div className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <span className="text-[12px] font-semibold text-green-700">{activeMatches.length} active</span>
              </button>
            )}
          </div>

          {/* Category grid */}
          <div className="grid grid-cols-4 gap-3 mb-4">
            {[
              { key: 'food',       icon: UtensilsCrossed, label: 'Food',    bg: '#fff4ed', color: '#ea580c' },
              { key: 'housing',    icon: HomeIcon,        label: 'Housing', bg: '#eff6ff', color: '#2563eb' },
              { key: 'employment', icon: Briefcase,       label: 'Jobs',    bg: '#f5f3ff', color: '#7c3aed' },
              { key: 'medical',    icon: Heart,           label: 'Medical', bg: '#fff1f2', color: '#e11d48' },
            ].map(({ key, icon: Icon, label, bg, color }) => (
              <button
                key={key}
                type="button"
                onClick={() => navigate(`/post-need?category=${key}`)}
                className="flex flex-col items-center gap-2 active:scale-95 transition-transform"
              >
                <div className="w-[58px] h-[58px] rounded-[18px] flex items-center justify-center" style={{ background: bg }}>
                  <Icon style={{ width: 26, height: 26, color }} strokeWidth={1.8} />
                </div>
                <span className="text-[11px] font-semibold text-gray-700 leading-none">{label}</span>
              </button>
            ))}
          </div>

          {/* Active match card */}
          {latestMatch && (
            <button
              type="button"
              onClick={() => navigate(`/matches/${latestMatch.id}`)}
              className="w-full mb-3 p-4 rounded-2xl text-left active:scale-[0.98] transition-transform"
              style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full flex items-center justify-center" style={{ background: '#dcfce7' }}>
                  <Navigation style={{ width: 18, height: 18, color: '#16a34a' }} />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold text-[13px] text-gray-900">Helper on the way</p>
                  <p className="text-[12px] text-gray-500 truncate">
                    {latestMatch.distanceKm ? `${latestMatch.distanceKm.toFixed(1)} km away` : 'Tracking…'}
                  </p>
                </div>
                <span className="text-[10px] font-bold px-2 py-1 rounded-full" style={{ background: '#dcfce7', color: '#16a34a' }}>
                  Live
                </span>
              </div>
            </button>
          )}

          {/* Latest active need */}
          {latestNeed && !latestMatch && (
            <button type="button" onClick={() => navigate(`/needs/${latestNeed.id}`)} className="w-full mb-3">
              <NeedCard need={latestNeed} compact />
            </button>
          )}

          {/* Recent requests (half/full only) */}
          {activeNeeds.length > 0 && sheetState !== 'peek' && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-[13px] text-gray-900">Your requests</h3>
                <button type="button" onClick={() => navigate('/needs')} className="text-[12px] font-semibold text-blue-600">
                  See all
                </button>
              </div>
              <div className="space-y-2">
                {activeNeeds.slice(0, 3).map((need) => (
                  <button key={need.id} type="button" onClick={() => navigate(`/needs/${need.id}`)} className="w-full">
                    <NeedCard need={need} compact />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Empty state (half/full only) */}
          {activeNeeds.length === 0 && sheetState !== 'peek' && (
            <div className="text-center py-6">
              <div className="w-12 h-12 rounded-2xl mx-auto flex items-center justify-center mb-3" style={{ background: '#f3f4f6' }}>
                <MapPin style={{ width: 22, height: 22, color: '#9ca3af' }} />
              </div>
              <p className="font-semibold text-[13px] text-gray-900 mb-1">No active requests</p>
              <p className="text-[12px] text-gray-500 mb-4">Tap the search bar or use AI Help to get started</p>
              <button
                type="button"
                onClick={() => navigate('/intake')}
                className="flex items-center gap-2 mx-auto px-5 py-2.5 rounded-full text-[13px] font-bold text-white"
                style={{ background: 'linear-gradient(135deg,#2563eb,#7c3aed)' }}
              >
                <Sparkles style={{ width: 15, height: 15 }} />
                Ask AI Assistant
              </button>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

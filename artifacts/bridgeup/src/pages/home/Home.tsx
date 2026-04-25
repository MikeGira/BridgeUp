import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import {
  Plus, Bell, User, MapPin, ChevronUp,
  UtensilsCrossed, Home as HomeIcon, Briefcase,
  Heart, GraduationCap, Banknote, HelpCircle,
  Clock, CheckCircle, Loader, Navigation, Search,
} from 'lucide-react';
import { needsApi, matchesApi } from '@/lib/api';
import type { Need, Match } from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';
import { MapView } from '@/components/map/MapView';
import { NeedCard } from '@/components/needs/NeedCard';

const CATEGORY_META: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string; color: string }> = {
  food:       { icon: UtensilsCrossed, label: 'Food',       color: 'bg-orange-100 text-orange-700 border-orange-200' },
  housing:    { icon: HomeIcon,        label: 'Housing',    color: 'bg-blue-100 text-blue-700 border-blue-200'   },
  employment: { icon: Briefcase,       label: 'Employment', color: 'bg-violet-100 text-violet-700 border-violet-200' },
  medical:    { icon: Heart,           label: 'Medical',    color: 'bg-red-100 text-red-700 border-red-200'     },
  training:   { icon: GraduationCap,   label: 'Training',   color: 'bg-teal-100 text-teal-700 border-teal-200'  },
  funding:    { icon: Banknote,        label: 'Funding',    color: 'bg-green-100 text-green-700 border-green-200' },
  other:      { icon: HelpCircle,      label: 'Other',      color: 'bg-gray-100 text-gray-700 border-gray-200'  },
};

const STATUS_META: Record<string, { label: string; color: string; icon: React.ComponentType<{ className?: string }> }> = {
  pending_match: { label: 'Looking for help',   color: 'bg-amber-100 text-amber-700',  icon: Clock       },
  matching:      { label: 'Matching…',          color: 'bg-blue-100 text-blue-700',    icon: Loader      },
  matched:       { label: 'Helper found!',      color: 'bg-green-100 text-green-700',  icon: CheckCircle },
  in_progress:   { label: 'In progress',        color: 'bg-teal-100 text-teal-700',    icon: Navigation  },
  resolved:      { label: 'Resolved',           color: 'bg-gray-100 text-gray-600',    icon: CheckCircle },
  cancelled:     { label: 'Cancelled',          color: 'bg-red-100 text-red-700',      icon: HelpCircle  },
};

type SheetState = 'peek' | 'half' | 'full';

export default function Home() {
  const [, navigate] = useLocation();
  const { user } = useAuthStore();
  const [sheetState, setSheetState] = useState<SheetState>('peek');
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<number | null>(null);
  const sheetStart = useRef<SheetState>('peek');

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

  const activeNeeds   = needsData?.needs?.filter((n) => !['resolved', 'closed', 'cancelled'].includes(n.status)) ?? [];
  const activeMatches = matchesData?.matches?.filter((m) => ['accepted', 'in_progress'].includes(m.status)) ?? [];
  const latestNeed    = activeNeeds[0];
  const latestMatch   = activeMatches[0];

  const sheetHeights: Record<SheetState, string> = {
    peek: 'h-[180px]',
    half: 'h-[50vh]',
    full: 'h-[85vh]',
  };

  function cycleSheet() {
    setSheetState((s) => s === 'peek' ? 'half' : s === 'half' ? 'full' : 'peek');
  }

  return (
    <AppShell>
      {/* Full-screen map */}
      <div className="absolute inset-0">
        <MapView
          center={userLocation ?? { lat: -1.9441, lng: 30.0619 }}
          needs={needsData?.needs ?? []}
          userLocation={userLocation}
        />
      </div>

      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-20 safe-area-top">
        <div className="flex items-center gap-3 px-4 pt-12 pb-3">
          <div className="flex-1 flex items-center gap-2 bg-card/95 backdrop-blur-sm rounded-2xl px-4 py-3 shadow-lg border border-border">
            <Search className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Search location or need…</span>
          </div>
          <button
            type="button"
            onClick={() => navigate('/profile')}
            className="w-11 h-11 rounded-full bg-card/95 backdrop-blur-sm border border-border shadow-lg flex items-center justify-center"
          >
            {user?.avatarUrl ? (
              <img src={user.avatarUrl} className="w-8 h-8 rounded-full object-cover" alt="" />
            ) : (
              <User className="w-5 h-5 text-muted-foreground" />
            )}
          </button>
          <button
            type="button"
            onClick={() => navigate('/matches')}
            className="relative w-11 h-11 rounded-full bg-card/95 backdrop-blur-sm border border-border shadow-lg flex items-center justify-center"
          >
            <Bell className="w-5 h-5 text-muted-foreground" />
            {activeMatches.length > 0 && (
              <span className="absolute top-1.5 right-1.5 w-2.5 h-2.5 bg-primary rounded-full border-2 border-white" />
            )}
          </button>
        </div>
      </div>

      {/* My location button */}
      <button
        type="button"
        onClick={() => {
          navigator.geolocation?.getCurrentPosition(
            (pos) => setUserLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            () => {}
          );
        }}
        className="absolute right-4 bottom-[220px] z-20 w-11 h-11 rounded-full bg-card shadow-lg border border-border flex items-center justify-center"
      >
        <Navigation className="w-5 h-5 text-primary" />
      </button>

      {/* FAB — Post Need */}
      <button
        type="button"
        onClick={() => navigate('/post-need')}
        className="absolute left-1/2 -translate-x-1/2 bottom-[210px] z-20 flex items-center gap-2 bg-primary text-white px-6 py-3.5 rounded-full shadow-xl font-semibold text-sm hover:bg-primary/90 transition-all active:scale-95"
      >
        <Plus className="w-5 h-5" />
        Get Help Now
      </button>

      {/* Bottom sheet */}
      <div
        ref={sheetRef}
        className={`absolute bottom-[60px] left-0 right-0 z-30 bg-card rounded-t-3xl shadow-2xl border-t border-border transition-all duration-300 ease-out overflow-hidden ${sheetHeights[sheetState]}`}
      >
        {/* Drag handle */}
        <button
          type="button"
          className="w-full flex items-center justify-center pt-3 pb-2"
          onClick={cycleSheet}
          aria-label="Toggle sheet"
        >
          <div className="w-12 h-1.5 bg-border rounded-full" />
        </button>

        <div className="overflow-y-auto h-full pb-6 px-4">
          {/* Greeting */}
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="font-semibold text-lg">
                {user?.displayName ? `Hi, ${user.displayName.split(' ')[0]}!` : 'Welcome back!'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {activeNeeds.length > 0 ? `${activeNeeds.length} active request${activeNeeds.length > 1 ? 's' : ''}` : 'No active requests'}
              </p>
            </div>
            <ChevronUp className={`w-5 h-5 text-muted-foreground transition-transform ${sheetState === 'full' ? 'rotate-180' : ''}`} />
          </div>

          {/* Active match card (Uber-style) */}
          {latestMatch && (
            <button
              type="button"
              onClick={() => navigate(`/matches/${latestMatch.id}`)}
              className="w-full mb-4 p-4 bg-primary/5 border border-primary/20 rounded-2xl text-left hover:bg-primary/10 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <Navigation className="w-5 h-5 text-primary" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">Helper on the way</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {latestMatch.distanceKm ? `${latestMatch.distanceKm.toFixed(1)} km away` : 'Tracking…'}
                  </p>
                </div>
                <Badge className="bg-green-100 text-green-700 border-green-200 text-xs">Live</Badge>
              </div>
            </button>
          )}

          {/* Latest active need status */}
          {latestNeed && !latestMatch && (
            <button
              type="button"
              onClick={() => navigate(`/needs/${latestNeed.id}`)}
              className="w-full mb-4"
            >
              <NeedCard need={latestNeed} compact />
            </button>
          )}

          {/* Quick actions */}
          <div className="grid grid-cols-4 gap-3 mb-5">
            {Object.entries(CATEGORY_META).slice(0, 4).map(([key, meta]) => {
              const Icon = meta.icon;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => navigate(`/post-need?category=${key}`)}
                  className="flex flex-col items-center gap-1.5 p-3 rounded-2xl bg-muted hover:bg-muted/80 transition-colors"
                >
                  <div className={`w-8 h-8 rounded-xl flex items-center justify-center ${meta.color}`}>
                    <Icon className="w-4 h-4" />
                  </div>
                  <span className="text-xs font-medium text-foreground">{meta.label}</span>
                </button>
              );
            })}
          </div>

          {/* Recent needs list */}
          {activeNeeds.length > 0 && sheetState !== 'peek' && (
            <div>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-medium text-sm">Your requests</h3>
                <button type="button" onClick={() => navigate('/needs')} className="text-xs text-primary">See all</button>
              </div>
              <div className="space-y-2">
                {activeNeeds.slice(0, 3).map((need) => (
                  <button
                    key={need.id}
                    type="button"
                    onClick={() => navigate(`/needs/${need.id}`)}
                    className="w-full"
                  >
                    <NeedCard need={need} compact />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Empty state */}
          {activeNeeds.length === 0 && (
            <div className="text-center py-6">
              <div className="w-14 h-14 rounded-2xl bg-muted mx-auto flex items-center justify-center mb-3">
                <MapPin className="w-7 h-7 text-muted-foreground" />
              </div>
              <p className="font-medium mb-1">No active requests</p>
              <p className="text-sm text-muted-foreground mb-4">Post a need to connect with helpers near you</p>
              <Button size="sm" onClick={() => navigate('/post-need')} className="rounded-full px-6">
                <Plus className="w-4 h-4 mr-1.5" /> Post a Need
              </Button>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

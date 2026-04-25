import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Users, Loader, RefreshCw, CheckCircle, Clock, Navigation, XCircle } from 'lucide-react';
import { matchesApi } from '@/lib/api';
import type { Match } from '@/lib/api';
import { AppShell } from '@/components/layout/AppShell';

const STATUS_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string; bg: string }> = {
  pending:     { label: 'Awaiting response',   icon: Clock,        color: 'text-amber-700', bg: 'bg-amber-50'  },
  accepted:    { label: 'Accepted',            icon: CheckCircle,  color: 'text-green-700', bg: 'bg-green-50'  },
  in_progress: { label: 'In progress',         icon: Navigation,   color: 'text-teal-700',  bg: 'bg-teal-50'   },
  declined:    { label: 'Declined',            icon: XCircle,      color: 'text-red-700',   bg: 'bg-red-50'    },
  resolved:    { label: 'Resolved',            icon: CheckCircle,  color: 'text-gray-600',  bg: 'bg-gray-50'   },
  cancelled:   { label: 'Cancelled',           icon: XCircle,      color: 'text-gray-600',  bg: 'bg-gray-50'   },
};

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function MatchRow({ match, onClick }: { match: Match; onClick: () => void }) {
  const meta = STATUS_META[match.status] || STATUS_META.pending;
  const Icon = meta.icon;
  return (
    <button type="button" onClick={onClick} className="w-full flex items-center gap-3 p-4 bg-card rounded-2xl border border-border hover:shadow-sm transition-shadow text-left">
      <div className={`w-11 h-11 rounded-full flex items-center justify-center flex-shrink-0 ${meta.bg}`}>
        <Icon className={`w-5 h-5 ${meta.color}`} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm">
          Match #{match.id.slice(-6).toUpperCase()}
        </p>
        <p className="text-xs text-muted-foreground truncate">
          {match.need?.category ? match.need.category.charAt(0).toUpperCase() + match.need.category.slice(1) : 'Need'} ·{' '}
          {match.distanceKm ? `${match.distanceKm.toFixed(1)} km away` : 'Distance unknown'}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        <span className={`text-xs font-medium ${meta.color}`}>{meta.label}</span>
        <span className="text-xs text-muted-foreground">{timeAgo(match.createdAt)}</span>
      </div>
    </button>
  );
}

export default function Matches() {
  const [, navigate] = useLocation();
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['matches'],
    queryFn:  () => matchesApi.list(),
    refetchInterval: 15_000,
  });

  const matches = data?.matches ?? [];
  const active  = matches.filter((m) => ['pending', 'accepted', 'in_progress'].includes(m.status));
  const past    = matches.filter((m) => ['resolved', 'declined', 'cancelled'].includes(m.status));

  return (
    <AppShell>
      <div className="flex flex-col h-full bg-background overflow-y-auto">
        <div className="px-4 pt-12 pb-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold">Matches</h1>
          <button type="button" onClick={() => void refetch()} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-muted">
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="px-4 pb-8 space-y-5">
          {isLoading && (
            <div className="flex items-center justify-center py-16">
              <Loader className="w-8 h-8 animate-spin text-primary" />
            </div>
          )}

          {!isLoading && matches.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                <Users className="w-8 h-8 text-muted-foreground" />
              </div>
              <h2 className="font-semibold text-lg mb-2">No matches yet</h2>
              <p className="text-sm text-muted-foreground max-w-xs">
                Once you post a need and we find a helper, your matches will appear here.
              </p>
            </div>
          )}

          {!isLoading && active.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Active</h2>
              <div className="space-y-2">
                {active.map((m) => (
                  <MatchRow key={m.id} match={m} onClick={() => navigate(`/matches/${m.id}`)} />
                ))}
              </div>
            </section>
          )}

          {!isLoading && past.length > 0 && (
            <section>
              <h2 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Past</h2>
              <div className="space-y-2">
                {past.map((m) => (
                  <MatchRow key={m.id} match={m} onClick={() => navigate(`/matches/${m.id}`)} />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </AppShell>
  );
}

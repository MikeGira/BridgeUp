import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, MapPin, Clock, CheckCircle, Loader, Navigation, HelpCircle } from 'lucide-react';
import { needsApi } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { AppShell } from '@/components/layout/AppShell';

const STATUS_STEPS = ['pending_match', 'matching', 'matched', 'in_progress', 'resolved'];

const STATUS_META: Record<string, { label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = {
  pending_match: { label: 'Searching for helpers', icon: Clock,        color: 'text-amber-600'  },
  matching:      { label: 'Matching you now…',     icon: Loader,       color: 'text-blue-600'   },
  matched:       { label: 'Helper found!',         icon: CheckCircle,  color: 'text-green-600'  },
  in_progress:   { label: 'Help in progress',      icon: Navigation,   color: 'text-teal-600'   },
  resolved:      { label: 'Resolved',              icon: CheckCircle,  color: 'text-gray-500'   },
  cancelled:     { label: 'Cancelled',             icon: HelpCircle,   color: 'text-red-500'    },
};

export default function NeedDetail() {
  const [location, navigate] = useLocation();
  const id = location.split('/').pop()!;

  const { data, isLoading } = useQuery({
    queryKey: ['need', id],
    queryFn:  () => needsApi.get(id),
    refetchInterval: 10_000,
  });

  const need = data?.need;
  const statusMeta = need ? STATUS_META[need.status] || STATUS_META.pending_match : null;
  const StatusIcon = statusMeta?.icon || Clock;
  const stepIdx = need ? STATUS_STEPS.indexOf(need.status) : -1;

  return (
    <AppShell hideNav>
      <div className="flex flex-col h-full bg-background overflow-y-auto">
        <div className="bu-page">
        <div className="flex items-center gap-3 px-5 pt-12 pb-4">
          <button type="button" onClick={() => navigate('/needs')} className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-muted">
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h1 className="text-xl font-bold flex-1 text-gray-900">Request Details</h1>
        </div>

        {isLoading && (
          <div className="flex-1 flex items-center justify-center py-20">
            <Loader className="w-8 h-8 animate-spin text-primary" />
          </div>
        )}

        {!isLoading && !need && (
          <div className="flex flex-col items-center justify-center py-20 text-center px-5">
            <div className="w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center mb-4">
              <HelpCircle className="w-7 h-7 text-gray-400" />
            </div>
            <p className="font-semibold text-gray-900 mb-1">Request not found</p>
            <p className="text-sm text-gray-500">This request may have been removed or is still loading.</p>
          </div>
        )}

        {!isLoading && need && (
          <div className="px-5 pb-8 space-y-4">
            {/* Status card — Uber-style */}
            <div className="p-5 bg-card rounded-2xl border border-border shadow-sm">
              <div className="flex items-center gap-3 mb-5">
                <div className={`w-12 h-12 rounded-full bg-muted flex items-center justify-center`}>
                  <StatusIcon className={`w-6 h-6 ${statusMeta?.color}`} />
                </div>
                <div>
                  <p className="font-bold text-lg">{statusMeta?.label}</p>
                  <p className="text-sm text-muted-foreground capitalize">{need.category} help</p>
                </div>
              </div>

              {/* Progress tracker */}
              <div className="relative">
                <div className="absolute top-3.5 left-3.5 right-3.5 h-0.5 bg-border" />
                <div
                  className="absolute top-3.5 left-3.5 h-0.5 bg-primary transition-all duration-500"
                  style={{ width: stepIdx >= 0 ? `${(stepIdx / (STATUS_STEPS.length - 1)) * 100}%` : '0%' }}
                />
                <div className="relative flex justify-between">
                  {STATUS_STEPS.slice(0, -1).map((s, i) => {
                    const done = i < stepIdx || (i === stepIdx && need.status === s);
                    const current = s === need.status;
                    return (
                      <div key={s} className="flex flex-col items-center gap-1.5">
                        <div className={`w-7 h-7 rounded-full border-2 flex items-center justify-center z-10 bg-background transition-all ${done || current ? 'border-primary' : 'border-border'}`}>
                          {done ? (
                            <div className="w-3 h-3 rounded-full bg-primary" />
                          ) : current ? (
                            <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                          ) : null}
                        </div>
                        <span className="text-[9px] text-muted-foreground capitalize text-center leading-tight" style={{ maxWidth: 44 }}>
                          {s.replace('_', ' ')}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Details */}
            <div className="p-4 bg-card rounded-2xl border border-border space-y-4">
              <div>
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Description</p>
                <p className="text-sm">{need.description}</p>
              </div>
              {need.location && (
                <div className="flex items-start gap-2">
                  <MapPin className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                  <p className="text-sm">{need.location}</p>
                </div>
              )}
              <div className="flex gap-3">
                <Badge variant="outline" className="capitalize">{need.urgency}</Badge>
                <Badge variant="outline" className="capitalize">{need.channel}</Badge>
              </div>
            </div>

            {/* Timeline */}
            {need.statusHistory.length > 0 && (
              <div className="p-4 bg-card rounded-2xl border border-border">
                <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">History</p>
                <div className="space-y-3">
                  {[...need.statusHistory].reverse().map((entry, i) => (
                    <div key={i} className="flex items-start gap-3">
                      <div className="w-1.5 h-1.5 rounded-full bg-primary mt-2 flex-shrink-0" />
                      <div>
                        <p className="text-xs font-medium capitalize">
                          {entry.from?.replace('_', ' ')} → {entry.to?.replace('_', ' ')}
                        </p>
                        {entry.reason && <p className="text-xs text-muted-foreground">{entry.reason}</p>}
                        <p className="text-xs text-muted-foreground">{new Date(entry.changedAt).toLocaleString()}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
        </div>{/* bu-page */}
      </div>
    </AppShell>
  );
}

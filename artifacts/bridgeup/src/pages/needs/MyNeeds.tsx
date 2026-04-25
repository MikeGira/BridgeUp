import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw } from 'lucide-react';
import { needsApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { AppShell } from '@/components/layout/AppShell';
import { NeedCard } from '@/components/needs/NeedCard';

export default function MyNeeds() {
  const [, navigate] = useLocation();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['my-needs'],
    queryFn:  () => needsApi.myNeeds(),
    refetchInterval: 30_000,
  });

  const needs = data?.needs ?? [];
  const active   = needs.filter((n) => !['resolved', 'closed', 'cancelled'].includes(n.status));
  const resolved = needs.filter((n) => ['resolved', 'closed'].includes(n.status));

  return (
    <AppShell>
      <div className="flex flex-col h-full bg-background overflow-y-auto">
        {/* Header */}
        <div className="px-4 pt-12 pb-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold">My Requests</h1>
          <div className="flex gap-2">
            <button type="button" onClick={() => void refetch()} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-muted">
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <Button size="sm" className="rounded-full" onClick={() => navigate('/post-need')}>
              <Plus className="w-4 h-4 mr-1" /> New
            </Button>
          </div>
        </div>

        <div className="px-4 pb-8 space-y-6">
          {isLoading && (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-20 rounded-2xl bg-muted animate-pulse" />
              ))}
            </div>
          )}

          {!isLoading && needs.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
                <Plus className="w-8 h-8 text-muted-foreground" />
              </div>
              <h2 className="font-semibold text-lg mb-2">No requests yet</h2>
              <p className="text-sm text-muted-foreground mb-6 max-w-xs">
                Post your first need and get matched with verified helpers in your community.
              </p>
              <Button onClick={() => navigate('/post-need')} className="rounded-full px-6">
                Post a Need
              </Button>
            </div>
          )}

          {!isLoading && active.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Active ({active.length})</h2>
              <div className="space-y-2">
                {active.map((need) => (
                  <button key={need.id} type="button" className="w-full text-left" onClick={() => navigate(`/needs/${need.id}`)}>
                    <NeedCard need={need} />
                  </button>
                ))}
              </div>
            </section>
          )}

          {!isLoading && resolved.length > 0 && (
            <section>
              <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">Past ({resolved.length})</h2>
              <div className="space-y-2">
                {resolved.map((need) => (
                  <button key={need.id} type="button" className="w-full text-left" onClick={() => navigate(`/needs/${need.id}`)}>
                    <NeedCard need={need} />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </AppShell>
  );
}

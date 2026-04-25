import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, Heart, CheckCircle, TrendingUp, Activity, Shield, Bot, RefreshCw, Loader } from 'lucide-react';
import { adminApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { AppShell } from '@/components/layout/AppShell';

interface StatCardProps { label: string; value: string | number; icon: React.ComponentType<{ className?: string }>; color: string; }
function StatCard({ label, value, icon: Icon, color }: StatCardProps) {
  return (
    <div className="p-4 bg-card rounded-2xl border border-border">
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center mb-3 ${color}`}>
        <Icon className="w-4.5 h-4.5" />
      </div>
      <p className="text-2xl font-bold mb-0.5">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

export default function AdminDashboard() {
  const { toast } = useToast();
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiAnswer,   setAiAnswer]   = useState('');
  const [aiLoading,  setAiLoading]  = useState(false);

  const { data: dash, isLoading, refetch } = useQuery({
    queryKey: ['admin-dashboard'],
    queryFn:  () => adminApi.dashboard(),
    refetchInterval: 30_000,
  });

  const { data: health } = useQuery({
    queryKey: ['system-health'],
    queryFn:  () => adminApi.health(),
    refetchInterval: 60_000,
  });

  async function askAI() {
    if (!aiQuestion.trim()) return;
    setAiLoading(true);
    try {
      const { answer } = await adminApi.aiAssistant(aiQuestion);
      setAiAnswer(answer);
    } catch (err: unknown) {
      toast({ title: 'AI error', description: err instanceof Error ? err.message : 'Try again.', variant: 'destructive' });
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <AppShell>
      <div className="flex flex-col h-full bg-background overflow-y-auto">
        <div className="px-4 pt-12 pb-4 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">Admin</h1>
            <p className="text-xs text-muted-foreground">Platform overview</p>
          </div>
          <button type="button" onClick={() => void refetch()} className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-muted">
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        <div className="px-4 pb-8 space-y-5">
          {isLoading ? (
            <div className="flex justify-center py-10"><Loader className="w-8 h-8 animate-spin text-primary" /></div>
          ) : (
            <>
              {/* Stats grid */}
              <div className="grid grid-cols-2 gap-3">
                <StatCard label="Needs today"      value={dash?.needsToday ?? 0}       icon={Heart}        color="bg-red-100 text-red-600"    />
                <StatCard label="Total needs"       value={dash?.needsTotal ?? 0}        icon={TrendingUp}   color="bg-blue-100 text-blue-600"  />
                <StatCard label="Resolved"          value={dash?.needsResolved ?? 0}     icon={CheckCircle}  color="bg-green-100 text-green-600"/>
                <StatCard label="Resolution rate"   value={`${dash?.resolutionRate ?? 0}%`} icon={Activity}  color="bg-teal-100 text-teal-600"  />
                <StatCard label="Active helpers"    value={dash?.activeHelpers ?? 0}     icon={Users}        color="bg-violet-100 text-violet-600"/>
                <StatCard label="Pending approvals" value={dash?.pendingApprovals ?? 0}  icon={Shield}       color="bg-amber-100 text-amber-600" />
              </div>

              {/* Top helpers */}
              {dash?.topHelpers && dash.topHelpers.length > 0 && (
                <div className="p-4 bg-card rounded-2xl border border-border">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Top Helpers</p>
                  <div className="space-y-2">
                    {dash.topHelpers.map((h, i) => (
                      <div key={i} className="flex items-center gap-3">
                        <div className="w-6 h-6 rounded-full bg-muted flex items-center justify-center text-xs font-bold">{i + 1}</div>
                        <span className="text-sm flex-1">{h.name}</span>
                        <span className="text-sm font-medium text-green-600">{h.resolutionRate}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* System health */}
              {health && (
                <div className="p-4 bg-card rounded-2xl border border-border">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">System Health</p>
                  <div className="space-y-2">
                    {Object.entries(health).map(([key, val]) => (
                      <div key={key} className="flex items-center justify-between">
                        <span className="text-sm capitalize">{key}</span>
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${(val as { status: string }).status === 'ok' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {(val as { status: string }).status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* AI assistant */}
              <div className="p-4 bg-card rounded-2xl border border-border">
                <div className="flex items-center gap-2 mb-3">
                  <Bot className="w-4 h-4 text-primary" />
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">AI Assistant</p>
                </div>
                <textarea
                  rows={2}
                  value={aiQuestion}
                  onChange={(e) => setAiQuestion(e.target.value)}
                  placeholder="Ask about needs, helpers, trends…"
                  className="w-full text-sm p-3 rounded-xl border border-border bg-muted resize-none focus:outline-none focus:ring-2 focus:ring-primary/50 mb-2"
                />
                <Button size="sm" className="w-full rounded-xl" onClick={() => void askAI()} disabled={!aiQuestion.trim() || aiLoading}>
                  {aiLoading ? <><Loader className="w-4 h-4 animate-spin mr-2" />Thinking…</> : 'Ask AI'}
                </Button>
                {aiAnswer && (
                  <div className="mt-3 p-3 bg-primary/5 rounded-xl border border-primary/20 text-sm text-muted-foreground">
                    {aiAnswer}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </AppShell>
  );
}

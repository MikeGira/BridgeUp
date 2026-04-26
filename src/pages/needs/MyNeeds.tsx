import { useLocation } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Plus, RefreshCw, Sparkles } from 'lucide-react';
import { needsApi } from '@/lib/api';
import { AppShell } from '@/components/layout/AppShell';
import { NeedCard } from '@/components/needs/NeedCard';

export default function MyNeeds() {
  const [, navigate] = useLocation();

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['my-needs'],
    queryFn:  () => needsApi.myNeeds(),
    refetchInterval: 30_000,
  });

  const needs    = data?.needs ?? [];
  const active   = needs.filter((n) => !['resolved', 'closed', 'cancelled'].includes(n.status));
  const resolved = needs.filter((n) => ['resolved', 'closed'].includes(n.status));

  return (
    <AppShell>
      <div style={{ minHeight: '100%', background: '#f4f4f6', overflowY: 'auto', fontFamily: 'Inter, system-ui, sans-serif' }}>
        <div className="bu-page" style={{ padding: '0 16px 40px' }}>

          {/* ── Header ── */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '48px 0 20px', gap: 10 }}>
            <h1 style={{ flex: 1, margin: 0, fontSize: 26, fontWeight: 800, color: '#111827', letterSpacing: '-0.5px' }}>
              My Requests
            </h1>
            <button
              type="button"
              onClick={() => void refetch()}
              style={{ width: 36, height: 36, borderRadius: '50%', border: 'none', background: '#e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
              <RefreshCw style={{ width: 16, height: 16, color: '#374151', animation: isLoading ? 'spin 1s linear infinite' : 'none' }} />
            </button>
            <button
              type="button"
              onClick={() => navigate('/post-need')}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px',
                borderRadius: 22, border: 'none', background: '#111827', color: '#fff',
                fontSize: 13, fontWeight: 700, cursor: 'pointer',
              }}
            >
              <Plus style={{ width: 15, height: 15 }} />
              New
            </button>
          </div>

          {/* ── Loading skeletons ── */}
          {isLoading && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {[1, 2, 3].map((i) => (
                <div key={i} style={{ height: 100, borderRadius: 18, background: '#e5e7eb', animation: 'pulse 1.5s ease-in-out infinite' }} />
              ))}
            </div>
          )}

          {/* ── Empty state ── */}
          {!isLoading && needs.length === 0 && (
            <div style={{ textAlign: 'center', padding: '60px 20px' }}>
              <div style={{
                width: 72, height: 72, borderRadius: 22, background: '#eff6ff', margin: '0 auto 20px',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Plus style={{ width: 32, height: 32, color: '#2563eb' }} />
              </div>
              <h2 style={{ margin: '0 0 8px', fontSize: 20, fontWeight: 800, color: '#111827' }}>No requests yet</h2>
              <p style={{ margin: '0 0 28px', fontSize: 14, color: '#6b7280', lineHeight: 1.6, maxWidth: 280, marginLeft: 'auto', marginRight: 'auto' }}>
                Post your first need and get matched with verified helpers in your community.
              </p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 260, margin: '0 auto' }}>
                <button
                  type="button"
                  onClick={() => navigate('/post-need')}
                  style={{
                    padding: '13px 24px', borderRadius: 14, border: 'none',
                    background: '#111827', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  }}
                >
                  <Plus style={{ width: 16, height: 16 }} />
                  Post a Need
                </button>
                <button
                  type="button"
                  onClick={() => navigate('/intake')}
                  style={{
                    padding: '13px 24px', borderRadius: 14, border: 'none',
                    background: 'linear-gradient(135deg,#2563eb,#7c3aed)', color: '#fff',
                    fontSize: 14, fontWeight: 700, cursor: 'pointer',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  }}
                >
                  <Sparkles style={{ width: 16, height: 16 }} />
                  Ask AI Assistant
                </button>
              </div>
            </div>
          )}

          {/* ── Active requests ── */}
          {!isLoading && active.length > 0 && (
            <div style={{ marginBottom: 28 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <p style={{ margin: 0, fontSize: 11, fontWeight: 800, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Active
                </p>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: '#dbeafe', color: '#1e40af' }}>
                  {active.length}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {active.map((need) => (
                  <button
                    key={need.id}
                    type="button"
                    onClick={() => navigate(`/needs/${need.id}`)}
                    style={{ all: 'unset', cursor: 'pointer', display: 'block' }}
                  >
                    <NeedCard need={need} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* ── Past requests ── */}
          {!isLoading && resolved.length > 0 && (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <p style={{ margin: 0, fontSize: 11, fontWeight: 800, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                  Past
                </p>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99, background: '#f3f4f6', color: '#6b7280' }}>
                  {resolved.length}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {resolved.map((need) => (
                  <button
                    key={need.id}
                    type="button"
                    onClick={() => navigate(`/needs/${need.id}`)}
                    style={{ all: 'unset', cursor: 'pointer', display: 'block', opacity: 0.75 }}
                  >
                    <NeedCard need={need} />
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
      <style>{`@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}`}</style>
    </AppShell>
  );
}

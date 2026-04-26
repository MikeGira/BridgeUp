import { useState, useRef, useEffect } from 'react';
import { useLocation } from 'wouter';
import {
  ChevronLeft, Send, Loader2, CheckCircle, MapPin,
  Star, Phone, Navigation, MessageCircle, Car,
  UtensilsCrossed, Home, Briefcase, Heart, GraduationCap, Banknote, HelpCircle,
  Sparkles, X,
} from 'lucide-react';
import { agentApi } from '@/lib/api';
import type { AgentHelper, AgentAction } from '@/lib/api';
import { AppShell } from '@/components/layout/AppShell';

const SESSION_ID = crypto.randomUUID();

// ─── Category colours ─────────────────────────────────────────────────────────
const CAT_META: Record<string, { icon: React.ComponentType<{ style?: React.CSSProperties }>; color: string; bg: string }> = {
  food:       { icon: UtensilsCrossed, color: '#ea580c', bg: '#fff4ed' },
  housing:    { icon: Home,            color: '#2563eb', bg: '#eff6ff' },
  employment: { icon: Briefcase,       color: '#7c3aed', bg: '#f5f3ff' },
  medical:    { icon: Heart,           color: '#e11d48', bg: '#fff1f2' },
  training:   { icon: GraduationCap,   color: '#0d9488', bg: '#f0fdfa' },
  funding:    { icon: Banknote,        color: '#16a34a', bg: '#f0fdf4' },
  other:      { icon: HelpCircle,      color: '#6b7280', bg: '#f9fafb' },
};

// ─── Message types ────────────────────────────────────────────────────────────
interface ChatMessage {
  role:    'user' | 'assistant';
  content: string;
  action?: AgentAction;
  data?:   unknown;
  ts:      string;
}

// ─── Helper card rendered inline inside the chat ──────────────────────────────
function HelperCard({ helper, onContact }: { helper: AgentHelper; onContact: (h: AgentHelper) => void }) {
  const topCat = helper.help_types?.[0] || 'other';
  const meta   = CAT_META[topCat] || CAT_META.other;
  const Icon   = meta.icon;
  const name   = helper.organization || helper.user?.display_name || 'Community Helper';

  const googleMapsUrl = helper.location_lat
    ? `https://maps.google.com/maps?daddr=${helper.location_lat},${helper.location_lng}`
    : null;

  return (
    <div style={{
      background: '#ffffff',
      border: '1px solid #e5e7eb',
      borderRadius: 16,
      overflow: 'hidden',
      marginBottom: 10,
      boxShadow: '0 1px 6px rgba(0,0,0,0.07)',
    }}>
      {/* Top row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '14px 14px 10px' }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12, flexShrink: 0,
          background: meta.bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon style={{ width: 22, height: 22, color: meta.color }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 14, color: '#111827' }}>{name}</span>
            {helper.is_online && (
              <span style={{ fontSize: 10, fontWeight: 700, color: '#16a34a', background: '#dcfce7', borderRadius: 99, padding: '2px 7px' }}>
                ONLINE
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
            {helper.rating > 0 && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 12, color: '#92400e' }}>
                <Star style={{ width: 12, height: 12, fill: '#f59e0b', color: '#f59e0b' }} />
                {helper.rating.toFixed(1)}
              </span>
            )}
            {helper.total_resolved > 0 && (
              <span style={{ fontSize: 12, color: '#6b7280' }}>{helper.total_resolved} helped</span>
            )}
            {helper.location_address && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 12, color: '#6b7280' }}>
                <MapPin style={{ width: 11, height: 11 }} />
                {helper.location_address.split(',')[0]}
              </span>
            )}
          </div>
          {/* Category badges */}
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 6 }}>
            {helper.help_types.slice(0, 3).map((t) => (
              <span key={t} style={{
                fontSize: 10, fontWeight: 600, color: (CAT_META[t] || CAT_META.other).color,
                background: (CAT_META[t] || CAT_META.other).bg,
                borderRadius: 99, padding: '2px 8px', textTransform: 'capitalize',
              }}>
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 0, borderTop: '1px solid #f3f4f6' }}>
        <button
          type="button"
          onClick={() => onContact(helper)}
          style={{
            flex: 1, padding: '10px 8px', background: '#2563eb', border: 'none', cursor: 'pointer',
            color: '#fff', fontSize: 12, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
            borderBottomLeftRadius: 16,
          }}
        >
          <MessageCircle style={{ width: 13, height: 13 }} />
          Contact on my behalf
        </button>
        {googleMapsUrl && (
          <a
            href={googleMapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              flex: 1, padding: '10px 8px', background: '#f9fafb', border: 'none', textDecoration: 'none',
              color: '#374151', fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5,
              borderTop: '0', borderLeft: '1px solid #f3f4f6', borderBottomRightRadius: 16,
              cursor: 'pointer',
            }}
          >
            <Navigation style={{ width: 13, height: 13, color: '#2563eb' }} />
            Directions
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Completion summary card ──────────────────────────────────────────────────
function CompletionCard({ summary, completedAt, outcome }: { summary: string; completedAt: string; outcome: string }) {
  return (
    <div style={{
      background: '#f0fdf4', border: '1.5px solid #86efac', borderRadius: 16, padding: '14px 16px',
      marginTop: 6,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ width: 28, height: 28, borderRadius: '50%', background: '#dcfce7', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <CheckCircle style={{ width: 16, height: 16, color: '#16a34a' }} />
        </div>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#166534' }}>
          {outcome === 'resolved' ? 'Need resolved!' : outcome === 'partial' ? 'Partially resolved' : 'Referred to service'}
        </span>
        <span style={{ fontSize: 11, color: '#16a34a', marginLeft: 'auto' }}>
          {new Date(completedAt).toLocaleString()}
        </span>
      </div>
      <p style={{ fontSize: 12, color: '#166534', lineHeight: 1.5, margin: 0 }}>{summary}</p>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function IntakeChat() {
  const [, navigate] = useLocation();

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      role: 'assistant',
      content: "Hi! I'm Bridge, your AI assistant. I'm connected to BridgeUp's network of helpers and can find the right support for you — and reach out to them on your behalf.\n\nWhat do you need help with today?",
      ts: new Date().toISOString(),
    },
  ]);
  const [input,   setInput]   = useState('');
  const [loading, setLoading] = useState(false);
  const [done,    setDone]    = useState(false);

  const bottomRef  = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function send(text?: string) {
    const body = (text ?? input).trim();
    if (!body || loading || done) return;

    setMessages((m) => [...m, { role: 'user', content: body, ts: new Date().toISOString() }]);
    setInput('');
    setLoading(true);

    try {
      const res = await agentApi.chat(SESSION_ID, body);

      const msg: ChatMessage = {
        role:    'assistant',
        content: res.reply,
        action:  res.action,
        data:    res.data,
        ts:      new Date().toISOString(),
      };
      setMessages((m) => [...m, msg]);

      if (res.action === 'task_complete') setDone(true);
    } catch {
      setMessages((m) => [...m, {
        role:    'assistant',
        content: 'I had a brief issue — please try again. If this keeps happening, use the form instead.',
        ts:      new Date().toISOString(),
      }]);
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleContactHelper(helper: AgentHelper) {
    const name = helper.organization || helper.user?.display_name || 'this helper';
    const types = helper.help_types.join(', ');
    void send(`Please contact ${name} on my behalf for ${types} assistance.`);
  }

  const suggestedPrompts = [
    'I need food for my family',
    'I need emergency housing',
    'I need help finding a job',
    'I need medical assistance',
  ];

  return (
    <AppShell hideNav>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#f9fafb', overflow: 'hidden' }}>

        {/* ── Header ── */}
        <div style={{
          background: '#ffffff',
          borderBottom: '1px solid #e5e7eb',
          padding: '48px 16px 14px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}>
          <button
            type="button"
            onClick={() => navigate('/home')}
            style={{
              width: 36, height: 36, borderRadius: '50%', border: 'none',
              background: '#f3f4f6', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', flexShrink: 0,
            }}
          >
            <ChevronLeft style={{ width: 18, height: 18, color: '#374151' }} />
          </button>

          {/* Avatar */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <div style={{
              width: 40, height: 40, borderRadius: '50%',
              background: 'linear-gradient(135deg,#2563eb,#7c3aed)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 2px 10px rgba(37,99,235,0.35)',
            }}>
              <Sparkles style={{ width: 20, height: 20, color: '#fff' }} />
            </div>
            <div style={{
              position: 'absolute', bottom: 1, right: 1,
              width: 10, height: 10, borderRadius: '50%',
              background: '#22c55e', border: '2px solid #fff',
            }} />
          </div>

          <div style={{ flex: 1, minWidth: 0 }}>
            <p style={{ margin: 0, fontWeight: 700, fontSize: 15, color: '#111827' }}>Bridge AI</p>
            <p style={{ margin: 0, fontSize: 12, color: '#22c55e', fontWeight: 600 }}>● Online · BridgeUp network</p>
          </div>

          <button
            type="button"
            onClick={() => navigate('/post-need')}
            style={{
              fontSize: 12, fontWeight: 600, color: '#6b7280', background: '#f3f4f6',
              border: 'none', borderRadius: 20, padding: '6px 12px', cursor: 'pointer',
            }}
          >
            Use form
          </button>
        </div>

        {/* ── Messages ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {messages.map((msg, i) => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexDirection: msg.role === 'user' ? 'row-reverse' : 'row', maxWidth: '88%' }}>
                {/* Avatar */}
                {msg.role === 'assistant' && (
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                    background: 'linear-gradient(135deg,#2563eb,#7c3aed)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Sparkles style={{ width: 13, height: 13, color: '#fff' }} />
                  </div>
                )}
                {/* Bubble */}
                <div style={{
                  padding: '10px 14px',
                  borderRadius: msg.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                  background: msg.role === 'user' ? '#2563eb' : '#ffffff',
                  color: msg.role === 'user' ? '#ffffff' : '#111827',
                  fontSize: 14,
                  lineHeight: 1.55,
                  boxShadow: msg.role === 'user' ? 'none' : '0 1px 4px rgba(0,0,0,0.08)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}>
                  {msg.content}
                </div>
              </div>

              {/* Inline action cards */}
              {msg.action === 'helpers_found' && Array.isArray(msg.data) && msg.data.length > 0 && (
                <div style={{ width: '100%', maxWidth: 380, paddingLeft: 36 }}>
                  {(msg.data as AgentHelper[]).map((h) => (
                    <HelperCard key={h.id} helper={h} onContact={handleContactHelper} />
                  ))}
                </div>
              )}

              {msg.action === 'helper_contacted' && msg.data != null && (
                <div style={{
                  maxWidth: 360, paddingLeft: 36,
                  background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 12, padding: '10px 14px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ width: 24, height: 24, borderRadius: '50%', background: '#dbeafe', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Send style={{ width: 12, height: 12, color: '#2563eb' }} />
                    </div>
                    <div>
                      <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: '#1e40af' }}>
                        SMS sent to {(msg.data as { helperName: string }).helperName}
                      </p>
                      <p style={{ margin: '2px 0 0', fontSize: 11, color: '#3b82f6' }}>
                        They've been notified on your behalf
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {msg.action === 'task_complete' && msg.data != null && (
                <div style={{ width: '100%', maxWidth: 380, paddingLeft: 36 }}>
                  <CompletionCard
                    summary={(msg.data as { summary: string; completedAt: string; outcome: string }).summary}
                    completedAt={(msg.data as { summary: string; completedAt: string; outcome: string }).completedAt}
                    outcome={(msg.data as { summary: string; completedAt: string; outcome: string }).outcome}
                  />
                  <button
                    type="button"
                    onClick={() => navigate('/needs')}
                    style={{
                      marginTop: 8, marginLeft: 0, padding: '8px 16px', borderRadius: 20,
                      background: '#2563eb', border: 'none', color: '#fff', fontSize: 12,
                      fontWeight: 700, cursor: 'pointer',
                    }}
                  >
                    View all requests →
                  </button>
                </div>
              )}
            </div>
          ))}

          {/* Loading animation */}
          {loading && (
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
              <div style={{
                width: 28, height: 28, borderRadius: '50%',
                background: 'linear-gradient(135deg,#2563eb,#7c3aed)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Sparkles style={{ width: 13, height: 13, color: '#fff' }} />
              </div>
              <div style={{
                background: '#ffffff', borderRadius: '18px 18px 18px 4px',
                padding: '12px 16px', boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
                display: 'flex', alignItems: 'center', gap: 4,
              }}>
                {[0, 1, 2].map((d) => (
                  <div key={d} style={{
                    width: 7, height: 7, borderRadius: '50%', background: '#94a3b8',
                    animation: 'bridge-bounce 1.2s ease-in-out infinite',
                    animationDelay: `${d * 0.2}s`,
                  }} />
                ))}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* ── Suggested prompts (only when first message) ── */}
        {messages.length === 1 && !loading && (
          <div style={{ padding: '0 16px 10px', display: 'flex', gap: 8, overflowX: 'auto', flexShrink: 0, scrollbarWidth: 'none' }}>
            {suggestedPrompts.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => void send(p)}
                style={{
                  flexShrink: 0, padding: '7px 14px', borderRadius: 99,
                  border: '1.5px solid #e5e7eb', background: '#fff',
                  fontSize: 12, fontWeight: 600, color: '#374151', cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {p}
              </button>
            ))}
          </div>
        )}

        {/* ── Input area ── */}
        {!done && (
          <div style={{
            background: '#ffffff', borderTop: '1px solid #e5e7eb',
            padding: '10px 14px calc(10px + env(safe-area-inset-bottom, 0px)) 14px',
            flexShrink: 0,
          }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
              <textarea
                ref={inputRef}
                rows={1}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
                }}
                placeholder="Tell me what you need…"
                disabled={loading}
                style={{
                  flex: 1, resize: 'none', overflowY: 'hidden',
                  padding: '10px 14px', borderRadius: 22,
                  border: '1.5px solid #e5e7eb', background: '#f9fafb',
                  fontSize: 14, color: '#111827', outline: 'none',
                  fontFamily: 'inherit', lineHeight: 1.4,
                  transition: 'border-color 0.15s',
                  minHeight: 42,
                }}
                onFocus={(e) => (e.target.style.borderColor = '#2563eb')}
                onBlur={(e)  => (e.target.style.borderColor = '#e5e7eb')}
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={!input.trim() || loading}
                style={{
                  width: 42, height: 42, borderRadius: '50%', border: 'none',
                  background: input.trim() && !loading ? '#2563eb' : '#e5e7eb',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  cursor: input.trim() && !loading ? 'pointer' : 'default',
                  flexShrink: 0, transition: 'background 0.15s',
                }}
              >
                {loading
                  ? <Loader2 style={{ width: 18, height: 18, color: '#94a3b8', animation: 'spin 1s linear infinite' }} />
                  : <Send style={{ width: 17, height: 17, color: input.trim() ? '#fff' : '#94a3b8', marginLeft: 1 }} />}
              </button>
            </div>
            <p style={{ fontSize: 11, color: '#9ca3af', textAlign: 'center', margin: '7px 0 0' }}>
              Your info is private · Bridge AI may contact helpers on your behalf
            </p>
          </div>
        )}

        {/* Done state */}
        {done && (
          <div style={{
            background: '#fff', borderTop: '1px solid #e5e7eb',
            padding: '14px 16px calc(14px + env(safe-area-inset-bottom, 0px)) 16px',
            textAlign: 'center', flexShrink: 0,
          }}>
            <p style={{ margin: '0 0 10px', fontSize: 13, color: '#6b7280' }}>
              Your request has been resolved and recorded.
            </p>
            <button
              type="button"
              onClick={() => navigate('/home')}
              style={{
                padding: '10px 28px', borderRadius: 99, border: 'none',
                background: '#2563eb', color: '#fff', fontSize: 13,
                fontWeight: 700, cursor: 'pointer',
              }}
            >
              Back to home
            </button>
          </div>
        )}
      </div>

      {/* Bounce animation for loading dots */}
      <style>{`
        @keyframes bridge-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.5; }
          30%            { transform: translateY(-5px); opacity: 1; }
        }
        @keyframes spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
      `}</style>
    </AppShell>
  );
}

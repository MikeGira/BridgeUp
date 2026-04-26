import { Clock, MapPin, CheckCircle, Loader, Navigation, UtensilsCrossed, Home, Briefcase, Heart, GraduationCap, Banknote, HelpCircle } from 'lucide-react';
import type { Need } from '@/lib/api';

// ─── Metadata ────────────────────────────────────────────────────────────────
const CAT: Record<string, { icon: React.ComponentType<{ style?: React.CSSProperties }>; label: string; color: string; bg: string }> = {
  food:       { icon: UtensilsCrossed, label: 'Food',       color: '#ea580c', bg: '#fff4ed' },
  housing:    { icon: Home,            label: 'Housing',    color: '#2563eb', bg: '#eff6ff' },
  employment: { icon: Briefcase,       label: 'Employment', color: '#7c3aed', bg: '#f5f3ff' },
  medical:    { icon: Heart,           label: 'Medical',    color: '#e11d48', bg: '#fff1f2' },
  training:   { icon: GraduationCap,   label: 'Training',   color: '#0d9488', bg: '#f0fdfa' },
  funding:    { icon: Banknote,        label: 'Funding',    color: '#16a34a', bg: '#f0fdf4' },
  other:      { icon: HelpCircle,      label: 'Other',      color: '#6b7280', bg: '#f9fafb' },
};

const STATUS: Record<string, { label: string; dot: string; text: string; bg: string; icon: React.ComponentType<{ style?: React.CSSProperties }> }> = {
  pending_match: { label: 'Searching',   dot: '#f59e0b', text: '#92400e', bg: '#fef3c7', icon: Clock       },
  matching:      { label: 'Matching…',   dot: '#3b82f6', text: '#1e40af', bg: '#dbeafe', icon: Loader      },
  matched:       { label: 'Matched!',    dot: '#22c55e', text: '#166534', bg: '#dcfce7', icon: CheckCircle },
  in_progress:   { label: 'In progress', dot: '#14b8a6', text: '#0f766e', bg: '#ccfbf1', icon: Navigation  },
  resolved:      { label: 'Resolved',    dot: '#9ca3af', text: '#6b7280', bg: '#f3f4f6', icon: CheckCircle },
  closed:        { label: 'Closed',      dot: '#9ca3af', text: '#6b7280', bg: '#f3f4f6', icon: CheckCircle },
  cancelled:     { label: 'Cancelled',   dot: '#f87171', text: '#991b1b', bg: '#fee2e2', icon: HelpCircle  },
};

const URGENCY_DOT: Record<string, string> = {
  immediate: '#ef4444',
  days:      '#f59e0b',
  weeks:     '#22c55e',
};

function timeAgo(d: string): string {
  const m = Math.floor((Date.now() - new Date(d).getTime()) / 60000);
  if (m < 1)  return 'Just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface NeedCardProps { need: Need; compact?: boolean }

export function NeedCard({ need, compact = false }: NeedCardProps) {
  const cat    = CAT[need.category]    ?? CAT.other;
  const status = STATUS[need.status]   ?? STATUS.pending_match;
  const Icon   = cat.icon;
  const SIcon  = status.icon;
  const urgDot = URGENCY_DOT[need.urgency] ?? '#f59e0b';

  /* ── Compact (used in Home bottom sheet) ── */
  if (compact) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '12px 14px', background: '#fff', borderRadius: 14,
        boxShadow: '0 1px 6px rgba(0,0,0,0.07)', border: '1px solid #f3f4f6',
      }}>
        <div style={{
          width: 38, height: 38, borderRadius: 10, flexShrink: 0,
          background: cat.bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <Icon style={{ width: 18, height: 18, color: cat.color }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#111827' }}>{cat.label}</span>
            <span style={{
              fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 99,
              background: status.bg, color: status.text,
              display: 'flex', alignItems: 'center', gap: 3,
            }}>
              <SIcon style={{ width: 9, height: 9 }} />{status.label}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: 12, color: '#6b7280', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {need.description}
          </p>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3, flexShrink: 0 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: urgDot }} />
          <span style={{ fontSize: 11, color: '#9ca3af' }}>{timeAgo(need.createdAt)}</span>
        </div>
      </div>
    );
  }

  /* ── Full card (used in MyNeeds list) ── */
  return (
    <div style={{
      background: '#fff', borderRadius: 18,
      boxShadow: '0 2px 12px rgba(0,0,0,0.07)',
      overflow: 'hidden',
      fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      {/* Top band with category color */}
      <div style={{ height: 4, background: cat.color, opacity: 0.7 }} />

      <div style={{ padding: '14px 16px' }}>
        {/* Row 1: icon + category + status */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 12, flexShrink: 0,
            background: cat.bg, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <Icon style={{ width: 20, height: 20, color: cat.color }} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#111827' }}>{cat.label}</span>
          </div>
          <span style={{
            fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 99,
            background: status.bg, color: status.text,
            display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0,
          }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: status.dot, flexShrink: 0 }} />
            {status.label}
          </span>
        </div>

        {/* Description */}
        <p style={{
          margin: '0 0 10px', fontSize: 13, color: '#374151', lineHeight: 1.5,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
        }}>
          {need.description}
        </p>

        {/* Footer: location + urgency + time */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {need.location && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: '#9ca3af', flex: 1, minWidth: 0 }}>
              <MapPin style={{ width: 12, height: 12, flexShrink: 0 }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {need.location}
              </span>
            </span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9ca3af' }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: urgDot }} />
              {need.urgency === 'immediate' ? 'Urgent' : need.urgency === 'days' ? 'In days' : 'Flexible'}
            </div>
            <span style={{ fontSize: 11, color: '#d1d5db' }}>·</span>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>{timeAgo(need.createdAt)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

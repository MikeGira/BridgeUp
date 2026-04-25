import { Clock, MapPin, CheckCircle, Loader, Navigation, UtensilsCrossed, Home, Briefcase, Heart, GraduationCap, Banknote, HelpCircle } from 'lucide-react';
import type { Need } from '@/lib/api';
import { Badge } from '@/components/ui/badge';

const CATEGORY_META: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string; bg: string }> = {
  food:       { icon: UtensilsCrossed, label: 'Food',       bg: 'bg-orange-100 text-orange-700' },
  housing:    { icon: Home,            label: 'Housing',    bg: 'bg-blue-100 text-blue-700'     },
  employment: { icon: Briefcase,       label: 'Employment', bg: 'bg-violet-100 text-violet-700' },
  medical:    { icon: Heart,           label: 'Medical',    bg: 'bg-red-100 text-red-700'       },
  training:   { icon: GraduationCap,   label: 'Training',   bg: 'bg-teal-100 text-teal-700'    },
  funding:    { icon: Banknote,        label: 'Funding',    bg: 'bg-green-100 text-green-700'   },
  other:      { icon: HelpCircle,      label: 'Other',      bg: 'bg-gray-100 text-gray-600'     },
};

const STATUS_META: Record<string, { label: string; color: string; icon: React.ComponentType<{ className?: string }> }> = {
  pending_match: { label: 'Searching…',  color: 'bg-amber-100 text-amber-700',  icon: Clock       },
  matching:      { label: 'Matching…',   color: 'bg-blue-100 text-blue-700',    icon: Loader      },
  matched:       { label: 'Matched!',    color: 'bg-green-100 text-green-700',  icon: CheckCircle },
  in_progress:   { label: 'In progress', color: 'bg-teal-100 text-teal-700',    icon: Navigation  },
  resolved:      { label: 'Resolved',    color: 'bg-gray-100 text-gray-500',    icon: CheckCircle },
  closed:        { label: 'Closed',      color: 'bg-gray-100 text-gray-500',    icon: CheckCircle },
  cancelled:     { label: 'Cancelled',   color: 'bg-red-100 text-red-500',      icon: HelpCircle  },
};

const URGENCY_META: Record<string, { label: string; dot: string }> = {
  immediate: { label: 'Urgent', dot: 'bg-red-500'   },
  days:      { label: 'Days',   dot: 'bg-amber-500' },
  weeks:     { label: 'Weeks',  dot: 'bg-green-500' },
};

interface NeedCardProps {
  need:    Need;
  compact?: boolean;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1)  return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function NeedCard({ need, compact = false }: NeedCardProps) {
  const cat    = CATEGORY_META[need.category] || CATEGORY_META.other;
  const status = STATUS_META[need.status]     || STATUS_META.pending_match;
  const urgency = URGENCY_META[need.urgency]  || URGENCY_META.days;
  const Icon   = cat.icon;
  const StatusIcon = status.icon;

  if (compact) {
    return (
      <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-xl border border-border/50 hover:bg-muted transition-colors">
        <div className={`w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0 ${cat.bg}`}>
          <Icon className="w-4.5 h-4.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-sm font-medium capitalize">{cat.label}</span>
            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ${status.color}`}>
              <StatusIcon className="w-3 h-3" />
              {status.label}
            </span>
          </div>
          <p className="text-xs text-muted-foreground truncate">{need.description}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-1">
            <div className={`w-1.5 h-1.5 rounded-full ${urgency.dot}`} />
            <span className="text-xs text-muted-foreground">{urgency.label}</span>
          </div>
          <span className="text-xs text-muted-foreground">{timeAgo(need.createdAt)}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 bg-card rounded-2xl border border-border shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start gap-3 mb-3">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${cat.bg}`}>
          <Icon className="w-5 h-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <span className="font-semibold capitalize">{cat.label}</span>
            <Badge className={`text-xs ${status.color} border-0`}>
              <StatusIcon className="w-3 h-3 mr-1" />
              {status.label}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground line-clamp-2">{need.description}</p>
        </div>
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground">
        {need.location && (
          <span className="flex items-center gap-1 truncate">
            <MapPin className="w-3 h-3 flex-shrink-0" />
            {need.location}
          </span>
        )}
        <span className="flex items-center gap-1 ml-auto flex-shrink-0">
          <div className={`w-1.5 h-1.5 rounded-full ${urgency.dot}`} />
          {urgency.label}
        </span>
        <span className="flex-shrink-0">{timeAgo(need.createdAt)}</span>
      </div>
    </div>
  );
}

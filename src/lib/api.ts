const BASE = '/api';

function getToken(): string | null {
  return localStorage.getItem('bridgeup_token');
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  auth = true
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({ error: 'Invalid server response' }));

  if (!res.ok) {
    const message = data?.error || `Request failed (${res.status})`;
    const err = new Error(message) as Error & { status: number };
    err.status = res.status;
    throw err;
  }

  return data as T;
}

export const api = {
  get:    <T>(path: string) => request<T>('GET',    path),
  post:   <T>(path: string, body?: unknown, auth = true) => request<T>('POST',   path, body, auth),
  patch:  <T>(path: string, body?: unknown) => request<T>('PATCH',  path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const authApi = {
  sendOtp:   (phone: string) => api.post<{ success: boolean; expiresInMinutes: number; attemptsLeft: number }>('/auth/send-otp', { phone }, false),
  verifyOtp: (phone: string, code: string) => api.post<{ success: boolean; token: string; user: User; isNewUser: boolean }>('/auth/verify-otp', { phone, code }, false),
  me:        () => api.get<{ user: User }>('/auth/me'),
  updateMe:  (data: Partial<User>) => api.patch<{ success: boolean; user: User }>('/auth/me', data),
  logout:    () => api.post<{ success: boolean }>('/auth/logout'),
};

// ─── Needs ────────────────────────────────────────────────────────────────────
export const needsApi = {
  list:     (params?: Record<string, string>) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : '';
    return api.get<{ needs: Need[]; nextCursor?: string }>('/needs' + qs);
  },
  myNeeds:  () => api.get<{ needs: Need[] }>('/needs/my'),
  get:      (id: string) => api.get<{ need: Need }>(`/needs/${id}`),
  create:   (data: CreateNeedInput) => api.post<{ success: boolean; needId: string }>('/needs', data),
  updateStatus: (id: string, status: string, reason?: string) => api.patch<{ success: boolean }>(`/needs/${id}/status`, { status, reason }),
  intake:   (sessionId: string, message: string) => api.post<IntakeResponse>('/needs/intake/message', { sessionId, message }, false),
};

// ─── Matches ──────────────────────────────────────────────────────────────────
export const matchesApi = {
  list:    () => api.get<{ matches: Match[] }>('/matching/matches'),
  get:     (id: string) => api.get<{ match: Match }>(`/matching/matches/${id}`),
  accept:  (id: string) => api.patch<{ success: boolean }>(`/matching/matches/${id}/accept`),
  decline: (id: string, reason?: string) => api.patch<{ success: boolean }>(`/matching/matches/${id}/decline`, { reason }),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
export const helpersApi = {
  list:     () => api.get<{ helpers: Helper[] }>('/helpers'),
  register: (data: unknown) => api.post<{ success: boolean }>('/helpers/register', data),
};

// ─── Admin ────────────────────────────────────────────────────────────────────
export const adminApi = {
  dashboard:  () => api.get<AdminDashboard>('/admin/dashboard'),
  health:     () => api.get<SystemHealth>('/admin/system-health'),
  auditLog:   (cursor?: string) => api.get<{ entries: AuditEntry[]; nextCursor?: string }>(`/admin/audit-log${cursor ? '?cursor=' + cursor : ''}`),
  aiAssistant: (question: string) => api.post<{ answer: string }>('/admin/ai-assistant', { question }),
};

// ─── Types ────────────────────────────────────────────────────────────────────
export interface User {
  id:          string;
  phone:       string;
  role:        'user' | 'helper' | 'admin' | 'ngo' | 'superadmin';
  tenantId:    string | null;
  country:     string | null;
  language:    string;
  displayName: string | null;
  avatarUrl:   string | null;
  bio:         string | null;
  verified:    boolean;
  active:      boolean;
  memberSince?: string;
  lastLoginAt?: string;
}

export interface Need {
  id:           string;
  userId:       string | null;
  tenantId:     string | null;
  phone:        string | null;
  category:     NeedCategory;
  description:  string;
  location:     string | null;
  locationLat:  number | null;
  locationLng:  number | null;
  urgency:      'immediate' | 'days' | 'weeks';
  status:       NeedStatus;
  channel:      string;
  language:     string;
  statusHistory: StatusHistoryEntry[];
  createdAt:    string;
  updatedAt:    string;
}

export type NeedCategory = 'food' | 'housing' | 'employment' | 'medical' | 'training' | 'funding' | 'other';
export type NeedStatus   = 'pending_match' | 'matching' | 'matched' | 'in_progress' | 'resolved' | 'closed' | 'cancelled';

export interface StatusHistoryEntry {
  from:      string;
  to:        string;
  by:        string;
  role:      string;
  reason?:   string;
  changedAt: string;
}

export interface Match {
  id:         string;
  needId:     string;
  helperId:   string;
  userId:     string | null;
  userPhone:  string | null;
  tenantId:   string | null;
  status:     'pending' | 'accepted' | 'declined' | 'in_progress' | 'resolved' | 'cancelled';
  score:      number;
  distanceKm: number | null;
  notes:      string | null;
  acceptedAt: string | null;
  declinedAt: string | null;
  resolvedAt: string | null;
  createdAt:  string;
  need?:      Need;
  helper?:    Helper;
}

export interface Helper {
  id:              string;
  userId:          string;
  tenantId:        string | null;
  organization:    string | null;
  helpTypes:       string[];
  locationLat:     number | null;
  locationLng:     number | null;
  locationAddress: string | null;
  serviceRadiusKm: number;
  status:          'pending' | 'approved' | 'rejected' | 'suspended';
  isOnline:        boolean;
  rating:          number;
  totalResolved:   number;
  totalAssigned:   number;
  user?:           User;
}

export interface CreateNeedInput {
  phone?:       string;
  category:     NeedCategory;
  description:  string;
  location?:    string;
  locationLat?: number;
  locationLng?: number;
  urgency:      'immediate' | 'days' | 'weeks';
}

export interface IntakeResponse {
  reply:      string;
  isComplete: boolean;
  needId?:    string;
  turn:       number;
}

export interface AdminDashboard {
  needsToday:        number;
  needsTotal:        number;
  needsResolved:     number;
  resolutionRate:    number;
  activeHelpers:     number;
  pendingApprovals:  number;
  flaggedAccounts:   number;
  topHelpers:        { name: string; resolutionRate: number }[];
}

export interface SystemHealth {
  api:      { status: string };
  database: { status: string };
  sms:      { status: string; balance?: string };
  payments: { status: string; info?: string };
}

export interface AuditEntry {
  id:        string;
  action:    string;
  actorId:   string | null;
  targetId:  string | null;
  tenantId:  string | null;
  meta:      Record<string, unknown>;
  createdAt: string;
}

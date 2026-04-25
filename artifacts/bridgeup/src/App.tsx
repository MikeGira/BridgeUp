import { useEffect, Suspense, lazy } from 'react';
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from 'wouter';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuthStore } from '@/store/auth';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } },
});

const AuthPhone   = lazy(() => import('@/pages/auth/AuthPhone'));
const AuthOtp     = lazy(() => import('@/pages/auth/AuthOtp'));
const Home        = lazy(() => import('@/pages/home/Home'));
const PostNeed    = lazy(() => import('@/pages/post-need/PostNeed'));
const IntakeChat  = lazy(() => import('@/pages/intake/IntakeChat'));
const MyNeeds     = lazy(() => import('@/pages/needs/MyNeeds'));
const NeedDetail  = lazy(() => import('@/pages/needs/NeedDetail'));
const Matches     = lazy(() => import('@/pages/matches/Matches'));
const MatchDetail = lazy(() => import('@/pages/matches/MatchDetail'));
const Profile     = lazy(() => import('@/pages/profile/Profile'));
const AdminDash   = lazy(() => import('@/pages/admin/AdminDashboard'));
const NotFound    = lazy(() => import('@/pages/not-found'));

function ProtectedRoute({ component: Component, roles }: { component: React.ComponentType; roles?: string[] }) {
  const { user, isInitialized } = useAuthStore();
  const [, navigate] = useLocation();
  if (!isInitialized) return <PageLoader />;
  if (!user) { navigate('/login'); return null; }
  if (roles && !roles.includes(user.role)) return <Redirect to="/home" />;
  return <Component />;
}

function PageLoader() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="w-12 h-12 rounded-2xl bg-primary flex items-center justify-center animate-pulse">
          <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        <p className="text-sm text-muted-foreground">Loading BridgeUp...</p>
      </div>
    </div>
  );
}

function AppInitializer({ children }: { children: React.ReactNode }) {
  const { refresh, isInitialized } = useAuthStore();
  useEffect(() => { refresh(); }, [refresh]);
  if (!isInitialized) return <PageLoader />;
  return <>{children}</>;
}

function Router() {
  const { user } = useAuthStore();
  return (
    <Suspense fallback={<PageLoader />}>
      <Switch>
        <Route path="/">{user ? <Redirect to="/home" /> : <Redirect to="/login" />}</Route>
        <Route path="/login" component={AuthPhone} />
        <Route path="/verify" component={AuthOtp} />
        <Route path="/home"><ProtectedRoute component={Home} /></Route>
        <Route path="/post-need"><ProtectedRoute component={PostNeed} /></Route>
        <Route path="/intake"><ProtectedRoute component={IntakeChat} /></Route>
        <Route path="/needs"><ProtectedRoute component={MyNeeds} /></Route>
        <Route path="/needs/:id"><ProtectedRoute component={NeedDetail} /></Route>
        <Route path="/matches"><ProtectedRoute component={Matches} /></Route>
        <Route path="/matches/:id"><ProtectedRoute component={MatchDetail} /></Route>
        <Route path="/profile"><ProtectedRoute component={Profile} /></Route>
        <Route path="/admin"><ProtectedRoute component={AdminDash} roles={['admin', 'superadmin']} /></Route>
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, '') || ''}>
          <AppInitializer>
            <Router />
          </AppInitializer>
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

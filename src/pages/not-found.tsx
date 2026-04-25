import { useLocation } from 'wouter';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';

export default function NotFound() {
  const [, navigate] = useLocation();
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background px-6 text-center">
      <div className="w-24 h-24 rounded-3xl bg-muted flex items-center justify-center mb-6 text-5xl">
        🌉
      </div>
      <h1 className="text-6xl font-black text-foreground mb-2">404</h1>
      <p className="text-xl font-semibold mb-2">Page not found</p>
      <p className="text-sm text-muted-foreground mb-8 max-w-xs">
        This page does not exist or has been moved.
      </p>
      <Button className="rounded-full px-6" onClick={() => navigate('/home')}>
        <ArrowLeft className="w-4 h-4 mr-2" />
        Back to home
      </Button>
    </div>
  );
}

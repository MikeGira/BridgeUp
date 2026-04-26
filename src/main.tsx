import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';

createRoot(document.getElementById('root')!).render(<App />);

// Register service worker for PWA install + offline shell caching
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js', { scope: '/' })
      .then((reg) => {
        // Check for updates every time the app loads
        reg.update().catch(() => {});
      })
      .catch((err) => {
        console.warn('[SW] Registration failed:', err);
      });
  });
}

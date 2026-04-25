import { useEffect, useRef } from 'react';
import type { Need } from '@/lib/api';

interface MapViewProps {
  center: { lat: number; lng: number };
  needs?: Need[];
  userLocation?: { lat: number; lng: number } | null;
  zoom?: number;
}

const CATEGORY_COLORS: Record<string, string> = {
  food:       '#f97316',
  housing:    '#3b82f6',
  employment: '#8b5cf6',
  medical:    '#ef4444',
  training:   '#14b8a6',
  funding:    '#22c55e',
  other:      '#6b7280',
};

const URGENCY_SIZES: Record<string, number> = {
  immediate: 18,
  days:      14,
  weeks:     10,
};

declare global {
  interface Window {
    L: typeof import('leaflet');
    bridgeupMap: import('leaflet').Map | null;
  }
}

export function MapView({ center, needs = [], userLocation, zoom = 13 }: MapViewProps) {
  const mapRef     = useRef<HTMLDivElement>(null);
  const leafletMap = useRef<import('leaflet').Map | null>(null);
  const markersRef = useRef<import('leaflet').LayerGroup | null>(null);

  useEffect(() => {
    if (!mapRef.current) return;
    if (leafletMap.current) return;

    // Leaflet is loaded via CDN in index.html
    const L = window.L;
    if (!L) return;

    const map = L.map(mapRef.current, {
      center: [center.lat, center.lng],
      zoom,
      zoomControl: false,
    });

    // CartoDB dark matter tiles (no API key needed)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      subdomains: 'abcd',
      maxZoom: 19,
    }).addTo(map);

    // Zoom control top-right
    L.control.zoom({ position: 'topright' }).addTo(map);

    markersRef.current = L.layerGroup().addTo(map);
    leafletMap.current = map;
    window.bridgeupMap = map;

    return () => {
      map.remove();
      leafletMap.current = null;
      window.bridgeupMap = null;
    };
  }, []);

  // Update center when it changes
  useEffect(() => {
    if (leafletMap.current) {
      leafletMap.current.setView([center.lat, center.lng], zoom, { animate: true });
    }
  }, [center.lat, center.lng, zoom]);

  // Draw need markers
  useEffect(() => {
    if (!leafletMap.current || !markersRef.current) return;
    const L = window.L;
    if (!L) return;

    markersRef.current.clearLayers();

    needs.forEach((need) => {
      if (!need.locationLat || !need.locationLng) return;
      const color = CATEGORY_COLORS[need.category] || '#6b7280';
      const size  = URGENCY_SIZES[need.urgency] || 14;
      const pulse = need.urgency === 'immediate';

      const icon = L.divIcon({
        html: `
          <div style="position:relative;width:${size * 2}px;height:${size * 2}px;">
            ${pulse ? `<div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.3;animation:bridgeup-ping 1.5s ease-in-out infinite;"></div>` : ''}
            <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2.5px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);"></div>
          </div>
        `,
        className: '',
        iconSize:  [size * 2, size * 2],
        iconAnchor:[size, size],
      });

      const marker = L.marker([need.locationLat, need.locationLng], { icon });
      marker.bindPopup(`
        <div style="font-family:sans-serif;min-width:180px">
          <div style="font-weight:600;margin-bottom:4px;text-transform:capitalize">${need.category}</div>
          <div style="font-size:0.85em;color:#666;margin-bottom:6px">${need.description.slice(0, 80)}${need.description.length > 80 ? '...' : ''}</div>
          <div style="font-size:0.75em;color:#999">${need.location || 'Location not specified'}</div>
          <div style="margin-top:8px">
            <a href="/needs/${need.id}" style="color:#3b82f6;font-size:0.85em;text-decoration:none">View details →</a>
          </div>
        </div>
      `);
      markersRef.current!.addLayer(marker);
    });
  }, [needs]);

  // User location marker
  useEffect(() => {
    if (!leafletMap.current || !userLocation) return;
    const L = window.L;
    if (!L) return;

    const icon = L.divIcon({
      html: `
        <div style="position:relative;width:20px;height:20px;">
          <div style="position:absolute;inset:0;border-radius:50%;background:#3b82f6;opacity:0.2;animation:bridgeup-ping 2s ease-in-out infinite;"></div>
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:12px;height:12px;border-radius:50%;background:#3b82f6;border:2.5px solid white;box-shadow:0 2px 6px rgba(59,130,246,0.5);"></div>
        </div>
      `,
      className: '',
      iconSize:  [20, 20],
      iconAnchor:[10, 10],
    });

    L.marker([userLocation.lat, userLocation.lng], { icon })
      .bindTooltip('You are here', { permanent: false })
      .addTo(leafletMap.current);
  }, [userLocation]);

  return (
    <>
      <style>{`
        @keyframes bridgeup-ping {
          0%, 100% { transform: scale(1); opacity: 0.3; }
          50%       { transform: scale(2); opacity: 0; }
        }
      `}</style>
      <div ref={mapRef} className="w-full h-full" />
    </>
  );
}

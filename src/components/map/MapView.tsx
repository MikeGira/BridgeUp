import { useEffect, useRef } from 'react';
import type { Need } from '@/lib/api';

export type TileType = 'standard' | 'satellite';

interface MapViewProps {
  center:       { lat: number; lng: number };
  needs?:       Need[];
  userLocation?: { lat: number; lng: number } | null;
  zoom?:        number;
  tileType?:    TileType;
}

const TILES: Record<TileType, { url: string; attribution: string; opts: Record<string, unknown> }> = {
  standard: {
    url:         'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    opts:        { subdomains: 'abcd', maxZoom: 19 },
  },
  satellite: {
    url:         'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community',
    opts:        { maxZoom: 19 },
  },
};

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

export function MapView({ center, needs = [], userLocation, zoom = 13, tileType = 'standard' }: MapViewProps) {
  const mapRef      = useRef<HTMLDivElement>(null);
  const leafletMap  = useRef<import('leaflet').Map | null>(null);
  const markersRef  = useRef<import('leaflet').LayerGroup | null>(null);
  const tileRef     = useRef<import('leaflet').TileLayer | null>(null);
  const userMarker  = useRef<import('leaflet').Marker | null>(null);

  // ── Init map ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!mapRef.current || leafletMap.current) return;
    const L = window.L;
    if (!L) return;

    const map = L.map(mapRef.current, {
      center: [center.lat, center.lng],
      zoom,
      zoomControl: false,
    });

    const cfg = TILES[tileType];
    tileRef.current = L.tileLayer(cfg.url, { attribution: cfg.attribution, ...cfg.opts }).addTo(map);

    // Zoom control — bottom-right to match Google Maps convention
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    markersRef.current = L.layerGroup().addTo(map);
    leafletMap.current = map;
    window.bridgeupMap = map;

    return () => {
      map.remove();
      leafletMap.current = null;
      tileRef.current    = null;
      userMarker.current = null;
      window.bridgeupMap = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Switch tile layer when tileType changes ──────────────────────────────
  useEffect(() => {
    if (!leafletMap.current) return;
    const L = window.L;
    if (!L) return;

    if (tileRef.current) {
      leafletMap.current.removeLayer(tileRef.current);
    }
    const cfg = TILES[tileType];
    tileRef.current = L.tileLayer(cfg.url, { attribution: cfg.attribution, ...cfg.opts })
      .addTo(leafletMap.current);
  }, [tileType]);

  // ── Pan/zoom to new center ────────────────────────────────────────────────
  useEffect(() => {
    if (leafletMap.current) {
      leafletMap.current.setView([center.lat, center.lng], zoom, { animate: true });
    }
  }, [center.lat, center.lng, zoom]);

  // ── Draw need markers ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!leafletMap.current || !markersRef.current) return;
    const L = window.L;
    if (!L) return;

    markersRef.current.clearLayers();

    needs.forEach((need) => {
      if (!need.locationLat || !need.locationLng) return;
      const color = CATEGORY_COLORS[need.category] || '#6b7280';
      const size  = URGENCY_SIZES[need.urgency]    || 14;
      const pulse = need.urgency === 'immediate';

      const icon = L.divIcon({
        html: `
          <div style="position:relative;width:${size * 2}px;height:${size * 2}px;">
            ${pulse ? `<div style="position:absolute;inset:0;border-radius:50%;background:${color};opacity:0.3;animation:bridgeup-ping 1.5s ease-in-out infinite;"></div>` : ''}
            <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2.5px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.3);"></div>
          </div>`,
        className: '',
        iconSize:  [size * 2, size * 2],
        iconAnchor:[size, size],
      });

      const marker = L.marker([need.locationLat, need.locationLng], { icon });
      marker.bindPopup(`
        <div style="font-family:Inter,sans-serif;min-width:190px;padding:2px">
          <div style="font-weight:700;font-size:14px;text-transform:capitalize;margin-bottom:4px;color:#111">${need.category}</div>
          <div style="font-size:12px;color:#555;margin-bottom:6px;line-height:1.4">${need.description.slice(0, 100)}${need.description.length > 100 ? '…' : ''}</div>
          ${need.location ? `<div style="font-size:11px;color:#888;margin-bottom:8px">📍 ${need.location}</div>` : ''}
          <a href="/needs/${need.id}" style="color:#2563eb;font-size:12px;font-weight:600;text-decoration:none">View details →</a>
        </div>`);
      markersRef.current!.addLayer(marker);
    });
  }, [needs]);

  // ── User location marker ──────────────────────────────────────────────────
  useEffect(() => {
    if (!leafletMap.current || !userLocation) return;
    const L = window.L;
    if (!L) return;

    if (userMarker.current) userMarker.current.remove();

    const icon = L.divIcon({
      html: `
        <div style="position:relative;width:22px;height:22px;">
          <div style="position:absolute;inset:0;border-radius:50%;background:#3b82f6;opacity:0.2;animation:bridgeup-ping 2s ease-in-out infinite;"></div>
          <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:13px;height:13px;border-radius:50%;background:#3b82f6;border:2.5px solid white;box-shadow:0 2px 6px rgba(59,130,246,0.6);"></div>
        </div>`,
      className: '',
      iconSize:  [22, 22],
      iconAnchor:[11, 11],
    });

    userMarker.current = L.marker([userLocation.lat, userLocation.lng], { icon })
      .bindTooltip('You are here', { permanent: false, direction: 'top' })
      .addTo(leafletMap.current);
  }, [userLocation]);

  return (
    <>
      <style>{`
        @keyframes bridgeup-ping {
          0%, 100% { transform: scale(1); opacity: 0.3; }
          50%       { transform: scale(2.2); opacity: 0; }
        }
        /* Style Leaflet zoom buttons to match Google Maps */
        .leaflet-control-zoom a {
          width: 32px !important; height: 32px !important;
          line-height: 32px !important;
          font-size: 18px !important;
          background: #fff !important;
          color: #444 !important;
          border-radius: 4px !important;
          box-shadow: 0 1px 4px rgba(0,0,0,0.2) !important;
        }
        .leaflet-control-zoom a:hover { background: #f5f5f5 !important; }
        .leaflet-control-zoom { border: none !important; }
      `}</style>
      <div ref={mapRef} className="w-full h-full" />
    </>
  );
}

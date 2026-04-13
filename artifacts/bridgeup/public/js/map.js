/* =============================================================
   BridgeUp — map.js
   Full Uber-style Leaflet map interface
   Exposes: window.MapInterface
   ============================================================= */
(function () {
  "use strict";

  // ── Constants ────────────────────────────────────────────────
  const CARTO_TILE_URL =
    "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
  const CARTO_ATTR =
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
  const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
  const DEFAULT_ZOOM = 14;
  const MAX_ZOOM = 19;
  const SEARCH_DEBOUNCE_MS = 300;
  const SEARCH_MAX_LEN = 200;
  const MAX_ROUTE_COORD_DELTA = 180; // sanity cap for lat/lon

  const CATEGORY_COLORS = {
    food: "#F97316",
    employment: "#3B82F6",
    housing: "#16A34A",
    medical: "#EF4444",
    training: "#8B5CF6",
    funding: "#F59E0B",
    legal: "#06B6D4",
    other: "#6B7280",
  };

  // ── State ────────────────────────────────────────────────────
  let map = null;
  let userMarker = null;
  let accuracyCircle = null;
  let clusterGroup = null;
  let routeLayer = null;
  let routeLabel = null;
  let watchId = null;
  let searchTimer = null;
  let currentUserLatLng = null;
  const helperMarkers = new Map(); // helperId → L.Marker

  // ── Sanitize plain text for DOM (XSS safe) ──────────────────
  function sanitizeText(val) {
    if (val === null || val === undefined) return "";
    return String(val).slice(0, 500);
  }

  // ── Validate finite number in range ─────────────────────────
  function validCoord(n, max) {
    return typeof n === "number" && isFinite(n) && Math.abs(n) <= max;
  }

  function validLatLng(lat, lng) {
    return validCoord(lat, 90) && validCoord(lng, 180);
  }

  // ── Haversine distance (km) ──────────────────────────────────
  function calculateDistance(lat1, lon1, lat2, lon2) {
    if (!validLatLng(lat1, lon1) || !validLatLng(lat2, lon2)) return null;
    const R = 6371;
    const dL = ((lat2 - lat1) * Math.PI) / 180;
    const dG = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dL / 2) ** 2 +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dG / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── Estimate travel time ─────────────────────────────────────
  function estimateTime(distKm) {
    if (distKm === null || !isFinite(distKm)) return "";
    if (distKm < 2) {
      const mins = Math.ceil((distKm / 5) * 60);
      return mins + " min walk";
    }
    const mins = Math.ceil((distKm / 40) * 60);
    return mins + " min drive";
  }

  // ── Format distance label ────────────────────────────────────
  function formatDist(distKm) {
    if (distKm === null) return "";
    return distKm < 1
      ? Math.round(distKm * 1000) + " m"
      : distKm.toFixed(1) + " km";
  }

  // ── Build custom user location marker ───────────────────────
  function buildUserIcon() {
    return L.divIcon({
      className: "user-location-marker",
      html: '<div class="user-dot"></div><div class="user-pulse"></div>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
    });
  }

  // ── Build custom helper marker icon ─────────────────────────
  function buildHelperIcon(helper) {
    const cat = (helper.helpTypes && helper.helpTypes[0]) || "other";
    const color = CATEGORY_COLORS[cat] || CATEGORY_COLORS.other;
    const label = sanitizeText(cat.charAt(0).toUpperCase());
    return L.divIcon({
      className: "helper-marker-icon",
      html: `<div class="helper-pin" style="background:${color}">${label}</div>`,
      iconSize: [32, 40],
      iconAnchor: [16, 40],
      popupAnchor: [0, -40],
    });
  }

  // ── Map initialisation ───────────────────────────────────────
  function init() {
    if (map) return;

    map = L.map("map", {
      zoomControl: false,
      tap: true,
      tapTolerance: 15,
      maxZoom: MAX_ZOOM,
      attributionControl: true,
    }).setView([0, 0], 2);

    L.tileLayer(CARTO_TILE_URL, {
      attribution: CARTO_ATTR,
      subdomains: "abcd",
      maxZoom: MAX_ZOOM,
    }).addTo(map);

    L.control.zoom({ position: "bottomright" }).addTo(map);

    // Marker cluster group
    clusterGroup = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 60,
      iconCreateFunction: function (cluster) {
        const count = cluster.getChildCount();
        return L.divIcon({
          html: `<div class="cluster-icon">${count}</div>`,
          className: "cluster-wrapper",
          iconSize: L.point(40, 40),
        });
      },
    });
    map.addLayer(clusterGroup);

    // Collapse bottom sheet when map tapped
    map.on("click", function () {
      const sheet = document.getElementById("bottom-sheet");
      if (sheet) sheet.classList.remove("expanded");
    });

    startGeolocation();
    initSearch();
    initCategoryPills();
  }

  // ── Geolocation ──────────────────────────────────────────────
  function startGeolocation() {
    if (!navigator.geolocation) {
      showSearchPrompt();
      return;
    }

    const opts = {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
    };

    watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, opts);
  }

  function onPosition(pos) {
    const lat = pos.coords.latitude;
    const lng = pos.coords.longitude;
    const acc = pos.coords.accuracy;

    if (!validLatLng(lat, lng)) return;

    currentUserLatLng = L.latLng(lat, lng);

    if (!userMarker) {
      userMarker = L.marker(currentUserLatLng, {
        icon: buildUserIcon(),
        interactive: false,
        zIndexOffset: 1000,
      }).addTo(map);

      accuracyCircle = L.circle(currentUserLatLng, {
        radius: acc,
        color: "#3B82F6",
        fillColor: "#3B82F6",
        fillOpacity: 0.1,
        weight: 1,
        interactive: false,
      }).addTo(map);

      // Fly to user on first fix
      map.flyTo(currentUserLatLng, DEFAULT_ZOOM, {
        animate: true,
        duration: 1.5,
      });
    } else {
      userMarker.setLatLng(currentUserLatLng);
      accuracyCircle.setLatLng(currentUserLatLng);
      accuracyCircle.setRadius(acc);
    }
  }

  function onGeoError(err) {
    console.warn("Geolocation error:", err.code);
    showSearchPrompt();
  }

  function showSearchPrompt() {
    const bar = document.getElementById("search-container");
    if (bar) {
      bar.style.display = "block";
      const input = document.getElementById("search-input");
      if (input) {
        input.placeholder = "Enter your location to find helpers near you";
        input.focus();
      }
    }
  }

  function flyToUser() {
    if (currentUserLatLng) {
      map.flyTo(currentUserLatLng, DEFAULT_ZOOM, {
        animate: true,
        duration: 1.5,
      });
    }
  }

  function setUserLocation(lat, lng) {
    if (!validLatLng(lat, lng)) return;
    currentUserLatLng = L.latLng(lat, lng);
    if (userMarker) {
      userMarker.setLatLng(currentUserLatLng);
    } else {
      userMarker = L.marker(currentUserLatLng, {
        icon: buildUserIcon(),
        interactive: false,
        zIndexOffset: 1000,
      }).addTo(map);
    }
    map.flyTo(currentUserLatLng, DEFAULT_ZOOM, {
      animate: true,
      duration: 1.2,
    });
  }

  // ── Helper markers ───────────────────────────────────────────
  function addHelperMarker(helper) {
    if (!helper || !helper.id) return;
    const lat = parseFloat(helper.latitude);
    const lng = parseFloat(helper.longitude);
    if (!validLatLng(lat, lng)) return;
    if (helperMarkers.has(helper.id)) return; // already added

    const marker = L.marker([lat, lng], { icon: buildHelperIcon(helper) });

    marker.on("click", function () {
      showHelperBottomSheet(helper, lat, lng);
    });

    clusterGroup.addLayer(marker);
    helperMarkers.set(helper.id, marker);
  }

  function clearHelperMarkers() {
    clusterGroup.clearLayers();
    helperMarkers.clear();
  }

  function updateHelperMarkers(helpers) {
    if (!Array.isArray(helpers)) return;
    const incoming = new Set(helpers.map((h) => h.id));

    // Remove stale markers
    for (const [id, marker] of helperMarkers) {
      if (!incoming.has(id)) {
        clusterGroup.removeLayer(marker);
        helperMarkers.delete(id);
      }
    }

    // Add new markers
    helpers.forEach((h) => {
      if (!helperMarkers.has(h.id)) addHelperMarker(h);
    });
  }

  // ── Bottom sheet ─────────────────────────────────────────────
  function showHelperBottomSheet(helper, helperLat, helperLng) {
    const sheet = document.getElementById("bottom-sheet");
    const content = document.getElementById("helper-card-content");
    if (!sheet || !content) return;

    // Calculate distance
    let distStr = "";
    let timeStr = "";
    if (currentUserLatLng && validLatLng(helperLat, helperLng)) {
      const dist = calculateDistance(
        currentUserLatLng.lat,
        currentUserLatLng.lng,
        helperLat,
        helperLng,
      );
      distStr = formatDist(dist);
      timeStr = estimateTime(dist);
    }

    const name = sanitizeText(helper.name || "Helper");
    const org = sanitizeText(helper.organization || "");
    const cat = sanitizeText(
      (helper.helpTypes && helper.helpTypes[0]) || "other",
    );
    const rating = parseFloat(helper.rating) || 0;
    const helped = parseInt(helper.totalResolved, 10) || 0;
    const color = CATEGORY_COLORS[cat] || CATEGORY_COLORS.other;
    const initials = name
      .split(" ")
      .map((w) => w[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();

    // Build stars safely
    const stars = [1, 2, 3, 4, 5]
      .map(
        (i) =>
          `<span class="star${i <= Math.round(rating) ? "" : " empty"}">★</span>`,
      )
      .join("");

    // Safe directions URL
    const safeLatStr = helperLat.toFixed(6);
    const safeLngStr = helperLng.toFixed(6);
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const mapsUrl = isIOS
      ? `maps://?daddr=${safeLatStr},${safeLngStr}`
      : `geo:${safeLatStr},${safeLngStr}?q=${safeLatStr},${safeLngStr}`;

    // Clear and build content using DOM — no innerHTML with user data
    content.innerHTML = "";

    const card = document.createElement("div");
    card.className = "helper-profile-card";

    // Avatar
    const avatar = document.createElement("div");
    avatar.className = "avatar-circle";
    avatar.style.background = color;
    avatar.textContent = initials;
    card.appendChild(avatar);

    // Info block
    const info = document.createElement("div");
    info.className = "helper-info";

    const nameEl = document.createElement("div");
    nameEl.className = "helper-name";
    nameEl.textContent = name;
    info.appendChild(nameEl);

    if (org) {
      const orgEl = document.createElement("div");
      orgEl.className = "helper-org";
      orgEl.textContent = org;
      info.appendChild(orgEl);
    }

    // Category pill
    const pill = document.createElement("span");
    pill.className = "category-pill";
    pill.style.background = color + "20";
    pill.style.color = color;
    pill.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
    info.appendChild(pill);

    // Stars (static HTML is safe — no user data)
    const starsEl = document.createElement("div");
    starsEl.className = "star-rating";
    starsEl.innerHTML = stars; // safe — built from fixed template
    info.appendChild(starsEl);

    // Distance
    if (distStr) {
      const meta = document.createElement("div");
      meta.className = "meta-badge";
      meta.textContent = `${distStr} · ${timeStr}`;
      info.appendChild(meta);
    }

    // Helped count
    const helpedEl = document.createElement("div");
    helpedEl.className = "helped-count";
    helpedEl.textContent = `${helped} people helped`;
    info.appendChild(helpedEl);

    card.appendChild(info);
    content.appendChild(card);

    // Buttons
    const btns = document.createElement("div");
    btns.className = "helper-buttons";

    // WhatsApp button
    if (helper.contactMethod === "whatsapp" && helper.contactPhone) {
      const wa = document.createElement("a");
      wa.className = "btn-primary";
      wa.textContent = "WhatsApp";
      const safePhone = encodeURIComponent(sanitizeText(helper.contactPhone));
      wa.href = `https://wa.me/${safePhone}`;
      wa.target = "_blank";
      wa.rel = "noopener noreferrer";
      btns.appendChild(wa);
    }

    // Call button
    if (helper.contactPhone) {
      const call = document.createElement("a");
      call.className = "btn-secondary";
      call.textContent = "Call";
      const safePhone2 = sanitizeText(helper.contactPhone).replace(
        /[^0-9+]/g,
        "",
      );
      call.href = `tel:${safePhone2}`;
      btns.appendChild(call);
    }

    // Directions button
    const dir = document.createElement("a");
    dir.className = "btn-secondary";
    dir.textContent = "Get Directions";
    dir.href = mapsUrl;
    dir.target = "_blank";
    dir.rel = "noopener noreferrer";
    btns.appendChild(dir);

    content.appendChild(btns);

    // Draw route and expand sheet
    if (currentUserLatLng && validLatLng(helperLat, helperLng)) {
      drawRoute(currentUserLatLng, L.latLng(helperLat, helperLng), color);
    }

    sheet.classList.add("expanded");
  }

  // ── Route drawing ────────────────────────────────────────────
  function drawRoute(userLatLng, helperLatLng, color) {
    clearRoute();

    if (!userLatLng || !helperLatLng) return;
    const uLat = userLatLng.lat || userLatLng[0];
    const uLng = userLatLng.lng || userLatLng[1];
    const hLat = helperLatLng.lat || helperLatLng[0];
    const hLng = helperLatLng.lng || helperLatLng[1];

    if (!validLatLng(uLat, uLng) || !validLatLng(hLat, hLng)) return;

    const routeColor = color || "#16A34A";

    routeLayer = L.polyline(
      [
        [uLat, uLng],
        [hLat, hLng],
      ],
      {
        color: routeColor,
        weight: 4,
        opacity: 0.8,
        dashArray: "10, 8",
        lineCap: "round",
      },
    ).addTo(map);

    // Midpoint label
    const midLat = (uLat + hLat) / 2;
    const midLng = (uLng + hLng) / 2;
    const dist = calculateDistance(uLat, uLng, hLat, hLng);

    if (dist !== null) {
      routeLabel = L.marker([midLat, midLng], {
        icon: L.divIcon({
          className: "route-label",
          html: `<div class="route-badge">${formatDist(dist)} · ${estimateTime(dist)}</div>`,
          iconAnchor: [40, 10],
        }),
        interactive: false,
      }).addTo(map);
    }

    // Fit map to show both points
    const bounds = L.latLngBounds([
      [uLat, uLng],
      [hLat, hLng],
    ]);
    map.fitBounds(bounds, { padding: [80, 80], maxZoom: 15 });
  }

  function clearRoute() {
    if (routeLayer) {
      map.removeLayer(routeLayer);
      routeLayer = null;
    }
    if (routeLabel) {
      map.removeLayer(routeLabel);
      routeLabel = null;
    }
  }

  // ── Nominatim search ─────────────────────────────────────────
  function initSearch() {
    const input = document.getElementById("search-input");
    const suggestions = document.getElementById("search-suggestions");
    if (!input || !suggestions) return;

    input.addEventListener("input", function () {
      clearTimeout(searchTimer);
      const raw = input.value.trim().slice(0, SEARCH_MAX_LEN);
      if (raw.length < 2) {
        suggestions.innerHTML = "";
        suggestions.style.display = "none";
        return;
      }
      searchTimer = setTimeout(
        () => doSearch(raw, suggestions),
        SEARCH_DEBOUNCE_MS,
      );
    });

    // Hide suggestions when clicking outside
    document.addEventListener("click", function (e) {
      if (!input.contains(e.target) && !suggestions.contains(e.target)) {
        suggestions.style.display = "none";
      }
    });
  }

  async function doSearch(query, suggestionsEl) {
    // Validate query before sending
    if (!query || query.length < 2 || query.length > SEARCH_MAX_LEN) return;

    const params = new URLSearchParams({
      q: query,
      format: "json",
      limit: "5",
      addressdetails: "0",
    });

    let results;
    try {
      const resp = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
        headers: { "Accept-Language": "en", "User-Agent": "BridgeUp/1.0" },
      });
      if (!resp.ok) throw new Error("Search failed");
      results = await resp.json();
    } catch (e) {
      console.warn("Nominatim search error:", e.message);
      return;
    }

    suggestionsEl.innerHTML = "";
    if (!Array.isArray(results) || results.length === 0) {
      suggestionsEl.style.display = "none";
      return;
    }

    results.forEach(function (r) {
      // Validate coordinates from Nominatim
      const lat = parseFloat(r.lat);
      const lng = parseFloat(r.lon);
      if (!validLatLng(lat, lng)) return;

      const item = document.createElement("div");
      item.className = "search-suggestion-item";
      item.textContent = sanitizeText(r.display_name); // textContent — XSS safe
      item.addEventListener("click", function () {
        map.flyTo([lat, lng], DEFAULT_ZOOM, { animate: true, duration: 1.2 });
        suggestionsEl.style.display = "none";
        const input = document.getElementById("search-input");
        if (input) input.value = sanitizeText(r.display_name);
        setUserLocation(lat, lng);
      });
      suggestionsEl.appendChild(item);
    });

    suggestionsEl.style.display = "block";
  }

  // ── Category filter pills ────────────────────────────────────
  function initCategoryPills() {
    const pills = document.querySelectorAll(".category-pill[data-category]");
    pills.forEach(function (pill) {
      pill.addEventListener("click", function () {
        pills.forEach((p) => p.classList.remove("is-active"));
        pill.classList.add("is-active");
        const cat = pill.getAttribute("data-category") || null;
        filterByCategory(cat === "all" ? null : cat);
      });
    });
  }

  function filterByCategory(category) {
    for (const [id, marker] of helperMarkers) {
      const el = marker.getElement();
      if (!el) continue;
      if (!category) {
        clusterGroup.addLayer(marker);
      } else {
        const pin = el.querySelector(".helper-pin");
        const cat = pin ? pin.textContent.trim().toLowerCase() : "";
        if (
          category.toLowerCase().startsWith(cat) ||
          cat.startsWith(category.toLowerCase().charAt(0))
        ) {
          clusterGroup.addLayer(marker);
        } else {
          clusterGroup.removeLayer(marker);
        }
      }
    }
  }

  // ── Drag handle for bottom sheet ─────────────────────────────
  function initBottomSheetDrag() {
    const sheet = document.getElementById("bottom-sheet");
    const handle = document.getElementById("sheet-handle");
    if (!sheet || !handle) return;

    let startY = 0;
    let isDragging = false;

    handle.addEventListener(
      "touchstart",
      function (e) {
        startY = e.touches[0].clientY;
        isDragging = true;
      },
      { passive: true },
    );

    handle.addEventListener(
      "touchmove",
      function (e) {
        if (!isDragging) return;
        const delta = e.touches[0].clientY - startY;
        if (delta > 60) {
          sheet.classList.remove("expanded");
          isDragging = false;
        } else if (delta < -60) {
          sheet.classList.add("expanded");
          isDragging = false;
        }
      },
      { passive: true },
    );

    handle.addEventListener("click", function () {
      sheet.classList.toggle("expanded");
    });
  }

  // ── Public API ───────────────────────────────────────────────
  window.MapInterface = {
    init: init,
    addHelperMarker: addHelperMarker,
    clearHelperMarkers: clearHelperMarkers,
    updateHelperMarkers: updateHelperMarkers,
    drawRoute: drawRoute,
    clearRoute: clearRoute,
    filterByCategory: filterByCategory,
    calculateDistance: calculateDistance,
    flyToUser: flyToUser,
    setUserLocation: setUserLocation,
    showHelperBottomSheet: showHelperBottomSheet,
    initBottomSheetDrag: initBottomSheetDrag,
  };
})();

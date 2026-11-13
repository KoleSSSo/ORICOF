(() => {
  const VIEW = { x: 0, y: 0, w: 2000, h: 1001 };
  const MIN_SCALE = 1;
  const MAX_SCALE = 40;
  const DRAG_THRESHOLD = 8;

  // EmailJS: Template ID — Email Templates → твой шаблон → Settings
  const EMAILJS = {
    publicKey: "tX9qzl3LzknbleYPM",
    serviceId: "service_vu8fc0f",
    templateId: "template_is7zf0a"
  };

  const els = {
    wrap: document.getElementById("map-wrap"),
    host: document.getElementById("map-host"),
    loader: document.getElementById("map-loader"),
    zoomIn: document.getElementById("zoom-in"),
    zoomOut: document.getElementById("zoom-out"),
    search: document.getElementById("search-input"),
    results: document.getElementById("search-results"),
    back: document.getElementById("back-btn"),
    title: document.getElementById("country-title"),
    modal: document.getElementById("modal"),
    modalClose: document.getElementById("modal-close"),
    modalCountry: document.getElementById("modal-country"),
    modalRegion: document.getElementById("modal-region"),
    modalPhoto: document.getElementById("modal-photo"),
    modalTaste: document.getElementById("modal-taste"),
    modalConditions: document.getElementById("modal-conditions"),
    modalNote: document.getElementById("modal-note"),
    modalSwatch: document.getElementById("modal-swatch"),
    cartBtn: document.getElementById("cart-btn"),
    cartModal: document.getElementById("cart-modal"),
    cartClose: document.getElementById("cart-close"),
    cartForm: document.getElementById("cart-form"),
    cartStatus: document.getElementById("cart-status")
  };

  const state = {
    svg: null,
    countries: null,
    coffeePaths: [],
    regionsLayer: null,
    hoverLayer: null,
    view: { ...VIEW },
    target: { ...VIEW },
    anim: null,
    selected: null,
    panning: false,
    didDrag: false,
    lastX: 0,
    lastY: 0,
    hoverId: null,
    press: null,
    pointers: new Map(),
    pinch: null
  };

  const WORLD_TITLE = "Карта кофе мира";
  const coffeeIds = () => Object.keys(window.COFFEE_DATA);

  function showMapTitle(text) {
    els.title.textContent = text;
    els.title.classList.add("is-visible");
  }

  function clampView(v) {
    const minW = VIEW.w / MAX_SCALE;
    const maxW = VIEW.w / MIN_SCALE;
    const cx = v.x + v.w / 2;
    const cy = v.y + v.h / 2;
    let w = Math.min(maxW, Math.max(minW, v.w));
    let h = w * (VIEW.h / VIEW.w);
    let x = cx - w / 2;
    let y = cy - h / 2;
    x = Math.min(VIEW.w - w, Math.max(0, x));
    y = Math.min(VIEW.h - h, Math.max(0, y));
    return { x, y, w, h, scale: VIEW.w / w };
  }

  function applyView(v) {
    state.view = clampView(v);
    if (state.svg) {
      state.svg.setAttribute(
        "viewBox",
        `${state.view.x} ${state.view.y} ${state.view.w} ${state.view.h}`
      );
    }
  }

  function easeOutQuint(t) {
    return 1 - Math.pow(1 - t, 5);
  }

  function animateTo(next, ms = 820) {
    const from = { ...state.view };
    const to = clampView(next);
    state.target = to;
    if (state.anim) cancelAnimationFrame(state.anim);
    const start = performance.now();

    const tick = (now) => {
      const t = Math.min(1, (now - start) / ms);
      const e = easeOutQuint(t);
      applyView({
        x: from.x + (to.x - from.x) * e,
        y: from.y + (to.y - from.y) * e,
        w: from.w + (to.w - from.w) * e,
        h: from.h + (to.h - from.h) * e
      });
      if (t < 1) state.anim = requestAnimationFrame(tick);
      else state.anim = null;
    };
    state.anim = requestAnimationFrame(tick);
  }

  function zoomAt(factor, cx, cy, ms = 420) {
    const rect = els.wrap.getBoundingClientRect();
    const base = state.anim ? state.target : state.view;
    const px = (cx ?? rect.width / 2) / rect.width;
    const py = (cy ?? rect.height / 2) / rect.height;
    const mx = base.x + base.w * px;
    const my = base.y + base.h * py;
    const w = base.w / factor;
    const h = base.h / factor;
    const next = { x: mx - w * px, y: my - h * py, w, h };

    // leave country focus after several zoom-out steps
    if (state.selected && factor < 1) {
      state.focusZoomOuts = (state.focusZoomOuts || 0) + 1;
      if (state.focusZoomOuts >= 3) {
        leaveCountryFocus({ restoreWorld: false });
      }
    } else if (state.selected && factor > 1) {
      state.focusZoomOuts = 0;
    }

    animateTo(next, ms);
  }

  /** Full country extent — archipelagos must zoom to all islands */
  function regionBoxFor(id) {
    const entry = window.COUNTRY_BOUNDS[id];
    if (!entry) return null;
    return entry.bounds || entry.mainland;
  }

  function boundsFor(id) {
    return regionBoxFor(id);
  }

  function viewForCountry(id, pad = 0.18) {
    const path = countryPath(id);
    let x0, y0, x1, y1;
    if (path) {
      const box = path.getBBox();
      x0 = box.x;
      y0 = box.y;
      x1 = box.x + box.width;
      y1 = box.y + box.height;
    } else {
      const b = regionBoxFor(id);
      if (!b) return { ...VIEW };
      [x0, y0, x1, y1] = b;
    }
    let w = Math.max(x1 - x0, 12);
    let h = Math.max(y1 - y0, 12);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    // Tiny countries need more padding so the shape is readable
    const size = Math.max(w, h);
    const extra = size < 40 ? 0.55 : size < 80 ? 0.28 : pad;
    w *= 1 + extra * 2;
    h *= 1 + extra * 2;
    const aspect = VIEW.w / VIEW.h;
    if (w / h > aspect) h = w / aspect;
    else w = h * aspect;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  }

  function pointInCountry(id, rx, ry) {
    const b = regionBoxFor(id);
    if (!b) return [0, 0];
    const [x0, y0, x1, y1] = b;
    return [x0 + (x1 - x0) * rx, y0 + (y1 - y0) * ry];
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  function countryPath(id) {
    return state.svg?.getElementById(id) || null;
  }

  function isInsidePath(path, x, y) {
    if (!path || typeof path.isPointInFill !== "function") return true;
    const svg = state.svg;
    const pt = svg.createSVGPoint();
    pt.x = x;
    pt.y = y;
    try {
      return path.isPointInFill(pt);
    } catch {
      return true;
    }
  }

  /** Prefer points that sit clearly inside the fill, not on the edge */
  function deepInside(path, x, y, margin) {
    if (!isInsidePath(path, x, y)) return false;
    return (
      isInsidePath(path, x + margin, y) &&
      isInsidePath(path, x - margin, y) &&
      isInsidePath(path, x, y + margin) &&
      isInsidePath(path, x, y - margin)
    );
  }

  /** Pull a candidate point into the actual country polygon fill */
  function snapInsideCountry(countryId, x, y) {
    const path = countryPath(countryId);
    const b = regionBoxFor(countryId);
    if (!path || !b) return [x, y];

    const [x0, y0, x1, y1] = b;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const margin = Math.max(2.2, Math.min(x1 - x0, y1 - y0) * 0.05);

    if (deepInside(path, x, y, margin)) return [x, y];

    // Prefer same latitude / longitude band (helps thin countries like Vietnam)
    let best = null;
    let bestDist = Infinity;
    for (let t = 0; t <= 1; t += 0.03) {
      const sx = x0 + (x1 - x0) * t;
      if (deepInside(path, sx, y, margin)) {
        const d = Math.abs(sx - x);
        if (d < bestDist) {
          bestDist = d;
          best = [sx, y];
        }
      }
      const sy = y0 + (y1 - y0) * t;
      if (deepInside(path, x, sy, margin)) {
        const d = Math.abs(sy - y);
        if (d < bestDist) {
          bestDist = d;
          best = [x, sy];
        }
      }
    }
    if (best) return best;

    // walk from desired point toward bbox center
    for (let t = 0.04; t <= 1; t += 0.04) {
      const sx = x + (cx - x) * t;
      const sy = y + (cy - y) * t;
      if (deepInside(path, sx, sy, margin)) return [sx, sy];
    }

    // spiral around center as last resort
    const step = Math.max(2, margin * 0.6);
    for (let r = 0; r < Math.max(x1 - x0, y1 - y0); r += step) {
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 10) {
        const sx = cx + Math.cos(a) * r;
        const sy = cy + Math.sin(a) * r;
        if (deepInside(path, sx, sy, margin)) return [sx, sy];
      }
    }
    return [cx, cy];
  }

  /** Marker/label sizes in SVG units from % of viewport width */
  function markerMetrics() {
    const view = state.focusViewW
      ? { w: state.focusViewW, h: state.focusViewW * (VIEW.h / VIEW.w) }
      : state.anim
        ? state.target
        : state.view;
    const rect = els.wrap.getBoundingClientRect();
    const unit = view.w / Math.max(rect.width, 1);
    // sizes as % of viewport width → stable on-screen for tiny countries
    const outerPx = Math.max(11, Math.min(18, rect.width * 0.022));
    // тонкая обводка ~0.12% ширины экрана (1.1–1.8px), чтобы кольца не слипались
    const strokePx = Math.max(1.1, Math.min(1.8, rect.width * 0.0012));
    const fontPx = Math.max(13, Math.min(20, rect.width * 0.02));
    const outer = outerPx * unit;
    const stroke = strokePx * unit;
    // зазоры между кольцами больше толщины линии
    const mid = Math.min(Math.max(outer * 0.62, stroke * 3.2), outer - stroke * 2.2);
    const inner = Math.min(Math.max(outer * 0.32, stroke * 1.6), mid - stroke * 2.2);
    return {
      outer,
      mid,
      inner: Math.max(inner, stroke),
      hit: outer * 1.7,
      font: fontPx * unit,
      gap: outer * 2.35,
      stroke,
      minDist: outer * 5.8
    };
  }

  /** Keep markers from stacking on top of each other */
  function separatePlaced(countryId, placed, minDist) {
    const path = countryPath(countryId);
    const need = minDist ?? markerMetrics().minDist;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < placed.length; i++) {
        for (let j = 0; j < i; j++) {
          const a = placed[i];
          const b = placed[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let dist = Math.hypot(dx, dy) || 0.01;
          if (dist >= need) continue;
          const push = (need - dist) / 2 + need * 0.08;
          dx /= dist;
          dy /= dist;
          if (Math.abs(dy) < 0.25) dy = a.y >= b.y ? 1 : -1;
          const candidates = [
            [a.x + dx * push, a.y + dy * push],
            [a.x, a.y + (a.y >= b.y ? push : -push) * 1.35],
            [a.x + (a.x >= b.x ? push : -push) * 1.35, a.y]
          ];
          for (const [nx, ny] of candidates) {
            if (!path || isInsidePath(path, nx, ny)) {
              a.x = nx;
              a.y = ny;
              break;
            }
          }
        }
      }
    }
  }

  /** Marker must sit inside country fill; label may sit outside */
  function placeRegion(countryId, region) {
    let [x, y] = pointInCountry(countryId, region.x, region.y);
    [x, y] = snapInsideCountry(countryId, x, y);
    return { x, y };
  }

  function clearRegions() {
    if (state.regionsLayer) state.regionsLayer.innerHTML = "";
  }

  function clearHoverOverlay() {
    if (state.hoverLayer) state.hoverLayer.innerHTML = "";
    state.hoverId = null;
    state.coffeePaths.forEach((path) => path.classList.remove("is-hovered"));
  }

  function showHover(path) {
    if (state.selected || state.panning) return;
    clearHoverOverlay();
    state.hoverId = path.id;
    path.classList.add("is-hovered");

    // clone on top layer + scale so neighbours never clip it
    const clone = path.cloneNode(true);
    clone.removeAttribute("id");
    clone.removeAttribute("tabindex");
    clone.setAttribute("class", "country-hover-clone");
    clone.style.setProperty("--country-color", window.COFFEE_DATA[path.id].color);
    clone.style.pointerEvents = "none";
    clone.style.transform = "scale(1)";
    state.hoverLayer.appendChild(clone);
    requestAnimationFrame(() => {
      clone.style.transform = "scale(1.05)";
    });
  }

  function labelOffset(region, x, y, countryId, gap) {
    const side = region.side;
    if (side === "left") return { labelX: x - gap, labelY: y + gap * 0.2, anchor: "end" };
    if (side === "right") return { labelX: x + gap, labelY: y + gap * 0.2, anchor: "start" };
    if (side === "top") return { labelX: x, labelY: y - gap * 0.85, anchor: "middle" };
    if (side === "bottom") return { labelX: x, labelY: y + gap * 1.15, anchor: "middle" };
    const b = regionBoxFor(countryId);
    const cx = b ? (b[0] + b[2]) / 2 : x;
    const labelRight = x <= cx;
    return {
      labelX: labelRight ? x + gap : x - gap,
      labelY: y + gap * 0.2,
      anchor: labelRight ? "start" : "end"
    };
  }

  function showRegions(countryId) {
    clearRegions();
    const data = window.COFFEE_DATA[countryId];
    if (!data || !state.regionsLayer) return;

    const m = markerMetrics();
    const placed = data.regions.map((region) => {
      const pos = placeRegion(countryId, region);
      return { region, x: pos.x, y: pos.y };
    });
    separatePlaced(countryId, placed, m.minDist);

    placed.forEach(({ region, x, y }, i) => {
      const { labelX, labelY, anchor } = labelOffset(region, x, y, countryId, m.gap);
      const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
      g.setAttribute("class", "region-marker");
      g.style.animationDelay = `${80 + i * 70}ms`;

      const hit = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      hit.setAttribute("class", "region-hit");
      hit.setAttribute("cx", x);
      hit.setAttribute("cy", y);
      hit.setAttribute("r", m.hit);
      hit.setAttribute("tabindex", "0");
      hit.setAttribute("role", "button");
      hit.setAttribute("aria-label", region.name);

      [m.inner, m.mid, m.outer].forEach((r) => {
        const ring = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        ring.setAttribute("class", "region-ring");
        ring.setAttribute("cx", x);
        ring.setAttribute("cy", y);
        ring.setAttribute("r", Math.max(r, m.stroke));
        ring.style.strokeWidth = `${m.stroke}`;
        g.appendChild(ring);
      });

      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("class", "region-label");
      label.setAttribute("x", labelX);
      label.setAttribute("y", labelY);
      label.setAttribute("text-anchor", anchor);
      label.setAttribute("fill", "#000000");
      label.setAttribute("font-size", m.font);
      label.textContent = region.name;

      const open = () => openModal(countryId, region);
      hit.addEventListener("click", (e) => {
        e.stopPropagation();
        open();
      });
      hit.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });

      g.append(hit, label);
      state.regionsLayer.appendChild(g);

      requestAnimationFrame(() => g.classList.add("is-visible"));
    });
  }

  function clearSearchHits() {
    state.coffeePaths.forEach((p) => p.classList.remove("is-search-hit"));
  }

  function setCountryMode(id) {
    if (!window.COFFEE_DATA[id]) return;
    clearHoverOverlay();
    clearSearchHits();
    state.selected = id;
    state.focusZoomOuts = 0;
    const focusView = viewForCountry(id);
    state.focusViewW = focusView.w;
    els.back.classList.add("is-visible");
    showMapTitle(window.COFFEE_DATA[id].name);
    els.results.classList.remove("is-open");

    state.countries.forEach((path) => {
      path.classList.remove("is-hovered", "is-search-hit");
      if (path.id === id) {
        path.classList.add("is-active");
        path.classList.remove("is-dimmed");
      } else {
        path.classList.add("is-dimmed");
        path.classList.remove("is-active");
      }
    });

    showRegions(id);
    animateTo(focusView, 900);
    // убрать системный focus-ring браузера вокруг path после клика
    const active = document.activeElement;
    if (active?.classList?.contains("country")) active.blur();
  }

  function leaveCountryFocus({ restoreWorld = true } = {}) {
    state.selected = null;
    state.focusViewW = null;
    state.focusZoomOuts = 0;
    clearRegions();
    clearHoverOverlay();
    clearSearchHits();
    els.back.classList.remove("is-visible");
    showMapTitle(WORLD_TITLE);
    state.countries.forEach((path) => {
      path.classList.remove("is-active", "is-dimmed", "is-hovered", "is-search-hit");
    });
    if (restoreWorld) animateTo({ ...VIEW }, 780);
  }

  function resetCountryMode() {
    leaveCountryFocus({ restoreWorld: true });
  }

  function setModalPhoto(src, alt) {
    const img = els.modalPhoto;
    // мгновенно прячем — без fade-out, иначе видно прошлое фото
    img.style.transition = "none";
    img.classList.remove("is-ready");
    img.removeAttribute("src");
    img.alt = alt;
    void img.offsetWidth;
    img.style.transition = "";

    const token = String(Date.now());
    img.dataset.photoToken = token;

    const probe = new Image();
    probe.onload = () => {
      if (img.dataset.photoToken !== token) return;
      img.src = src;
      img.classList.add("is-ready");
    };
    probe.onerror = () => {
      if (img.dataset.photoToken !== token) return;
      img.src = src;
      img.classList.add("is-ready");
    };
    probe.src = src;
  }

  function openModal(countryId, region) {
    const country = window.COFFEE_DATA[countryId];
    els.modalSwatch.style.background = country.color;
    els.modalCountry.textContent = country.name;
    els.modalRegion.textContent = region.name;
    setModalPhoto(region.photo, `${region.name}, ${country.name}`);
    els.modalTaste.textContent = region.taste;
    els.modalConditions.textContent = region.conditions;
    els.modalNote.textContent = region.note;
    els.modal.classList.add("is-open");
    els.modal.setAttribute("aria-hidden", "false");
    els.modalClose.focus();
  }

  function closeModal() {
    els.modal.classList.remove("is-open");
    els.modal.setAttribute("aria-hidden", "true");
    els.modalPhoto.classList.remove("is-ready");
    els.modalPhoto.removeAttribute("src");
    els.modalPhoto.alt = "";
  }

  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(String(value).trim());
  }

  function resetCartForm() {
    const formView = document.getElementById("cart-form-view");
    const success = document.getElementById("cart-success");
    if (formView) formView.hidden = false;
    if (success) success.hidden = true;
    els.cartForm?.reset();
    els.cartStatus.textContent = "";
    els.cartStatus.classList.remove("is-ok");
  }

  function openCartModal() {
    closeModal();
    closeSearch();
    resetCartForm();
    els.cartModal.classList.add("is-open");
    els.cartModal.setAttribute("aria-hidden", "false");
    window.setTimeout(() => document.getElementById("cart-name")?.focus(), 60);
  }

  function closeCartModal() {
    els.cartModal.classList.remove("is-open");
    els.cartModal.setAttribute("aria-hidden", "true");
    resetCartForm();
  }

  function showCartSuccess(email) {
    const formView = document.getElementById("cart-form-view");
    const success = document.getElementById("cart-success");
    const emailEl = document.getElementById("cart-success-email");
    if (emailEl) emailEl.textContent = String(email).trim() || "email@email";
    if (formView) formView.hidden = true;
    if (success) success.hidden = false;
  }

  function updateSearchPlaceholder() {
    els.search.placeholder =
      window.innerWidth <= 720 ? "Поиск..." : "Поиск страны или региона";
  }

  function wireCountry(path) {
    const id = path.id;
    const data = window.COFFEE_DATA[id];
    if (!data) return;

    path.classList.add("is-coffee");
    path.style.setProperty("--country-color", data.color);
    path.setAttribute("tabindex", "0");
    path.setAttribute("role", "button");
    path.setAttribute("aria-label", data.name);

    path.addEventListener("pointerenter", () => {
      if (state.selected) return;
      showHover(path);
    });

    path.addEventListener("pointerleave", () => {
      if (state.selected) return;
      if (state.hoverId === id) clearHoverOverlay();
    });

    // stop wrap from capturing - this was blocking country clicks
    path.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      state.press = { id, x: e.clientX, y: e.clientY };
      state.didDrag = false;
    });

    path.addEventListener("pointerup", (e) => {
      e.stopPropagation();
      if (!state.press || state.press.id !== id) return;
      const moved = Math.hypot(e.clientX - state.press.x, e.clientY - state.press.y);
      state.press = null;
      if (moved >= DRAG_THRESHOLD) return;
      setCountryMode(id);
    });

    path.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setCountryMode(id);
      }
    });
  }

  function sortedCoffeeList() {
    return coffeeIds()
      .map((id) => ({ id, ...window.COFFEE_DATA[id] }))
      .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  }

  function fitSearchResultsHeight() {
    const box = els.search.getBoundingClientRect();
    const max = Math.max(120, window.innerHeight - box.bottom - 12);
    els.results.style.maxHeight = `${max}px`;
  }

  function renderSearch(query, { showAll = false } = {}) {
    const q = query.trim().toLowerCase();
    els.results.innerHTML = "";

    let hits = sortedCoffeeList();
    if (q) {
      hits = hits.filter((c) => {
        const hay = `${c.name} ${c.regions.map((r) => r.name).join(" ")}`.toLowerCase();
        return hay.includes(q);
      });
    } else if (!showAll) {
      closeSearch();
      return;
    }

    clearSearchHits();
    state.coffeePaths.forEach((p) => {
      p.classList.toggle("is-search-hit", hits.some((h) => h.id === p.id) && !state.selected);
    });

    if (!hits.length) {
      els.results.classList.remove("is-open");
      return;
    }

    hits.forEach((hit) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = hit.name;
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        els.search.value = hit.name;
        closeSearch();
        setCountryMode(hit.id);
      });
      li.appendChild(btn);
      els.results.appendChild(li);
    });

    fitSearchResultsHeight();
    els.results.classList.add("is-open");
  }

  function closeSearch() {
    els.results.classList.remove("is-open");
    clearSearchHits();
  }

  function pointerDist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function pointerMid(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  /** Мгновенный зум вокруг точки (для pinch), без анимации */
  function zoomImmediate(factor, clientX, clientY) {
    const rect = els.wrap.getBoundingClientRect();
    const base = state.view;
    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;
    const mx = base.x + base.w * px;
    const my = base.y + base.h * py;
    const w = base.w / factor;
    const h = base.h / factor;

    if (state.selected && factor < 0.985) {
      state.focusZoomOuts = (state.focusZoomOuts || 0) + (1 - factor) * 5;
      if (state.focusZoomOuts >= 3) leaveCountryFocus({ restoreWorld: false });
    } else if (state.selected && factor > 1.015) {
      state.focusZoomOuts = 0;
    }

    if (state.anim) {
      cancelAnimationFrame(state.anim);
      state.anim = null;
    }
    applyView({ x: mx - w * px, y: my - h * py, w, h });
    state.target = { ...state.view };
  }

  function bindPanZoom() {
    els.wrap.addEventListener("wheel", (e) => {
      e.preventDefault();
      const intensity = Math.min(Math.abs(e.deltaY) / 100, 2.2);
      const step = 1 + 0.07 * intensity;
      const factor = e.deltaY < 0 ? step : 1 / step;
      const rect = els.wrap.getBoundingClientRect();
      zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top, 460);
    }, { passive: false });

    const syncPinch = () => {
      const pts = [...state.pointers.values()];
      if (pts.length < 2) {
        state.pinch = null;
        return;
      }
      const dist = pointerDist(pts[0], pts[1]);
      const mid = pointerMid(pts[0], pts[1]);
      if (!state.pinch) {
        state.pinch = { dist, midX: mid.x, midY: mid.y };
        state.panning = false;
        state.didDrag = true;
        clearHoverOverlay();
        return;
      }
      const factor = dist / Math.max(state.pinch.dist, 1);
      zoomImmediate(factor, mid.x, mid.y);

      // лёгкий pan серединой жеста
      const rect = els.wrap.getBoundingClientRect();
      const sx = state.view.w / rect.width;
      const sy = state.view.h / rect.height;
      const dx = mid.x - state.pinch.midX;
      const dy = mid.y - state.pinch.midY;
      applyView({
        x: state.view.x - dx * sx,
        y: state.view.y - dy * sy,
        w: state.view.w,
        h: state.view.h
      });
      state.target = { ...state.view };
      state.pinch = { dist, midX: mid.x, midY: mid.y };
    };

    // capture: true — чтобы pinch работал даже если палец на стране (у path есть stopPropagation)
    els.wrap.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (state.pointers.size >= 2) {
        state.panning = false;
        state.didDrag = true;
        state.press = null;
        clearHoverOverlay();
        state.pointers.forEach((_, id) => {
          try {
            els.wrap.setPointerCapture(id);
          } catch (_) { /* ignore */ }
        });
        syncPinch();
        return;
      }

      if (e.target.closest(".region-marker, .country.is-coffee")) return;

      state.panning = true;
      state.didDrag = false;
      state.lastX = e.clientX;
      state.lastY = e.clientY;
      els.wrap.classList.add("is-dragging");
      try {
        els.wrap.setPointerCapture(e.pointerId);
      } catch (_) { /* ignore */ }
    }, true);

    els.wrap.addEventListener("pointermove", (e) => {
      if (!state.pointers.has(e.pointerId)) return;
      state.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (state.pointers.size >= 2) {
        e.preventDefault();
        syncPinch();
        return;
      }

      if (!state.panning) return;
      const dx = e.clientX - state.lastX;
      const dy = e.clientY - state.lastY;
      if (!state.didDrag && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      state.didDrag = true;
      clearHoverOverlay();
      state.lastX = e.clientX;
      state.lastY = e.clientY;
      const rect = els.wrap.getBoundingClientRect();
      const sx = state.view.w / rect.width;
      const sy = state.view.h / rect.height;
      if (state.anim) {
        cancelAnimationFrame(state.anim);
        state.anim = null;
      }
      applyView({
        x: state.view.x - dx * sx,
        y: state.view.y - dy * sy,
        w: state.view.w,
        h: state.view.h
      });
      state.target = { ...state.view };
    }, { passive: false, capture: true });

    const endPointer = (e) => {
      if (!state.pointers.has(e.pointerId)) return;
      state.pointers.delete(e.pointerId);
      if (els.wrap.hasPointerCapture?.(e.pointerId)) {
        try {
          els.wrap.releasePointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
      }

      if (state.pointers.size >= 2) {
        syncPinch();
        return;
      }

      state.pinch = null;
      if (state.pointers.size === 1) {
        const left = [...state.pointers.values()][0];
        state.panning = true;
        state.lastX = left.x;
        state.lastY = left.y;
        els.wrap.classList.add("is-dragging");
        return;
      }

      state.panning = false;
      els.wrap.classList.remove("is-dragging");
      window.setTimeout(() => {
        state.didDrag = false;
      }, 0);
    };

    els.wrap.addEventListener("pointerup", endPointer, true);
    els.wrap.addEventListener("pointercancel", endPointer, true);

    els.wrap.addEventListener("click", (e) => {
      if (!state.selected || state.didDrag) return;
      if (e.target.closest(".region-marker")) return;
      if (e.target.closest(`#${CSS.escape(state.selected)}`)) return;
      resetCountryMode();
    });
  }

  function hideMapLoader() {
    els.loader?.classList.add("is-done");
    if (!state.selected) showMapTitle(WORLD_TITLE);
  }

  async function loadMap() {
    const t0 = performance.now();
    const res = await fetch("assets/world-map.svg");
    const text = await res.text();
    els.host.innerHTML = text;
    const svg = els.host.querySelector("svg");
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.classList.add("map-svg");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Карта мира с регионами выращивания кофе");

    const group = svg.querySelector("g");
    group.removeAttribute("fill");
    group.removeAttribute("stroke");
    group.removeAttribute("stroke-width");

    const paths = [...svg.querySelectorAll("path")];
    paths.forEach((path) => path.classList.add("country"));

    const hoverLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    hoverLayer.setAttribute("class", "hover-layer");
    const regionsLayer = document.createElementNS("http://www.w3.org/2000/svg", "g");
    regionsLayer.setAttribute("class", "regions");
    svg.append(hoverLayer, regionsLayer);

    state.svg = svg;
    state.countries = paths;
    state.hoverLayer = hoverLayer;
    state.regionsLayer = regionsLayer;
    state.coffeePaths = [];

    coffeeIds().forEach((id) => {
      const path = svg.getElementById(id);
      if (path) {
        wireCountry(path);
        state.coffeePaths.push(path);
      }
    });

    applyView({ ...VIEW });
    // минимум ~1.2s, чтобы налив был заметен даже при быстрой загрузке
    const wait = Math.max(0, 1200 - (performance.now() - t0));
    window.setTimeout(hideMapLoader, wait);
  }

  function bindUi() {
    els.zoomIn.addEventListener("click", () => zoomAt(1.22, undefined, undefined, 380));
    els.zoomOut.addEventListener("click", () => zoomAt(1 / 1.22, undefined, undefined, 380));
    els.back.addEventListener("click", resetCountryMode);

    els.search.addEventListener("focus", () => {
      renderSearch(els.search.value, { showAll: true });
    });
    els.search.addEventListener("input", () => {
      renderSearch(els.search.value, { showAll: true });
    });
    els.search.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeSearch();
        els.search.blur();
      }
      if (e.key === "Enter") {
        const first = els.results.querySelector("button");
        if (first) first.click();
      }
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-box")) closeSearch();
    });

    window.addEventListener("resize", () => {
      updateSearchPlaceholder();
      if (els.results.classList.contains("is-open")) fitSearchResultsHeight();
    });
    updateSearchPlaceholder();

    els.modalClose.addEventListener("click", closeModal);
    els.modal.addEventListener("click", (e) => {
      if (e.target === els.modal) closeModal();
    });

    if (window.emailjs && EMAILJS.publicKey) {
      window.emailjs.init({ publicKey: EMAILJS.publicKey });
    }

    els.cartBtn.addEventListener("click", openCartModal);
    els.cartClose.addEventListener("click", closeCartModal);
    els.cartModal.addEventListener("click", (e) => {
      if (e.target === els.cartModal) closeCartModal();
    });
    els.cartForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const name = document.getElementById("cart-name");
      const email = document.getElementById("cart-email");
      const submitBtn = els.cartForm.querySelector(".cart-form__submit");
      const nameOk = Boolean(name.value.trim());
      const emailOk = isValidEmail(email.value);
      if (!nameOk || !emailOk) {
        els.cartStatus.classList.remove("is-ok");
        els.cartStatus.textContent = !nameOk
          ? "Укажите имя."
          : "Введите корректный e-mail (например, name@mail.ru).";
        email.focus();
        return;
      }
      if (!window.emailjs) {
        els.cartStatus.textContent = "Сервис отправки не загрузился. Обновите страницу.";
        return;
      }
      if (!EMAILJS.templateId) {
        els.cartStatus.textContent = "Не указан Template ID EmailJS.";
        return;
      }

      submitBtn.disabled = true;
      const prevLabel = submitBtn.textContent;
      submitBtn.textContent = "Отправляем…";
      els.cartStatus.textContent = "";

      try {
        await window.emailjs.sendForm(
          EMAILJS.serviceId,
          EMAILJS.templateId,
          els.cartForm,
          { publicKey: EMAILJS.publicKey }
        );
        showCartSuccess(email.value);
      } catch (err) {
        console.error(err);
        els.cartStatus.classList.remove("is-ok");
        const status = err?.status || err?.statusCode;
        const text = String(err?.text || err?.message || "");
        if (status === 403 || /origin|domain|forbidden|blocked/i.test(text)) {
          els.cartStatus.textContent =
            "EmailJS блокирует этот домен. В кабинете EmailJS → Account → Security добавьте сайт в Allowed Origins.";
        } else if (!navigator.onLine || /network|failed to fetch|load/i.test(text)) {
          els.cartStatus.textContent = "Нет связи с EmailJS. Проверьте интернет или блокировщик.";
        } else {
          els.cartStatus.textContent = "Не удалось отправить. Попробуйте ещё раз.";
        }
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = prevLabel;
      }
    });
    document.getElementById("cart-success-close")?.addEventListener("click", closeCartModal);

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (els.cartModal.classList.contains("is-open")) closeCartModal();
        else if (els.modal.classList.contains("is-open")) closeModal();
        else if (state.selected) resetCountryMode();
      }
    });

    bindPanZoom();
  }

  bindUi();
  loadMap().catch((err) => {
    console.error(err);
    hideMapLoader();
    els.host.innerHTML = "<p style='padding:2rem'>Не удалось загрузить карту.</p>";
  });
})();

// The expedition controller: one clock, one frame state, every moving part a
// function of it. Concepts stay separate:
//
//   scroll        what the visitor sees: native, or eased by ScrollSmoother on
//                 pointer devices (smooth.ts); the scrollbar stays native
//   camera        scroll eased by a short, bounded lag (camera.ts)
//   depth         narrative metres and the current chapter, from the camera
//   route         the diver's world-space trajectory, a pure function of the camera (route.ts)
//   orientation   body heading from the route, re-pitched by travel direction with
//                 hysteresis (travel.ts, diver.ts)
//   body          kicks, breathing, bob, arm, bubbles: local time, never position (diver.ts)
//   environment   light, haze, particles from depth (ocean.ts)
//   instruments   dive computer and expedition profile (diveComputer.ts)
//   finale        0..1 settle into the logo, a pure function of the camera
//
// GSAP supplies the clock (gsap.ticker), scroll and refresh hooks (one
// ScrollTrigger spanning the page) and breakpoint/reduced-motion contexts
// (gsap.matchMedia). The route stays deterministic maths rather than a
// MotionPath: heading is authored, not derived from the path's tangent, so
// reversing the scroll can never flip the diver.
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import { createSonar } from "../ui/sonar";
import { advanceCamera, readDepth } from "./camera";
import { createDiveComputer } from "./diveComputer";
import { createDiver, type FinaleTarget, LOGO_POSE, PIVOT } from "./diver";
import { createLit } from "./lit";
import { createOcean } from "./ocean";
import { buildRoute, parseRoute, type RoutePose } from "./route";
import { createSmooth } from "./smooth";
import type { ExpeditionState } from "./state";

gsap.registerPlugin(ScrollTrigger);

// Air above the water on the first screen, px; matches --waterline in global.css.
const waterlineY = (vh: number) => Math.max(vh * 0.15, 152);

const AIMS: Record<string, string> = {
  // Idle tour panels are data-off, and one fading out is data-leaving: aim at the one arriving.
  tour: ".tour__panel:not([hidden], [data-off], [data-leaving]) .spot.is-active",
  sonar: '[data-engine][aria-pressed="true"]',
  deep: "[data-logo-bars]",
};

const restingRoute = (): RoutePose => ({ x: 0.5, y: 0.5, h: Math.PI / 2, lateral: 0 });

function need<T extends Element>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Expedition is missing ${sel}`);
  return el;
}

export function initExpedition(signal: AbortSignal): () => void {
  const root = document.documentElement;
  const ocean = createOcean(need<HTMLCanvasElement>("[data-ocean]"));
  const diver = createDiver(
    need<SVGSVGElement>("[data-diver]"),
    need<HTMLCanvasElement>("[data-fx]")
  );
  const computer = createDiveComputer(need("[data-dive-computer]"), need("#expedition"), signal);
  const lit = createLit();
  const smooth = createSmooth(signal);
  const sonarEl = document.querySelector<HTMLElement>("[data-sonar]");
  const sonar = sonarEl ? createSonar(sonarEl, signal) : null;
  const lineAnchor = document.querySelector<HTMLElement>("[data-line-anchor]");
  const logo = document.querySelector<SVGSVGElement>("[data-logo-svg]");
  const reveal = document.querySelector<HTMLElement>("[data-logo-reveal]");

  const s: ExpeditionState = {
    t: 0,
    dt: 0,
    scrollY: scrollY,
    cam: scrollY,
    velocity: 0,
    vw: innerWidth,
    vh: innerHeight,
    maxScroll: 1,
    small: false,
    reduced: false,
    chapters: [],
    index: 0,
    depthM: 0,
    progress: 0,
    murk: 0,
    dir: 1,
    waterlineDoc: 0,
    line: null,
    camX: 0,
    contentRight: 0,
    beam: null,
    finale: 0,
  };
  let route: (cam: number) => RoutePose = restingRoute;
  // The logo diver's pivot in document px, and the rig scale that matches it.
  let logoPivot: { x: number; y: number; scale: number } | null = null;

  function measure() {
    // Rects are visual; with smoothing on, the content trails the scrollbar.
    const y0 = smooth.y();
    s.vw = innerWidth;
    s.vh = innerHeight;
    s.maxScroll = Math.max(1, root.scrollHeight - s.vh);
    s.waterlineDoc = waterlineY(s.vh);
    const a = lineAnchor?.getBoundingClientRect();
    s.line = a && a.width + a.height > 0 ? { x: a.left + a.width / 2, y: a.top + y0 } : null;
    const lineX = s.line ? s.line.x / s.vw : 0.7;
    const sections = [...document.querySelectorAll<HTMLElement>("[data-chapter]")];
    s.contentRight = Math.max(0, ...sections.map((el) => el.getBoundingClientRect().right));
    s.chapters = sections.map((el, i) => {
      const top = el.getBoundingClientRect().top + y0;
      return {
        el,
        id: el.id,
        title: el.dataset.title ?? "",
        depth: Number(el.dataset.depth),
        start: i === 0 ? 0 : Math.min(s.maxScroll, Math.max(0, top - s.vh * 0.3)),
        aim: el.dataset.aim ?? null,
      };
    });
    route = buildRoute(
      sections.map((el, i) => ({
        start: s.chapters[i].start,
        route: parseRoute(
          s.small ? el.dataset.routeSm || el.dataset.route : el.dataset.route,
          lineX,
          s.vw
        ),
      })),
      s.maxScroll,
      s.vw,
      s.vh
    );
    // The logo's diver group is translate(497.3 393.4) rotate(40) scale(0.82);
    // the rig pivots at its hips, PIVOT units behind the group's origin.
    const ctm = logo?.getScreenCTM();
    if (ctm && logo?.getClientRects().length) {
      const lx = LOGO_POSE.x + Math.cos(LOGO_POSE.angle) * LOGO_POSE.scale * PIVOT;
      const ly = LOGO_POSE.y + Math.sin(LOGO_POSE.angle) * LOGO_POSE.scale * PIVOT;
      const p = new DOMPoint(lx, ly).matrixTransform(ctm);
      logoPivot = { x: p.x, y: p.y + y0, scale: LOGO_POSE.scale * Math.hypot(ctm.a, ctm.b) };
    } else logoPivot = null;
    ocean.resize(s);
    diver.resize(s);
    computer.build(s);
  }

  // Finale: as the logo rises into view the diver swims into it. A pure
  // function of the camera, so scrolling back up undoes it exactly.
  function finale(): FinaleTarget | null {
    if (!logoPivot) return null;
    const camY = logoPivot.y - s.cam;
    s.finale = Math.min(1, Math.max(0, (s.vh * 1.0 - camY) / (s.vh * 0.55)));
    // Settling hands the diver from the camera to the page itself, so once
    // settled it sits exactly in the logo even while the camera lags.
    const k = s.finale * s.finale * (3 - 2 * s.finale);
    const y = logoPivot.y - (s.cam + (s.scrollY - s.cam) * k);
    return { x: logoPivot.x, y, scale: logoPivot.scale };
  }

  function aimTarget(chapterAim: string | null) {
    const sel = chapterAim ? AIMS[chapterAim] : undefined;
    const el = sel ? document.querySelector(sel) : null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.bottom < 0 || r.top > s.vh) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  let lastMurk = -1;
  let lastFinale = -1;
  function render() {
    const prev = s.cam;
    // The camera follows what is on screen. When the smoother already eases the
    // content, a second lag would leave the diver behind the text.
    s.scrollY = smooth.y();
    s.cam = advanceCamera(s.cam, s.scrollY, s.dt, s.vh, s.reduced || smooth.active());
    s.velocity = s.dt > 0 ? (s.cam - prev) / s.dt : 0;
    Object.assign(s, readDepth(s.chapters, s.cam, s.maxScroll));
    s.murk = Math.min(1, Math.pow(s.depthM / 1600, 0.8));
    if (Math.abs(s.murk - lastMurk) > 0.01) {
      lastMurk = s.murk;
      root.style.setProperty("--murk", s.murk.toFixed(2));
    }
    const pose = route(s.cam);
    // The scene is drawn from the camera, not the scrollbar: during the brief
    // lag the diver and the water move together.
    s.camX = (pose.x - 0.5) * s.vw;
    const target = finale();
    const f = Math.round(s.finale * 100) / 100;
    if (f !== lastFinale) {
      lastFinale = f;
      root.style.setProperty("--finale", String(f));
      reveal?.style.setProperty("--logo", String(f));
    }
    ocean.render(s, diver.position());
    s.beam = diver.update(s, pose, aimTarget(s.chapters[s.index]?.aim ?? null), target);
    lit.update(s.beam);
    computer.update(s);
    sonar?.update(s.t, s.reduced);
  }

  // ---- clock: gsap.ticker while motion is allowed, on demand when it isn't ----
  let ticking = false;
  const tick = (_time: number, deltaMs: number) => {
    s.dt = Math.min(0.05, deltaMs / 1000);
    s.t += s.dt;
    render();
  };
  const startClock = () => {
    if (ticking || s.reduced) return;
    ticking = true;
    gsap.ticker.add(tick);
  };
  const stopClock = () => {
    if (!ticking) return;
    ticking = false;
    gsap.ticker.remove(tick);
  };
  let pending = 0;
  const renderOnce = () => {
    if (ticking || pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      s.dt = 0;
      render();
    });
  };

  // One ScrollTrigger spans the page: its refresh (resize, load, fonts) re-measures
  // the dive; its updates redraw on demand when the clock is stopped.
  const trigger = ScrollTrigger.create({
    start: 0,
    end: "max",
    onUpdate: renderOnce,
    onRefresh: () => {
      measure();
      renderOnce();
    },
  });
  // Content that changes height without a resize (tabs, images) also re-measures.
  let refreshQueued = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(refreshQueued);
    refreshQueued = requestAnimationFrame(() => ScrollTrigger.refresh());
  });
  ro.observe(document.body);

  const mm = gsap.matchMedia();
  // matchMedia runs the callback only while some condition matches: `motion`
  // makes one always match, so every change re-runs it with fresh conditions.
  const media = {
    reduce: "(prefers-reduced-motion: reduce)",
    motion: "(prefers-reduced-motion: no-preference)",
    small: "(max-width: 959px)",
  };
  mm.add(media, (ctx) => {
    s.reduced = !!ctx.conditions?.reduce;
    s.small = !!ctx.conditions?.small;
    // Touch-only devices keep native momentum scrolling.
    const stopSmooth = s.reduced || ScrollTrigger.isTouch === 1 ? null : smooth.start();
    measure();
    if (s.reduced) stopClock();
    else startClock();
    renderOnce();
    return () => stopSmooth?.();
  });

  document.addEventListener("dbdelve:aim", renderOnce, { signal });

  // Read-only view for validation scripts.
  const w = window as Window & { dbdelveExpedition?: unknown };
  w.dbdelveExpedition = {
    state: s,
    route: (c: number) => route(c),
    diver: diver.snapshot,
    smoothing: () => smooth.active(),
  };

  measure();
  s.dt = 0;
  render();
  root.classList.add("ocean-ready");
  startClock();

  return () => {
    root.classList.remove("ocean-ready");
    stopClock();
    cancelAnimationFrame(pending);
    cancelAnimationFrame(refreshQueued);
    ro.disconnect();
    trigger.kill();
    mm.revert();
    lit.destroy();
    delete w.dbdelveExpedition;
  };
}

// The tour's notes: one is pressed at a time, and its spot on the screenshot
// lights up (the diver's flashlight turns toward it).
import { gsap } from "gsap";

import { announceAim } from "@/lib/lifecycle";
import { panelOf, type ShowPanel } from "@/lib/ui/tabs";

export function initTour(root: ParentNode, signal: AbortSignal) {
  for (const panel of root.querySelectorAll<HTMLElement>("[data-spots]")) {
    const notes = [...panel.querySelectorAll<HTMLButtonElement>("[data-note]")];
    const activate = (id: string) => {
      notes.forEach((n) => n.setAttribute("aria-pressed", String(n.dataset.note === id)));
      panel
        .querySelectorAll<HTMLElement>(".spot")
        .forEach((s) => s.classList.toggle("is-active", s.dataset.spot === id));
      announceAim();
    };
    panel.addEventListener(
      "click",
      (e) => {
        const n =
          e.target instanceof Element ? e.target.closest<HTMLButtonElement>("[data-note]") : null;
        if (n?.dataset.note) activate(n.dataset.note);
      },
      { signal }
    );
    if (notes[0]?.dataset.note) activate(notes[0].dataset.note);
  }
}

// Moving between views: the pill slides to the chosen tab, the old view fades
// and drifts away, and the new one settles in from the side it was chosen
// from. Every panel shares one grid cell, so the frame never changes size:
// that needs the idle panels laid out, so once this runs they are marked
// data-off (visibility: hidden, which also keeps them out of the
// accessibility tree and the tab order) instead of hidden (display: none).
// A new choice mid-transition kills the timeline and tweens from wherever
// things are, so rapid clicks never queue or leave a stale panel behind.
const DRIFT = 14; // px
const notesOf = (p: HTMLElement) => p.querySelectorAll<HTMLElement>("[data-note]");
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
// A panel at rest: on or off, interactive, with no tween left on it.
const rest = (p: HTMLElement, off: boolean) => {
  p.toggleAttribute("data-off", off);
  p.hidden = false;
  p.inert = false;
  delete p.dataset.leaving;
  gsap.set([p, ...notesOf(p)], { clearProps: "opacity,transform" });
};

export function initTourTabs(box: HTMLElement, signal: AbortSignal): ShowPanel {
  const tabs = [...box.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const panels = tabs.map(panelOf).filter((p): p is HTMLElement => p !== null);
  const pill = box.querySelector<HTMLElement>("[data-pill]");
  const selected = () => tabs.find((t) => t.getAttribute("aria-selected") === "true") ?? null;

  const place = (tab: HTMLButtonElement, animate: boolean) => {
    if (!pill) return;
    const to = {
      x: tab.offsetLeft,
      y: tab.offsetTop,
      width: tab.offsetWidth,
      height: tab.offsetHeight,
      overwrite: true,
    };
    if (animate && !reducedMotion()) gsap.to(pill, { ...to, duration: 0.42, ease: "power3.out" });
    else gsap.set(pill, to);
  };
  // Tabs reflow (fonts, wrapping on narrow screens): snap the pill back under its tab.
  const ro = new ResizeObserver(() => {
    const t = selected();
    if (t) place(t, false);
  });
  tabs.forEach((t) => ro.observe(t));
  const first = selected();
  if (pill && first) {
    place(first, false);
    box.dataset.pillReady = "";
  }

  for (const p of panels) rest(p, p.hidden !== false || p.hasAttribute("data-off"));
  let tl: gsap.core.Timeline | null = null;

  signal.addEventListener("abort", () => {
    tl?.kill();
    ro.disconnect();
    if (pill) gsap.killTweensOf(pill);
  });

  return (tab, prev) => {
    const next = panelOf(tab);
    if (!next) return;
    place(tab, true);
    const from = prev ? panelOf(prev) : null;
    tl?.kill();
    tl = null;
    for (const p of panels) if (p !== next && p !== from) rest(p, true);
    if (!prev || !from || reducedMotion()) {
      if (from) rest(from, true);
      rest(next, false);
      return;
    }

    const dir = tabs.indexOf(tab) > tabs.indexOf(prev) ? 1 : -1;
    // A panel caught mid-exit is already on screen: carry on from where it is.
    const arriving = next.hasAttribute("data-off");
    from.removeAttribute("data-off");
    from.inert = true;
    from.dataset.leaving = "";
    next.removeAttribute("data-off");
    next.inert = false;
    delete next.dataset.leaving;
    const notes = notesOf(next);
    if (arriving) {
      gsap.set(next, { opacity: 0, x: DRIFT * dir });
      gsap.set(notes, { opacity: 0, y: 6 });
    }

    tl = gsap.timeline({
      onComplete: () => {
        rest(from, true);
        rest(next, false);
        tl = null;
      },
    });
    tl.to(from, { opacity: 0, x: -DRIFT * 0.6 * dir, duration: 0.18, ease: "power2.out" }, 0)
      .to(next, { opacity: 1, x: 0, duration: 0.45, ease: "power3.out" }, 0.08)
      .to(notes, { opacity: 1, y: 0, duration: 0.32, ease: "power2.out", stagger: 0.045 }, 0.14);
  };
}

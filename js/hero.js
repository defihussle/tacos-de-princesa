/* ==========================================================================
   Tacos De Princesa — hero.js
   Home page only. Scroll-driven 2.5D parallax for the layered hero art.
   Needs GSAP + ScrollTrigger (loaded from the CDN before this file in
   index.html). Without them, or with prefers-reduced-motion, it does
   nothing and the hero stays still.

   The hero scrolls normally (no pin); while it scrolls out of view the
   layers move apart (scrubbed, so they follow the scrollbar).
   Tune the moves in LAYER_MOTION below.
   ========================================================================== */

(function () {
  'use strict';

  const hero = document.querySelector('[data-hero]');
  if (!hero || !window.gsap || !window.ScrollTrigger) return;

  gsap.registerPlugin(ScrollTrigger);

  // Each move runs over the hero's scroll out of view. yPercent/xPercent are a
  // percentage of the layer (the art frame), so they scale with the screen;
  // on desktop 1% of the frame is roughly 9px.
  //
  // The face (base) and the hair's face-hole are cut to fit each other, so
  // they rise together as one character (-8%) and the hair only adds a
  // little on top. Push the hair much further and the hole slides off the
  // face: first the dark seam backing shows beside it as a flat patch, then
  // the wall. Bigger hair moves need re-exported art with the back hair
  // painted behind the face.
  //
  // The hair values were checked at every 5-10% of the scroll: no wall shows
  // round the face, and the strongest sway sits mid-scroll; the end pose
  // (where the scroll stops) stays close to rest.
  const LAYER_MOTION = {
    bg:        { yPercent: 5, scale: 1.02 },
    character: { yPercent: -8 },               // base + hair together
    hair:      { yPercent: -3, xPercent: 1.2 } // extra; xPercent 1.2 ≈ 11px on desktop
  };
  // Hair sway and wave, as keyframes across the scroll (starts at rest)
  const HAIR_SWAY = { rotation: [0, -2.5, 0.6], skewX: [0, 1.2, -0.4] };

  const SCROLL_END = 'bottom top'; // animation ends as the hero's bottom leaves the top
  const SCRUB = 0.8;               // seconds the layers take to catch up
  const CUE_HIDE_AFTER = 8;        // px scrolled before the "Scroll" cue fades

  const layer = function (name) {
    return hero.querySelector('[data-hero-layer="' + name + '"]');
  };
  const character = hero.querySelector('[data-hero-character]');
  const scrollCue = hero.querySelector('[data-hero-scroll]');

  // gsap.matchMedia reverts everything (kills triggers, clears transforms)
  // if the user switches reduced motion on while the page is open.
  gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', function () {
    const tl = gsap.timeline({
      defaults: { ease: 'none', duration: 1 },
      scrollTrigger: {
        trigger: hero,
        start: 'top top',
        end: SCROLL_END,
        scrub: SCRUB
      }
    });

    tl.to(layer('bg'), LAYER_MOTION.bg, 0)
      .to(character, LAYER_MOTION.character, 0)
      .to(layer('hair'), LAYER_MOTION.hair, 0)
      .to(layer('hair'), { keyframes: HAIR_SWAY, ease: 'sine.inOut' }, 0);

    // Not scrubbed, so the cue goes as soon as scrolling starts and comes
    // back at the very top. Measured from the parallax start, with explicit
    // targets because the cue may still be mid fade-in from CSS.
    if (scrollCue) {
      const fadeCue = function (alpha) {
        return function () {
          gsap.to(scrollCue, { autoAlpha: alpha, duration: 0.25, ease: 'power1.out', overwrite: true });
        };
      };
      ScrollTrigger.create({
        start: function () { return tl.scrollTrigger.start + CUE_HIDE_AFTER; },
        end: 'max',
        onEnter: fadeCue(0),
        onLeaveBack: fadeCue(1)
      });
    }
  });
})();

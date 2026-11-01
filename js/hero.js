/* ==========================================================================
   Tacos De Princesa — hero.js
   Home page only. Scroll-driven 2.5D parallax for the layered hero art,
   plus a light idle wind in the hair.
   Needs GSAP + ScrollTrigger (loaded from the CDN before this file in
   index.html). Without them, or with prefers-reduced-motion, it does
   nothing and the hero stays still.

   The hero scrolls normally (no pin); while it scrolls out of view the
   layers move apart (scrubbed, so they follow the scrollbar). When the page
   is still, the hair sways gently; it fades out while scrolling.
   Tune the moves in LAYER_MOTION, HAIR_SWAY and WIND below.
   ========================================================================== */

(function () {
  'use strict';

  const hero = document.querySelector('[data-hero]');
  if (!hero || !window.gsap || !window.ScrollTrigger) return;

  gsap.registerPlugin(ScrollTrigger);

  // Each move runs over the hero's scroll out of view. yPercent and the
  // --hair-x/-y values are a percentage of the art frame, so they scale with
  // the screen; on desktop 1% of the frame is roughly 9px.
  //
  // The face (base) and the hair's face-hole are cut to fit each other, so
  // they rise together as one character and the hair adds its own lift,
  // shift and sway on top. The hair is moved through CSS variables on the
  // character (see .hero__character in styles.css) so the dark seam backing
  // under the face-hole moves with it and the wall never shows through.
  // Push the hair much further and the face slides visibly inside the hole,
  // showing the backing as a flat dark patch beside it.
  //
  // The face is off screen by about 40% of the scroll, so the character
  // rise and hair moves ease out (most of the travel early) and the sway
  // peaks at 40%.
  //
  // The hair values were checked at every 10% of the scroll, at the idle
  // wind's extremes too: no wall shows round the face.
  const LAYER_MOTION = {
    bg:        { yPercent: 8, scale: 1.04 },
    character: { yPercent: -12, ease: 'power1.out' },                // base + hair together
    hair:      { '--hair-y': -8, '--hair-x': 3.2, ease: 'power2.out' } // extra lift and shift
  };
  // Hair sway and wave (degrees) across the scroll, from rest
  const HAIR_SWAY = {
    '40%':  { '--hair-rot': -6.5, '--hair-skew': 3.2 },
    '100%': { '--hair-rot': 2,    '--hair-skew': -1.2 },
    easeEach: 'sine.inOut'
  };

  // Idle wind: the hair drifts sideways (% of the frame) and tilts (degrees)
  // either side of rest, on two out-of-step loops so it never quite repeats.
  const WIND = {
    x:   { amount: 0.4, duration: 4.6 },
    rot: { amount: 0.8, duration: 6.2 }
  };
  const WIND_IN = 1.6;   // seconds to fade the wind back in once scrolling stops
  const WIND_OUT = 0.35; // seconds to fade it out when scrolling starts

  const SCROLL_END = 'bottom top'; // animation ends as the hero's bottom leaves the top
  const SCRUB = 0.8;               // seconds the layers take to catch up
  const CUE_HIDE_AFTER = 8;        // px scrolled before the "Scroll" cue fades
  const INTRO = 2.2;               // seconds of the CSS on-load settle (hero-intro)

  const layer = function (name) {
    return hero.querySelector('[data-hero-layer="' + name + '"]');
  };
  const character = hero.querySelector('[data-hero-character]');
  const scrollCue = hero.querySelector('[data-hero-scroll]');

  // gsap.matchMedia reverts everything (kills triggers and tweens, clears
  // transforms) if the user switches reduced motion on while the page is open.
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
      .to(character, LAYER_MOTION.hair, 0)
      .to(character, { keyframes: HAIR_SWAY }, 0);

    // Idle wind. --wind (0-1) scales both loops, so fading it in and out
    // blends the wind with the scroll pose instead of jumping.
    const windLoops = [
      gsap.fromTo(character, { '--wind-x': -WIND.x.amount }, {
        '--wind-x': WIND.x.amount, duration: WIND.x.duration,
        ease: 'sine.inOut', repeat: -1, yoyo: true
      }),
      gsap.fromTo(character, { '--wind-rot': WIND.rot.amount }, {
        '--wind-rot': -WIND.rot.amount, duration: WIND.rot.duration,
        ease: 'sine.inOut', repeat: -1, yoyo: true
      })
    ];
    // Only run the loops while the hero is on screen
    ScrollTrigger.create({
      trigger: hero,
      start: 'top bottom',
      end: 'bottom top',
      onToggle: function (self) {
        windLoops.forEach(function (loop) { self.isActive ? loop.resume() : loop.pause(); });
      }
    });
    const setWind = function (strength, duration, delay) {
      gsap.to(character, {
        '--wind': strength, duration: duration, delay: delay || 0,
        ease: 'sine.inOut', overwrite: 'auto'
      });
    };
    setWind(1, WIND_IN, INTRO); // starts once the on-load settle ends

    // Fade out when scrolling starts; back in once it stops and the scrub
    // has caught up.
    const onScrollStart = function () { setWind(0, WIND_OUT); };
    const onScrollEnd = function () { setWind(1, WIND_IN, SCRUB); };
    ScrollTrigger.addEventListener('scrollStart', onScrollStart);
    ScrollTrigger.addEventListener('scrollEnd', onScrollEnd);

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

    return function () {
      ScrollTrigger.removeEventListener('scrollStart', onScrollStart);
      ScrollTrigger.removeEventListener('scrollEnd', onScrollEnd);
    };
  });
})();

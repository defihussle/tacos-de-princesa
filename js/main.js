/* ==========================================================================
   Tacos De Princesa — main.js
   Small, dependency-free enhancements shared by every page.
   JS hooks use data-* attributes; classes are left to styling.

   0. Site config (online ordering URL)
   1. Navigation (slide-in panel)
   2. Header background on scroll
   3. Reveal-on-scroll for [data-reveal] elements
   4. Footer year
   5. Placeholder form handling (until a real form backend is connected)
   6. Order links
   7. Refresh starts at the top
   8. Menu category tabs
   ========================================================================== */

(function () {
  'use strict';

  /* ---- 0. Site config ------------------------------------------------- */

  // Paste the real online-ordering URL here when it's ready. Every link marked
  // [data-order-link] (nav pill, hero, CTA strip, footer, menu page) will use it.
  // While empty, those links go to the Order section on the home page.
  const ORDER_URL = '';

  const header = document.querySelector('[data-header]');
  const toggle = document.querySelector('[data-nav-toggle]');
  const nav = document.querySelector('[data-nav]');
  const backdrop = document.querySelector('[data-nav-backdrop]');

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');


  /* ---- 1. Navigation -------------------------------------------------- */

  function isMenuOpen() {
    return nav.classList.contains('is-open');
  }

  function setMenu(open) {
    nav.classList.toggle('is-open', open);
    backdrop.classList.toggle('is-visible', open);
    document.body.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }

  if (header && toggle && nav && backdrop) {
    toggle.addEventListener('click', function () {
      const open = !isMenuOpen();
      setMenu(open);
      if (open) nav.querySelector('a').focus();
    });

    // Tap outside the panel to close
    backdrop.addEventListener('click', function () {
      setMenu(false);
    });

    // Close after choosing a link (covers same-page anchors like #order)
    nav.addEventListener('click', function (event) {
      if (event.target.closest('a')) setMenu(false);
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && isMenuOpen()) {
        setMenu(false);
        toggle.focus();
      }
    });

    // Close if keyboard focus tabs out of the header/menu
    header.addEventListener('focusout', function (event) {
      if (isMenuOpen() && event.relatedTarget && !header.contains(event.relatedTarget)) {
        setMenu(false);
      }
    });

  }


  /* ---- 2. Header background on scroll --------------------------------- */

  const SCROLL_OFFSET = 40; // px scrolled before the header gets its background
  let ticking = false;

  function updateHeader() {
    header.classList.toggle('is-scrolled', window.scrollY > SCROLL_OFFSET);
    ticking = false;
  }

  if (header) {
    window.addEventListener('scroll', function () {
      if (!ticking) {
        window.requestAnimationFrame(updateHeader);
        ticking = true;
      }
    }, { passive: true });

    updateHeader(); // correct state if the page loads mid-scroll
  }


  /* ---- 3. Reveal on scroll -------------------------------------------- */

  const revealEls = document.querySelectorAll('[data-reveal]');

  if ('IntersectionObserver' in window && !reducedMotion.matches) {
    const observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -10% 0px' });

    revealEls.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    revealEls.forEach(function (el) {
      el.classList.add('is-visible');
    });
  }


  /* ---- 4. Footer year ------------------------------------------------- */

  document.querySelectorAll('[data-year]').forEach(function (el) {
    el.textContent = new Date().getFullYear();
  });


  /* ---- 5. Placeholder forms ------------------------------------------- */
  // Forms marked [data-demo-form] show a message instead of submitting.
  // Once a form posts to a real endpoint, remove its data-demo-form attribute.

  document.querySelectorAll('[data-demo-form]').forEach(function (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      const status = form.querySelector('[data-form-status]');
      if (status) {
        status.textContent = 'Thanks! This form isn’t connected yet — please call or email us for now.';
      }
      form.reset();
    });
  });


  /* ---- 6. Order links ------------------------------------------------- */

  if (ORDER_URL) {
    document.querySelectorAll('[data-order-link]').forEach(function (link) {
      link.href = ORDER_URL;
    });
  }


  /* ---- 7. Refresh starts at the top ----------------------------------- */
  // A reload would otherwise reopen at the last scroll position, or at the
  // #section left in the URL by an in-page link. Arriving from another page
  // (e.g. catering.html -> index.html#menu) still goes to that section.

  const navEntry = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];

  if (navEntry && navEntry.type === 'reload') {
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);

    const toTop = function () {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    };
    toTop();
    window.addEventListener('load', toTop);
  }


  /* ---- 8. Menu category tabs ------------------------------------------ */
  // The category chips ([data-menu-tab]) show one .menu-category at a time,
  // starting with the first (Birria). Without JS every category shows.

  const menuTabs = Array.prototype.slice.call(document.querySelectorAll('[data-menu-tab]'));

  if (menuTabs.length) {
    const panels = menuTabs.map(function (tab) {
      return document.getElementById(tab.getAttribute('href').slice(1));
    });

    const showCategory = function (index) {
      menuTabs.forEach(function (tab, i) {
        const active = i === index;
        if (active) tab.setAttribute('aria-current', 'true');
        else tab.removeAttribute('aria-current');
        if (panels[i]) {
          panels[i].hidden = !active;
          // Already on screen, so skip the fade-up reveal
          if (active) panels[i].classList.add('is-visible');
        }
      });
    };

    panels[0].parentElement.classList.add('menu--tabs');
    showCategory(0);

    menuTabs.forEach(function (tab, i) {
      tab.addEventListener('click', function (event) {
        event.preventDefault();
        showCategory(i);
      });
    });
  }
})();

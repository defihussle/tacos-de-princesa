/* ==========================================================================
   Tacos De Princesa — order.js
   Online ordering for pickup (order.html): menu, item options, cart, pickup
   details and the payment step. Prices are in cents to keep the maths exact.

   0.  Config (tax, pickup timing, locations)
   1.  Menu data
   2.  Helpers
   3.  Cart (saved in this browser)
   4.  Menu + category chips
   5.  Item dialog
   6.  Cart rendering
   7.  Phone cart sheet
   8.  Steps (menu -> pickup -> payment)
   9.  Pickup times
   10. Pickup form
   11. Payment step
   ========================================================================== */

(function () {
  'use strict';

  /* ---- 0. Config ------------------------------------------------------ */

  const CONFIG = {
    taxRate: 0.13,           // Ontario HST: confirm with the accountant before launch
    taxLabel: 'HST (13%)',
    timeZone: 'America/Toronto',
    slotMinutes: 15,         // pickup times every 15 minutes
    // The backend sends each order to the KDS this many minutes before its
    // pickup time, so the first slot of the day is at least this long after
    // opening, and today's slots start at least this long from now.
    kitchenLeadMinutes: 20,
    lastSlotBeforeClose: 15, // last pickup slot = closing time minus this
    daysAhead: 7,            // when closed, look this far ahead for the next open day
    storageKey: 'tdp-order-cart-v1',
  };

  // Hours match the footer. days: 0 = Sunday ... 6 = Saturday.
  const LOCATIONS = {
    'king-st-w': {
      name: 'King St W',
      address: '150 King St W, in the PATH',
      hours: { days: [1, 2, 3, 4, 5], open: '10:30', close: '18:00' },
    },
    'one-york': {
      name: 'One York',
      address: 'One York Street, 2nd Floor',
      hours: { days: [1, 2, 3, 4, 5], open: '10:30', close: '18:00' },
    },
  };


  /* ---- 1. Menu data --------------------------------------------------- */

  function opt(label, price, none) {
    return { label: label, price: price || 0, none: !!none };
  }

  const TACO_FILLINGS = ['Pollo', 'Carne Asada', 'Barbacoa', 'Surf + Turf', 'Pescado', 'Camarón', 'Veggie Chorizo'];

  // Option groups, used by key in MENU below. 'one' = pick exactly one (the
  // first is preselected); 'many' = pick any. Options marked none (e.g.
  // "No protein") are left off the cart line.
  // PLACEHOLDERS until the kitchen confirms them: 'prep' and 'dressing'.
  const GROUPS = {
    prep: { title: 'Make it your way', type: 'many', options: [opt('No onions'), opt('No cilantro'), opt('Extra cilantro'), opt('Salsa on the side')] },
    extraBirria: { title: 'Extras', type: 'many', options: [opt('Extra birria taco', 500)] },
    tacoExtras: { title: 'Extras', type: 'many', options: [opt('Extra taco', 400), opt('Add cheese', 100)] },
    filling: { title: 'Choose your taco', type: 'one', options: TACO_FILLINGS.map(function (n) { return opt(n); }) },
    style: { title: 'Bowl or wrap', type: 'one', options: [opt('Bowl'), opt('Wrap')] },
    guac: { title: 'Extras', type: 'many', options: [opt('Add guacamole', 300)] },
    dressing: { title: 'Dressing', type: 'one', options: [opt('House vinaigrette'), opt('Cilantro lime'), opt('Chipotle ranch')] },
    protein: { title: 'Add a protein', type: 'one', options: [opt('No protein', 0, true), opt('Pollo', 400), opt('Carne Asada', 500), opt('Pescado', 500), opt('Camarón', 600), opt('Veggie Chorizo', 500), opt('Surf + Turf', 800)] },
    base: { title: 'Nachos or fries', type: 'one', options: [opt('Nachos'), opt('Fries')] },
  };

  ['1', '2', '3'].forEach(function (n) {
    GROUPS['mix' + n] = { title: 'Taco ' + n, type: 'one', options: ['Birria'].concat(TACO_FILLINGS).map(function (f) { return opt(f); }) };
  });

  // Prices match the menu on index.html (One York TV menu, Nov 2026).
  // suffix names the dish in the cart ("Pollo" + "Burrito"); nameFrom adds
  // that group's choice to the name instead ("Pollo Loaded" + "Fries").
  // groups apply to every item in the category unless the item lists its own.
  const MENU = [
    {
      id: 'birria', name: 'Birria Tacos', note: 'Pulled brisket with onions + cilantro', suffix: '',
      items: [
        { id: 'birria-tacos', name: 'Birria Tacos', desc: 'Three tacos of pulled brisket with onions and cilantro.', price: 1900, tag: 'Signature', groups: ['extraBirria', 'prep'] },
        { id: 'single-birria', name: 'Single Birria', desc: 'One birria taco with onions and cilantro.', price: 700, groups: ['prep'] },
        { id: 'mix-match', name: 'Mix & Match', desc: 'Any 3 tacos, birria included.', price: 2000, groups: ['mix1', 'mix2', 'mix3', 'prep'] },
      ],
    },
    {
      id: 'tacos', name: 'Tacos', note: '3 tacos served with salsa verde + chipotle crema', suffix: 'Tacos', groups: ['tacoExtras', 'prep'],
      items: [
        { id: 'pollo', name: 'Pollo', desc: 'Chicken, onions, tomatoes, cilantro.', price: 1500 },
        { id: 'carne-asada', name: 'Carne Asada', desc: 'Steak, onions, cilantro.', price: 1600 },
        { id: 'barbacoa', name: 'Barbacoa', desc: 'Pulled beef, onions, cilantro.', price: 1700 },
        { id: 'surf-turf', name: 'Surf + Turf', desc: 'Shrimp, steak, onions, cilantro.', price: 1800 },
        { id: 'pescado', name: 'Pescado', desc: 'Fish, red cabbage, onions, tomatoes, cilantro.', price: 1600 },
        { id: 'camaron', name: 'Camarón', desc: 'Shrimp, red cabbage, onions, tomatoes, cilantro.', price: 1700 },
        { id: 'veggie-chorizo', name: 'Veggie Chorizo', desc: 'Plant-based protein, tomatoes, bell peppers, onions, cilantro.', price: 1600, veg: true },
        { id: 'single-taco', name: 'Single Taco', fullName: 'Single Taco', desc: 'One taco, any filling.', price: 700, groups: ['filling', 'prep'] },
      ],
    },
    {
      id: 'burritos', name: 'Burritos', note: 'Bowl or wrap', suffix: 'Burrito', groups: ['style', 'guac', 'prep'],
      items: [
        { id: 'pollo', name: 'Pollo', desc: 'Chicken.', price: 1500 },
        { id: 'carne-asada', name: 'Carne Asada', desc: 'Steak.', price: 1600 },
        { id: 'barbacoa', name: 'Barbacoa', desc: 'Pulled beef.', price: 1700 },
        { id: 'surf-turf', name: 'Surf + Turf', desc: 'Shrimp and steak.', price: 1800 },
        { id: 'pescado', name: 'Pescado', desc: 'Fish.', price: 1600 },
        { id: 'camaron', name: 'Camarón', desc: 'Shrimp.', price: 1700 },
        { id: 'veggie-chorizo', name: 'Veggie Chorizo', desc: 'Plant-based protein.', price: 1600, veg: true },
      ],
    },
    {
      id: 'ensaladas', name: 'Ensaladas', note: 'With your choice of dressing', suffix: 'Ensalada', groups: ['dressing', 'protein', 'prep'],
      items: [
        { id: 'fiesta', name: 'Fiesta', desc: 'Arugula, mango, avocado, bell peppers, cherry tomatoes, red onions, cotija cheese, almonds.', price: 1200 },
        { id: 'santa-fe', name: 'Santa Fe', desc: 'Lettuce, black beans, corn, red onions, cherry tomatoes, tortilla strips.', price: 1200 },
        { id: 'quinoa', name: 'Jalapeño Lime Quinoa', desc: 'Kale, quinoa, corn, black beans, pickled onions, bell peppers, jalapeños, cilantro, pumpkin seeds.', price: 1200 },
        { id: 'pineapple', name: 'Charred Pineapple & Bean', desc: 'Mixed greens, pineapple, black beans, corn, peppers, cilantro, cashews.', price: 1200 },
      ],
    },
    {
      id: 'quesadillas', name: 'Quesadillas', note: 'Cheese, onions + peppers', suffix: 'Quesadilla', groups: ['prep'],
      items: [
        { id: 'classic', name: 'Classic', desc: 'Cheese.', price: 1400, veg: true },
        { id: 'pollo', name: 'Pollo', desc: 'Chicken.', price: 1500 },
        { id: 'carne-asada', name: 'Carne Asada', desc: 'Steak.', price: 1600 },
        { id: 'barbacoa', name: 'Barbacoa', desc: 'Pulled beef.', price: 1700 },
        { id: 'surf-turf', name: 'Surf + Turf', desc: 'Shrimp and steak.', price: 1800 },
        { id: 'camaron', name: 'Camarón', desc: 'Shrimp.', price: 1700 },
        { id: 'veggie-chorizo', name: 'Veggie Chorizo', desc: 'Plant-based protein.', price: 1600, veg: true },
      ],
    },
    {
      id: 'nachos', name: 'Nachos & Fries', note: 'Cheese, tomatoes, green onions + sour cream', suffix: 'Loaded', nameFrom: 'base', groups: ['base', 'prep'],
      items: [
        { id: 'classic', name: 'Classic', desc: 'Cheese.', price: 1000, veg: true },
        { id: 'pollo', name: 'Pollo', desc: 'Chicken.', price: 1200 },
        { id: 'carne-asada', name: 'Carne Asada', desc: 'Beef.', price: 1300 },
        { id: 'veggie-chorizo', name: 'Veggie Chorizo', desc: 'Plant-based protein.', price: 1300, veg: true },
      ],
    },
  ];

  // Flat lookup: 'tacos/pollo' -> item, with its category's name and groups filled in
  const ITEMS = {};
  MENU.forEach(function (cat) {
    cat.items.forEach(function (item) {
      item.key = cat.id + '/' + item.id;
      item.groups = item.groups || cat.groups || [];
      item.fullName = item.fullName || (cat.suffix ? item.name + ' ' + cat.suffix : item.name);
      item.nameFrom = cat.nameFrom;
      ITEMS[item.key] = item;
    });
  });


  /* ---- 2. Helpers ----------------------------------------------------- */

  const money = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' });

  function fmt(cents) {
    return money.format(cents / 100);
  }

  function esc(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }

  function $all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  const desktop = window.matchMedia('(min-width: 900px)');
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');


  /* ---- 3. Cart -------------------------------------------------------- */
  // A line is { id, item (key), qty, mods: [{ g, label }], note }. Prices are
  // always looked up from MENU/GROUPS, so a saved cart picks up price changes.

  function findOption(groupKey, label) {
    const group = GROUPS[groupKey];
    return group && group.options.filter(function (o) { return o.label === label; })[0];
  }

  function unitPrice(line) {
    return ITEMS[line.item].price + line.mods.reduce(function (sum, m) {
      return sum + findOption(m.g, m.label).price;
    }, 0);
  }

  // The dish's name in the cart, e.g. "Pollo Burrito" or "Pollo Loaded Fries"
  function lineName(line) {
    const item = ITEMS[line.item];
    const named = item.nameFrom && line.mods.filter(function (m) { return m.g === item.nameFrom; })[0];
    return named ? item.fullName + ' ' + named.label : item.fullName;
  }

  // Lines with the same dish, options and note merge into one
  function signature(line) {
    return JSON.stringify([line.item, line.mods, line.note]);
  }

  function loadCart() {
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG.storageKey)) || [];
      return saved.filter(function (line) {
        return line && ITEMS[line.item] && line.qty > 0 && Array.isArray(line.mods) &&
          line.mods.every(function (m) { return findOption(m.g, m.label); });
      });
    } catch (e) {
      return [];
    }
  }

  function saveCart() {
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(cart));
    } catch (e) { /* private mode etc.: the cart just won't survive a reload */ }
  }

  let cart = loadCart();
  let nextId = 1;
  cart.forEach(function (line) { line.id = 'l' + nextId++; });

  function totals() {
    const subtotal = cart.reduce(function (sum, line) { return sum + unitPrice(line) * line.qty; }, 0);
    const tax = Math.round(subtotal * CONFIG.taxRate);
    return {
      count: cart.reduce(function (n, line) { return n + line.qty; }, 0),
      subtotal: subtotal,
      tax: tax,
      total: subtotal + tax,
    };
  }

  function addToCart(line) {
    const sig = signature(line);
    const same = cart.filter(function (l) { return signature(l) === sig; })[0];
    if (same) same.qty += line.qty;
    else cart.push(Object.assign({ id: 'l' + nextId++ }, line));
    saveCart();
    renderCart();
  }


  /* ---- 4. Menu + category chips --------------------------------------- */

  const menuRoot = $('[data-menu]');
  const catNav = $('[data-cat-nav]');

  function dishHTML(item) {
    const vegTag = item.veg ? ' <span class="tag">V</span>' : '';
    const tag = item.tag ? ' <span class="tag">' + esc(item.tag) + '</span>' : '';
    return '<article class="dish">' +
      '<h3 class="dish__name">' + esc(item.name) + vegTag + tag + '</h3>' +
      (item.desc ? '<p class="dish__desc">' + esc(item.desc) + '</p>' : '') +
      '<div class="dish__foot">' +
        '<span class="dish__price">' + fmt(item.price) + '</span>' +
        '<button class="dish__add" type="button" aria-haspopup="dialog" aria-label="Add ' + esc(item.fullName) + ', ' + fmt(item.price) + '" data-add="' + item.key + '">' +
          'Add <span aria-hidden="true">+</span>' +
        '</button>' +
      '</div>' +
    '</article>';
  }

  menuRoot.innerHTML = MENU.map(function (cat) {
    return '<section class="order-cat" id="cat-' + cat.id + '" aria-labelledby="cat-' + cat.id + '-title" data-cat>' +
      '<div class="order-cat__head">' +
        '<h2 id="cat-' + cat.id + '-title">' + esc(cat.name) + '</h2>' +
        (cat.note ? '<p>' + esc(cat.note) + '</p>' : '') +
      '</div>' +
      '<div class="dishes">' + cat.items.map(dishHTML).join('') + '</div>' +
    '</section>';
  }).join('');

  catNav.innerHTML = MENU.map(function (cat) {
    return '<a class="chip" href="#cat-' + cat.id + '" data-cat-link>' + esc(cat.name) + '</a>';
  }).join('');

  const catLinks = $all('[data-cat-link]', catNav);
  const catSections = $all('[data-cat]', menuRoot);

  function setActiveCat(index) {
    catLinks.forEach(function (link, i) {
      if (i === index) link.setAttribute('aria-current', 'true');
      else link.removeAttribute('aria-current');
    });
    // Keep the active chip in view inside the sideways-scrolling bar
    const chip = catLinks[index];
    const left = chip.offsetLeft - (catNav.clientWidth - chip.offsetWidth) / 2;
    catNav.scrollTo({ left: left, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }

  catLinks.forEach(function (link, i) {
    link.addEventListener('click', function (event) {
      event.preventDefault();
      setActiveCat(i);
      catSections[i].scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    });
  });

  // Scroll spy: the active chip is the last category whose top has passed
  // the sticky chip bar
  let activeCat = -1;
  let spyTicking = false;

  function updateActiveCat() {
    spyTicking = false;
    if (document.body.dataset.step !== 'menu') return;
    const line = catNav.getBoundingClientRect().bottom + 24;
    let index = 0;
    catSections.forEach(function (section, i) {
      if (section.getBoundingClientRect().top <= line) index = i;
    });
    if (index !== activeCat) {
      activeCat = index;
      setActiveCat(index);
    }
  }

  window.addEventListener('scroll', function () {
    if (!spyTicking) {
      window.requestAnimationFrame(updateActiveCat);
      spyTicking = true;
    }
  }, { passive: true });

  updateActiveCat();


  /* ---- 5. Item dialog ------------------------------------------------- */

  const dialog = $('[data-item-dialog]');
  const itemForm = $('[data-item-form]');
  const groupsRoot = $('[data-item-groups]');
  const qtyOut = $('[data-qty]');
  const noteInput = $('[data-item-note]');
  const MAX_QTY = 20;
  let current = null; // { item, qty }

  function groupHTML(key) {
    const group = GROUPS[key];
    const one = group.type === 'one';
    return '<fieldset class="opt-group" data-group="' + key + '">' +
      '<legend class="opt-group__title">' + esc(group.title) +
        '<span class="opt-group__badge' + (one ? ' opt-group__badge--required' : '') + '">' + (one ? 'Required' : 'Optional') + '</span>' +
      '</legend>' +
      group.options.map(function (o, i) {
        return '<label class="opt">' +
          '<input type="' + (one ? 'radio' : 'checkbox') + '" name="g-' + key + '" value="' + i + '"' + (one && i === 0 ? ' checked' : '') + '>' +
          '<span class="opt__label">' + esc(o.label) + '</span>' +
          (o.price ? '<span class="opt__price">+' + fmt(o.price) + '</span>' : '') +
        '</label>';
      }).join('') +
    '</fieldset>';
  }

  function chosenMods() {
    const mods = [];
    $all('[data-group]', groupsRoot).forEach(function (fieldset) {
      const key = fieldset.dataset.group;
      $all('input:checked', fieldset).forEach(function (input) {
        mods.push({ g: key, label: GROUPS[key].options[+input.value].label });
      });
    });
    return mods;
  }

  function updateDialog() {
    const unit = unitPrice({ item: current.item.key, mods: chosenMods() });
    qtyOut.textContent = current.qty;
    $('[data-qty-step="-1"]', dialog).disabled = current.qty <= 1;
    $('[data-qty-step="1"]', dialog).disabled = current.qty >= MAX_QTY;
    $('[data-item-total]', dialog).textContent = fmt(unit * current.qty);
  }

  function openItem(key) {
    const item = ITEMS[key];
    current = { item: item, qty: 1 };
    $('[data-item-name]', dialog).textContent = item.fullName;
    $('[data-item-price]', dialog).textContent = fmt(item.price);
    $('[data-item-desc]', dialog).textContent = item.desc || '';
    groupsRoot.innerHTML = item.groups.map(groupHTML).join('');
    noteInput.value = '';
    updateDialog();
    dialog.showModal();
    $('.item-dialog__body', dialog).scrollTop = 0;
  }

  menuRoot.addEventListener('click', function (event) {
    const button = event.target.closest('[data-add]');
    if (button) openItem(button.dataset.add);
  });

  groupsRoot.addEventListener('change', updateDialog);

  $all('[data-qty-step]', dialog).forEach(function (button) {
    button.addEventListener('click', function () {
      current.qty = Math.min(MAX_QTY, Math.max(1, current.qty + Number(button.dataset.qtyStep)));
      updateDialog();
    });
  });

  $('[data-item-close]', dialog).addEventListener('click', function () {
    dialog.close();
  });

  // Click on the dimmed backdrop closes it (the form fills the dialog box)
  dialog.addEventListener('click', function (event) {
    if (event.target === dialog) dialog.close();
  });

  itemForm.addEventListener('submit', function (event) {
    event.preventDefault();
    const line = {
      item: current.item.key,
      qty: current.qty,
      mods: chosenMods(),
      note: noteInput.value.trim(),
    };
    addToCart(line);
    dialog.close();
    toast('Added ' + (line.qty > 1 ? line.qty + ' × ' : '') + lineName(line));
  });

  // "Added to your order" message
  const toastEl = $('[data-toast]');
  let toastTimer;

  function toast(message) {
    toastEl.textContent = message;
    toastEl.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-visible');
    }, 2400);
  }


  /* ---- 6. Cart rendering ---------------------------------------------- */

  const cartEl = $('[data-cart]');
  const linesEl = $('[data-cart-lines]');
  const checkoutBtn = $('[data-checkout]');
  const bar = $('[data-cart-bar]');
  const barBtn = $('[data-cart-open]');

  $('[data-tax-label]').textContent = CONFIG.taxLabel;

  // Options shown under the name (not "No protein", not the one in the name)
  function modsText(line) {
    return line.mods.filter(function (m) {
      return !findOption(m.g, m.label).none && m.g !== ITEMS[line.item].nameFrom;
    }).map(function (m) {
      const price = findOption(m.g, m.label).price;
      return esc(m.label) + (price ? ' (+' + fmt(price) + ')' : '');
    }).join(' &middot; ');
  }

  function lineHTML(line) {
    const name = lineName(line);
    const mods = modsText(line);
    return '<li class="cart-line" data-line="' + line.id + '">' +
      '<div class="cart-line__top">' +
        '<span class="cart-line__name">' + esc(name) + '</span>' +
        '<span class="cart-line__price">' + fmt(unitPrice(line) * line.qty) + '</span>' +
      '</div>' +
      (mods ? '<p class="cart-line__mods">' + mods + '</p>' : '') +
      (line.note ? '<p class="cart-line__note">&ldquo;' + esc(line.note) + '&rdquo;</p>' : '') +
      '<div class="cart-line__actions">' +
        '<div class="qty qty--sm" role="group" aria-label="Quantity of ' + esc(name) + '">' +
          '<button class="qty__btn" type="button" aria-label="One less" data-line-step="-1"' + (line.qty <= 1 ? ' disabled' : '') + '>&minus;</button>' +
          '<span class="qty__value">' + line.qty + '</span>' +
          '<button class="qty__btn" type="button" aria-label="One more" data-line-step="1"' + (line.qty >= MAX_QTY ? ' disabled' : '') + '>+</button>' +
        '</div>' +
        '<button class="cart-line__remove" type="button" data-line-remove>Remove</button>' +
      '</div>' +
    '</li>';
  }

  function renderCart() {
    const t = totals();
    linesEl.innerHTML = cart.map(lineHTML).join('');
    $('[data-cart-empty]').hidden = cart.length > 0;
    $('[data-subtotal]').textContent = fmt(t.subtotal);
    $('[data-tax]').textContent = fmt(t.tax);
    $('[data-total]').textContent = fmt(t.total);
    checkoutBtn.disabled = !cart.length;
    $('[data-pay]').textContent = 'Pay ' + fmt(t.total);

    // Phone order bar: shown once there's something in the cart
    $('[data-cart-count]').textContent = t.count;
    $('[data-cart-bar-total]').textContent = fmt(t.total);
    $('[data-cart-bar-label]').textContent = document.body.dataset.step === 'menu' ? 'View order' : 'Order summary';
    bar.hidden = !cart.length;
    if (!cart.length) setSheet(false);

    // Emptied the cart part-way through checkout: back to the menu
    if (!cart.length && document.body.dataset.step !== 'menu') goTo('menu');
    if (document.body.dataset.step === 'payment') renderRecap();
  }

  linesEl.addEventListener('click', function (event) {
    const button = event.target.closest('button');
    const row = event.target.closest('[data-line]');
    if (!button || !row) return;
    const index = cart.findIndex(function (l) { return l.id === row.dataset.line; });
    if (index < 0) return;

    if (button.hasAttribute('data-line-remove')) {
      const name = lineName(cart[index]);
      cart.splice(index, 1);
      saveCart();
      renderCart();
      toast('Removed ' + name);
      // Focus would otherwise be lost with the removed row
      const next = linesEl.querySelectorAll('[data-line-remove]')[Math.min(index, cart.length - 1)];
      (next || (desktop.matches ? checkoutBtn : $('[data-cart-close]'))).focus();
      return;
    }

    const step = Number(button.dataset.lineStep);
    if (step) {
      cart[index].qty = Math.min(MAX_QTY, Math.max(1, cart[index].qty + step));
      saveCart();
      renderCart();
      // Keep focus on the same +/- button after the re-render
      const same = $('[data-line="' + row.dataset.line + '"] [data-line-step="' + step + '"]', linesEl);
      if (same) (same.disabled ? $('[data-line="' + row.dataset.line + '"] [data-line-step="' + -step + '"]', linesEl) : same).focus();
    }
  });


  /* ---- 7. Phone cart sheet -------------------------------------------- */
  // Below 900px the cart is a bottom sheet, opened from the order bar

  const backdrop = $('[data-cart-backdrop]');

  function setSheet(open) {
    if (open && desktop.matches) return;
    const wasOpen = cartEl.classList.contains('is-open');
    cartEl.classList.toggle('is-open', open);
    backdrop.classList.toggle('is-visible', open);
    document.body.classList.toggle('cart-open', open);
    barBtn.setAttribute('aria-expanded', String(open));
    if (open) {
      toastEl.classList.remove('is-visible'); // it would sit on top of the sheet
      $('[data-cart-close]').focus();
    }
    else if (wasOpen && !bar.hidden) barBtn.focus();
  }

  barBtn.addEventListener('click', function () {
    setSheet(true);
  });

  $('[data-cart-close]').addEventListener('click', function () {
    setSheet(false);
  });

  backdrop.addEventListener('click', function () {
    setSheet(false);
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && cartEl.classList.contains('is-open')) setSheet(false);
  });

  desktop.addEventListener('change', function () {
    setSheet(false);
  });


  /* ---- 8. Steps ------------------------------------------------------- */
  // menu -> details (pickup) -> payment. Each step is a history entry, so the
  // phone's back button goes back a step.

  const STEPS = ['menu', 'details', 'payment'];
  let pickup = null; // filled by the pickup form

  function goTo(step, fromHistory) {
    if (step !== 'menu' && !cart.length) step = 'menu';
    if (step === 'payment' && !pickup) step = 'details';
    const changed = document.body.dataset.step !== step;
    document.body.dataset.step = step;

    $all('[data-step-panel]').forEach(function (panel) {
      panel.hidden = panel.dataset.stepPanel !== step;
    });

    const at = STEPS.indexOf(step);
    $all('[data-progress]').forEach(function (marker) {
      const i = STEPS.indexOf(marker.dataset.progress);
      marker.classList.toggle('is-done', i < at);
      if (i === at) marker.setAttribute('aria-current', 'step');
      else marker.removeAttribute('aria-current');
    });

    if (step === 'details') refreshTimes();
    if (step === 'payment') renderRecap();
    setSheet(false);
    renderCart();

    if (changed) {
      if (!fromHistory) history.pushState({ step: step }, '');
      window.scrollTo({ top: 0, behavior: 'auto' });
      const title = $('[data-step-panel="' + step + '"] .order-step__title');
      if (title) title.focus({ preventScroll: true });
      if (step === 'menu') {
        activeCat = -1;
        updateActiveCat();
      }
    }
  }

  history.replaceState({ step: 'menu' }, '');

  window.addEventListener('popstate', function (event) {
    goTo((event.state && event.state.step) || 'menu', true);
  });

  checkoutBtn.addEventListener('click', function () {
    goTo('details');
  });

  $all('[data-go]').forEach(function (button) {
    button.addEventListener('click', function () {
      goTo(button.dataset.go);
    });
  });


  /* ---- 9. Pickup times ------------------------------------------------ */
  // Times are Toronto time whatever the customer's device is set to. Values
  // are "YYYY-MM-DDTHH:MM" (local to Toronto) or "asap".

  function toMinutes(hhmm) {
    const parts = hhmm.split(':');
    return Number(parts[0]) * 60 + Number(parts[1]);
  }

  function hhmm(minutes) {
    return String(Math.floor(minutes / 60)).padStart(2, '0') + ':' + String(minutes % 60).padStart(2, '0');
  }

  function timeLabel(minutes) {
    const h = Math.floor(minutes / 60);
    return ((h + 11) % 12 + 1) + ':' + String(minutes % 60).padStart(2, '0') + (h < 12 ? ' AM' : ' PM');
  }

  function torontoNow() {
    const p = {};
    new Intl.DateTimeFormat('en-CA', {
      timeZone: CONFIG.timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date()).forEach(function (part) { p[part.type] = part.value; });
    return { y: +p.year, m: +p.month, d: +p.day, minutes: +p.hour * 60 + +p.minute };
  }

  // The first day (today or later) with pickup times left: its slots, and
  // whether ASAP is on offer (only while the location is open)
  function pickupDay(location) {
    const hours = location.hours;
    const open = toMinutes(hours.open);
    const close = toMinutes(hours.close);
    const first = open + CONFIG.kitchenLeadMinutes;
    const last = close - CONFIG.lastSlotBeforeClose;
    const now = torontoNow();

    for (let n = 0; n < CONFIG.daysAhead; n++) {
      const date = new Date(Date.UTC(now.y, now.m - 1, now.d + n));
      if (hours.days.indexOf(date.getUTCDay()) < 0) continue;

      const earliest = n === 0 ? Math.max(first, now.minutes + CONFIG.kitchenLeadMinutes) : first;
      const slots = [];
      for (let t = Math.ceil(earliest / CONFIG.slotMinutes) * CONFIG.slotMinutes; t <= last; t += CONFIG.slotMinutes) {
        slots.push(t);
      }
      const asap = n === 0 && now.minutes >= open && now.minutes + CONFIG.kitchenLeadMinutes <= close;
      if (slots.length || asap) {
        return { date: date, today: n === 0, asap: asap, slots: slots };
      }
    }
    return null;
  }

  function dayLabel(day) {
    if (day.today) return 'Today';
    return day.date.toLocaleDateString('en-CA', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
  }

  const pickupForm = $('[data-pickup-form]');
  const timeSelect = $('[data-pickup-time]');
  const timeHint = $('[data-pickup-hint]');

  function selectedLocation() {
    const checked = $('input[name="location"]:checked', pickupForm);
    return checked ? checked.value : null;
  }

  function refreshTimes() {
    const id = selectedLocation();
    const previous = timeSelect.value;

    if (!id) {
      timeSelect.innerHTML = '<option value="">Choose a location first</option>';
      timeSelect.disabled = true;
      timeHint.textContent = '';
      return;
    }

    const day = pickupDay(LOCATIONS[id]);
    timeSelect.disabled = !day;
    if (!day) {
      timeSelect.innerHTML = '<option value="">No pickup times available</option>';
      timeHint.textContent = 'Please call us at 647-298-2267.';
      return;
    }

    const iso = day.date.toISOString().slice(0, 10);
    let html = day.asap ? '<option value="asap">ASAP (about ' + CONFIG.kitchenLeadMinutes + ' minutes)</option>' : '';
    if (day.slots.length) {
      html += '<optgroup label="' + dayLabel(day) + '">' + day.slots.map(function (t) {
        return '<option value="' + iso + 'T' + hhmm(t) + '">' + timeLabel(t) + '</option>';
      }).join('') + '</optgroup>';
    }
    timeSelect.innerHTML = html;
    if ($all('option', timeSelect).some(function (o) { return o.value === previous; })) timeSelect.value = previous;

    const hours = LOCATIONS[id].hours;
    timeHint.textContent = day.today
      ? 'Open today ' + timeLabel(toMinutes(hours.open)) + ' to ' + timeLabel(toMinutes(hours.close)) + '.'
      : 'We’re closed right now. Order ahead for ' + dayLabel(day) + '.';
  }

  pickupForm.addEventListener('change', function (event) {
    if (event.target.name === 'location') refreshTimes();
  });

  refreshTimes();


  /* ---- 10. Pickup form ------------------------------------------------ */

  const phoneInput = $('#pickup-phone');

  // 10 digits, or 11 starting with 1
  function phoneDigits(value) {
    const digits = value.replace(/\D/g, '');
    if (digits.length === 10) return digits;
    if (digits.length === 11 && digits[0] === '1') return digits.slice(1);
    return null;
  }

  phoneInput.addEventListener('input', function () {
    phoneInput.setCustomValidity('');
  });

  timeSelect.addEventListener('change', function () {
    timeSelect.setCustomValidity('');
  });

  pickupForm.addEventListener('submit', function (event) {
    event.preventDefault();

    // Drop any slot that passed while the form was open, and say so
    const chosen = timeSelect.value;
    refreshTimes();
    timeSelect.setCustomValidity(chosen && timeSelect.value !== chosen ? 'That time has just passed. Please choose another.' : '');

    const digits = phoneDigits(phoneInput.value);
    phoneInput.setCustomValidity(phoneInput.value && !digits ? 'Enter a 10-digit phone number, e.g. 647-555-0123.' : '');
    if (!pickupForm.reportValidity()) return;

    const value = timeSelect.value;
    const asap = value === 'asap';
    const minutes = asap ? null : toMinutes(value.slice(11));
    pickup = {
      name: pickupForm.elements.name.value.trim(),
      phone: digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6),
      location: selectedLocation(),
      asap: asap,
      time: asap ? null : value,
      timeText: asap ? 'ASAP' : timeSelect.selectedOptions[0].parentNode.label + ', ' + timeLabel(minutes),
      // When the backend sends the order to the KDS; ASAP goes right away
      sendToKitchenAt: asap ? 'now' : value.slice(0, 11) + hhmm(minutes - CONFIG.kitchenLeadMinutes),
    };
    goTo('payment');
  });


  /* ---- 11. Payment step ----------------------------------------------- */
  // buildOrder() is what the backend will receive (amounts in cents). The
  // flow will be: POST it, get a Clover payment session back, mount Clover's
  // card iframes in #clover-payment, and confirm. Nothing is sent yet.

  function buildOrder() {
    const t = totals();
    return {
      customer: { name: pickup.name, phone: pickup.phone },
      location: pickup.location,
      pickup: { asap: pickup.asap, time: pickup.time, sendToKitchenAt: pickup.sendToKitchenAt, timeZone: CONFIG.timeZone },
      items: cart.map(function (line) {
        return {
          name: lineName(line),
          menuId: line.item,
          qty: line.qty,
          unitPrice: unitPrice(line),
          modifiers: line.mods.map(function (m) { return m.label; }),
          note: line.note,
        };
      }),
      subtotal: t.subtotal,
      tax: t.tax,
      total: t.total,
    };
  }

  function renderRecap() {
    if (!pickup || !cart.length) return;
    const order = buildOrder();
    const location = LOCATIONS[order.location];
    const rows = [
      ['Pickup at', esc(location.name) + '<br><span class="recap__sub">' + esc(location.address) + '</span>'],
      ['Time', esc(pickup.timeText)],
      ['Name', esc(order.customer.name)],
      ['Phone', esc(order.customer.phone)],
    ];
    $('[data-recap]').innerHTML = rows.map(function (row) {
      return '<div><dt>' + row[0] + '</dt><dd>' + row[1] + '</dd></div>';
    }).join('');
  }

  renderCart();
})();

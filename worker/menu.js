/* ==========================================================================
   Tacos De Princesa — worker/menu.js
   The server's copy of the menu: what /api/create-order charges. Prices are
   in cents. KEEP IN SYNC with MENU and GROUPS in js/order.js: same item
   keys ('tacos/pollo'), option labels and prices, or orders are rejected
   (unknown item/option) or priced differently from the page.
   ========================================================================== */

function opt(label, price) {
  return { label: label, price: price || 0 };
}

const TACO_FILLINGS = ['Pollo', 'Carne Asada', 'Barbacoa', 'Surf + Turf', 'Pescado', 'Camarón', 'Veggie Chorizo'];

// 'one' = exactly one choice, 'many' = any number
export const GROUPS = {
  prep: { type: 'many', options: [opt('No onions'), opt('No cilantro'), opt('Extra cilantro'), opt('Salsa on the side')] },
  extraBirria: { type: 'many', options: [opt('Extra birria taco', 500)] },
  tacoExtras: { type: 'many', options: [opt('Extra taco', 400), opt('Add cheese', 100)] },
  filling: { type: 'one', options: TACO_FILLINGS.map(function (n) { return opt(n); }) },
  guac: { type: 'many', options: [opt('Add guacamole', 300)] },
  dressing: { type: 'one', options: [opt('House vinaigrette'), opt('Cilantro lime'), opt('Chipotle ranch')] },
  protein: { type: 'one', options: [opt('No protein'), opt('Pollo', 400), opt('Carne Asada', 500), opt('Pescado', 500), opt('Camarón', 600), opt('Veggie Chorizo', 500), opt('Surf + Turf', 800)] },
  base: { type: 'one', options: [opt('Nachos'), opt('Fries')] },
};

['1', '2', '3'].forEach(function (n) {
  GROUPS['mix' + n] = { type: 'one', options: ['Birria'].concat(TACO_FILLINGS).map(function (f) { return opt(f); }) };
});

// Burritos and Bowls: same fillings and prices
function burritoFillings() {
  return [
    { id: 'pollo', name: 'Pollo', price: 1500 },
    { id: 'carne-asada', name: 'Carne Asada', price: 1600 },
    { id: 'barbacoa', name: 'Barbacoa', price: 1700 },
    { id: 'surf-turf', name: 'Surf + Turf', price: 1800 },
    { id: 'pescado', name: 'Pescado', price: 1600 },
    { id: 'camaron', name: 'Camarón', price: 1700 },
    { id: 'veggie-chorizo', name: 'Veggie Chorizo', price: 1600 },
  ];
}

// Same shape as js/order.js (descriptions left out)
const MENU = [
  {
    id: 'birria', suffix: '',
    items: [
      { id: 'birria-tacos', name: 'Birria Tacos', price: 1900, groups: ['extraBirria', 'prep'] },
      { id: 'single-birria', name: 'Single Birria', price: 700, groups: ['prep'] },
      { id: 'mix-match', name: 'Mix & Match', price: 2000, groups: ['mix1', 'mix2', 'mix3', 'prep'] },
    ],
  },
  {
    id: 'tacos', suffix: 'Tacos', groups: ['tacoExtras', 'prep'],
    items: [
      { id: 'pollo', name: 'Pollo', price: 1500 },
      { id: 'carne-asada', name: 'Carne Asada', price: 1600 },
      { id: 'barbacoa', name: 'Barbacoa', price: 1700 },
      { id: 'surf-turf', name: 'Surf + Turf', price: 1800 },
      { id: 'pescado', name: 'Pescado', price: 1600 },
      { id: 'camaron', name: 'Camarón', price: 1700 },
      { id: 'veggie-chorizo', name: 'Veggie Chorizo', price: 1600 },
      { id: 'single-taco', name: 'Single Taco', fullName: 'Single Taco', price: 700, groups: ['filling', 'prep'] },
    ],
  },
  {
    id: 'burritos', suffix: 'Burrito', groups: ['guac', 'prep'],
    items: burritoFillings(),
  },
  {
    id: 'bowls', suffix: 'Bowl', groups: ['guac', 'prep'],
    items: burritoFillings(),
  },
  {
    id: 'ensaladas', suffix: 'Ensalada', groups: ['dressing', 'protein', 'prep'],
    items: [
      { id: 'fiesta', name: 'Fiesta', price: 1200 },
      { id: 'santa-fe', name: 'Santa Fe', price: 1200 },
      { id: 'quinoa', name: 'Jalapeño Lime Quinoa', price: 1200 },
      { id: 'pineapple', name: 'Charred Pineapple & Bean', price: 1200 },
    ],
  },
  {
    id: 'quesadillas', suffix: 'Quesadilla', groups: ['prep'],
    items: [
      { id: 'classic', name: 'Classic', price: 1400 },
      { id: 'pollo', name: 'Pollo', price: 1500 },
      { id: 'carne-asada', name: 'Carne Asada', price: 1600 },
      { id: 'barbacoa', name: 'Barbacoa', price: 1700 },
      { id: 'surf-turf', name: 'Surf + Turf', price: 1800 },
      { id: 'camaron', name: 'Camarón', price: 1700 },
      { id: 'veggie-chorizo', name: 'Veggie Chorizo', price: 1600 },
    ],
  },
  {
    id: 'nachos', suffix: 'Loaded', nameFrom: 'base', groups: ['base', 'prep'],
    items: [
      { id: 'classic', name: 'Classic', price: 1000 },
      { id: 'pollo', name: 'Pollo', price: 1200 },
      { id: 'carne-asada', name: 'Carne Asada', price: 1300 },
      { id: 'veggie-chorizo', name: 'Veggie Chorizo', price: 1300 },
    ],
  },
];

// Flat lookup: 'tacos/pollo' -> { price, groups, fullName, nameFrom }
export const ITEMS = {};
MENU.forEach(function (cat) {
  cat.items.forEach(function (item) {
    ITEMS[cat.id + '/' + item.id] = {
      price: item.price,
      groups: item.groups || cat.groups || [],
      fullName: item.fullName || (cat.suffix ? item.name + ' ' + cat.suffix : item.name),
      nameFrom: cat.nameFrom,
    };
  });
});

export const TAX_RATE = 0.13; // Ontario HST, same as CONFIG.taxRate in js/order.js

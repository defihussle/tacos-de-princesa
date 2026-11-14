/* ==========================================================================
   Tacos De Princesa — worker/menu.js
   The server's copy of the menu: what /api/create-order charges. Prices are
   in cents. KEEP IN SYNC with MENU and GROUPS in js/order.js: same item
   keys ('tacos/pollo'), option labels and prices, or orders are rejected
   (unknown item/option) or priced differently from the page.

   Clover is the master copy: prices match the Clover items, and each dish
   offers the modifier groups Clover attaches to its item (one website group
   per Clover group). worker/clover-ids.js says which Clover item and
   modifier each one is. scripts/check-menu.mjs checks all three files agree.
   ========================================================================== */

function opt(label, price, none) {
  return { label: label, price: price || 0, none: !!none };
}

function opts(labels) {
  return labels.map(function (label) { return opt(label); });
}

const TACO_FILLINGS = ['Pollo', 'Carne Asada', 'Barbacoa', 'Surf + Turf', 'Pescado', 'Camarón', 'Veggie Chorizo'];

// One group per Clover modifier group (Clover's name in the comment).
// 'one' = exactly one choice, 'many' = any number. Clover's own rules are
// looser for base, dressing and protein (no minimum); the website still asks
// for exactly one there.
export const GROUPS = {
  filling: { type: 'one', options: opts(TACO_FILLINGS) },                    // Protein (Single Taco; $7.00 is on the modifier)
  base: { type: 'one', options: opts(['Nachos', 'Fries']) },                 // Nachos/Fries
  dressing: { type: 'one', options: opts(['Honey Dijon', 'Avocado poblano', 'Ranch', 'Balsamic vinaigrette']) }, // Salad Dressing
  protein: { type: 'one', options: [opt('No protein', 0, true), opt('Pollo', 400), opt('Carne Asada', 500), opt('Pescado', 500), opt('Camarón', 600), opt('Veggie Chorizo', 500), opt('Surf + Turf', 800)] }, // Salad Add Ons
  extraBirria: { type: 'many', options: [opt('Extra birria taco', 500), opt('Extra consommé', 100)] }, // Add Extra Birria
  tacoExtras: { type: 'many', options: [opt('Extra taco', 400), opt('Add cheese', 100)] },              // Taco Extras
  guac: { type: 'many', options: [opt('Add guacamole', 300)] },              // Add Guacamole
  guacQ: { type: 'many', options: [opt('Add guacamole', 300)] },             // Add Q (quesadillas)
  hotSauce: { type: 'many', options: opts(['Hot sauce on the side']) },      // Hot Sauce
  remove: { type: 'many', options: opts(['No onions', 'No cilantro', 'No Princesa sauce']) },                                  // Remove
  remove1: { type: 'many', options: opts(['No red cabbage', 'No onions', 'No cilantro', 'No Princesa sauce', 'No tomato']) },  // Remove 1
  remove2: { type: 'many', options: opts(['No onions', 'No cilantro', 'No tomato', 'No Princesa sauce']) },                   // Remove 2
  remove3: { type: 'many', options: opts(['No cheese', 'No cilantro', 'No onions']) },                                          // Remove 3
  remove4: { type: 'many', options: opts(['No onions', 'No peppers']) },                                                        // Remove 4
  remove5: { type: 'many', options: opts(['No green onions', 'No tomato', 'No sour cream', 'No cheese sauce']) },               // Remove 5
  toppings: { type: 'many', options: opts(['No rice', 'No lettuce', 'No cheese', 'No corn', 'No beans', 'No onions', 'No tomatoes', 'No green onions', 'No bell peppers', 'No salsa verde', 'No sour cream', 'No Princesa sauce', 'No cilantro']) }, // Toppings
  saladFiesta: { type: 'many', options: opts(['No arugula', 'No mango', 'No avocado', 'No bell peppers', 'No cherry tomatoes', 'No red onions', 'No cotija cheese']) }, // Salad Mod Fiesta
  saladSantaFe: { type: 'many', options: opts(['No lettuce', 'No black beans', 'No corn', 'No red onions', 'No cherry tomatoes', 'No tortilla strips']) },        // Salad Mod Sante Fe
  saladQuinoa: { type: 'many', options: opts(['No kale', 'No quinoa', 'No corn', 'No pickled onions', 'No bell peppers', 'No jalapeños']) },                     // Salad Mod Quinoa
  saladPineapple: { type: 'many', options: opts(['No mixed greens', 'No pineapple', 'No black beans', 'No bell peppers', 'No cilantro']) },                     // Salad Mod Pineapple
};

// Mix & Match: three picks, all from Clover's "Choose any 3 Tacos"
['1', '2', '3'].forEach(function (n) {
  GROUPS['mix' + n] = { type: 'one', options: opts(['Birria'].concat(TACO_FILLINGS)) };
});

// Burritos and Bowls: same fillings and prices
function burritoFillings() {
  return [
    { id: 'pollo', name: 'Pollo', price: 1500 },
    { id: 'carne-asada', name: 'Carne Asada', price: 1600 },
    { id: 'barbacoa', name: 'Barbacoa', price: 1700 },
    { id: 'surf-turf', name: 'Surf + Turf', price: 1900 },
    { id: 'pescado', name: 'Pescado', price: 1600 },
    { id: 'camaron', name: 'Camarón', price: 1700 },
    { id: 'veggie-chorizo', name: 'Veggie Chorizo', price: 1600 },
  ];
}

// Same shape as js/order.js (descriptions left out). An item's groups are
// the Clover groups on its Clover item, so they differ within a category.
const MENU = [
  {
    id: 'birria', suffix: '',
    items: [
      { id: 'birria-tacos', name: 'Birria Tacos', price: 1900, groups: ['extraBirria', 'hotSauce', 'remove3'] },
      { id: 'single-birria', name: 'Single Birria', price: 700, groups: ['hotSauce', 'remove3'] },
      { id: 'mix-match', name: 'Mix & Match', price: 2000, groups: ['mix1', 'mix2', 'mix3', 'guac', 'hotSauce', 'remove1'] },
    ],
  },
  {
    id: 'tacos', suffix: 'Tacos',
    items: [
      { id: 'pollo', name: 'Pollo', price: 1500, groups: ['tacoExtras', 'guac', 'hotSauce', 'remove2'] },
      { id: 'carne-asada', name: 'Carne Asada', price: 1600, groups: ['tacoExtras', 'guac', 'hotSauce', 'remove'] },
      { id: 'barbacoa', name: 'Barbacoa', price: 1700, groups: ['tacoExtras', 'guac', 'hotSauce', 'remove'] },
      { id: 'surf-turf', name: 'Surf + Turf', price: 1800, groups: ['tacoExtras', 'guac', 'hotSauce'] },
      { id: 'pescado', name: 'Pescado', price: 1600, groups: ['tacoExtras', 'guac', 'hotSauce', 'remove1'] },
      { id: 'camaron', name: 'Camarón', price: 1700, groups: ['tacoExtras', 'guac', 'hotSauce', 'remove1'] },
      { id: 'veggie-chorizo', name: 'Veggie Chorizo', price: 1600, groups: ['tacoExtras', 'guac', 'hotSauce', 'remove'] },
      { id: 'single-taco', name: 'Single Taco', fullName: 'Single Taco', price: 700, groups: ['filling', 'guac', 'hotSauce'] },
    ],
  },
  {
    id: 'burritos', suffix: 'Burrito', groups: ['guac', 'hotSauce', 'toppings'],
    items: burritoFillings(),
  },
  {
    id: 'bowls', suffix: 'Bowl', groups: ['guac', 'toppings'],
    items: burritoFillings(),
  },
  {
    id: 'ensaladas', suffix: 'Ensalada',
    items: [
      { id: 'fiesta', name: 'Fiesta', price: 1200, groups: ['dressing', 'protein', 'saladFiesta'] },
      { id: 'santa-fe', name: 'Santa Fe', price: 1200, groups: ['dressing', 'protein', 'saladSantaFe'] },
      { id: 'quinoa', name: 'Jalapeño Lime Quinoa', price: 1200, groups: ['dressing', 'protein', 'saladQuinoa'] },
      { id: 'pineapple', name: 'Charred Pineapple & Bean', price: 1200, groups: ['dressing', 'protein', 'saladPineapple'] },
    ],
  },
  {
    id: 'quesadillas', suffix: 'Quesadilla', groups: ['guacQ', 'hotSauce', 'remove4'],
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
    id: 'nachos', suffix: 'Loaded', nameFrom: 'base', groups: ['base', 'hotSauce', 'remove5'],
    items: [
      { id: 'classic', name: 'Classic', price: 1000 },
      { id: 'pollo', name: 'Pollo', price: 1200 },
      { id: 'carne-asada', name: 'Carne Asada', price: 1300 },
      { id: 'veggie-chorizo', name: 'Veggie Chorizo', price: 1300, groups: ['base', 'remove5'] }, // no Hot Sauce group in Clover
    ],
  },
  {
    id: 'drinks', suffix: '',
    items: [
      { id: 'pop', name: 'Pop cans', price: 200 },
      { id: 'jarritos', name: 'Jarritos', price: 300 },
      { id: 'water', name: 'Bottled water', price: 250 },
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

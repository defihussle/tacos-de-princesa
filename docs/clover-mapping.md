# Website menu → Clover inventory (proposal)

Live merchant `7Z068VHSYD2K1`, inventory read on 2026-11-14 (read-only export kept in
`.local/clover-inventory-live.json`, not committed). Website menu: `worker/menu.js` (same as `js/order.js`).

This is a proposal: nothing in the code or in Clover has been changed. Totals in Clover come from the Clover item price
plus modifier amounts; the website must charge the same, so every "price differs" row needs a decision before orders
send Clover item IDs.

Summary: 43 website items: 40 match (7 of them also have a second Clover item with the same meaning), 1 matches with the price on a modifier (Single Taco), 2 have a different price, 0 have no match.
35 website options; 28 map to a Clover modifier (or need none) on every item that offers them.

## Items

| Website key | Website name | Website price | Clover item ID | Clover name | Clover price | Labels | Tax | Status |
|---|---|---|---|---|---|---|---|---|
| birria/birria-tacos | Birria Tacos | $19.00 | `HVCMBM6P57WC6` | Birria Tacos (3) | $19.00 | Birria, Expo Label | HST 13% | match; ambiguous |
| birria/single-birria | Single Birria | $7.00 | `ANXM6M20VQCD0` | Single Birria | $7.00 | Birria, Expo Label | HST 13% | match |
| birria/mix-match | Mix & Match | $20.00 | `80EBM56YNQBYM` | Mix + Match Any 3 Tacos | $20.00 | Expo Label, Tacos Printer | HST 13% | match |
| tacos/pollo | Pollo Tacos | $15.00 | `6P83JWVFX9B72` | Pollo Taco | $15.00 | Expo Label, Tacos Printer | HST 13% | match; ambiguous |
| tacos/carne-asada | Carne Asada Tacos | $16.00 | `08WMRP7YD5XSM` | Carne Asada Tacos | $16.00 | Expo Label, Tacos Printer | HST 13% | match; ambiguous |
| tacos/barbacoa | Barbacoa Tacos | $17.00 | `FGHVZZNJ0F4QW` | Barbacoa Tacos | $17.00 | Expo Label, Tacos Printer | HST 13% | match |
| tacos/surf-turf | Surf + Turf Tacos | $18.00 | `7Q64A1YK9SXGE` | Surf + Turf Tacos | $18.00 | Expo Label, Tacos Printer | HST 13% | match |
| tacos/pescado | Pescado Tacos | $16.00 | `BX1PWEWD80X1C` | Pescado Tacos | $16.00 | Expo Label, Tacos Printer | HST 13% | match; ambiguous |
| tacos/camaron | Camarón Tacos | $17.00 | `6VKABKTR5WS78` | Camarón Tacos | $17.00 | Expo Label, Tacos Printer | HST 13% | match |
| tacos/veggie-chorizo | Veggie Chorizo Tacos | $16.00 | `47XEY2VZYWBVY` | Vegano Chorizo Tacos | $16.00 | Expo Label, Tacos Printer | HST 13% | match; ambiguous |
| tacos/single-taco | Single Taco | $7.00 | `9AQ21XEGDYWBY` | Single Tacos | $0.00 | Expo Label, Tacos Printer | HST 13% | match (price on modifier) |
| burritos/pollo | Pollo Burrito | $15.00 | `D5T388DSFMYSW` | Pollo Burrito | $15.00 | Salad Printer, Expo Label | HST 13% | match |
| burritos/carne-asada | Carne Asada Burrito | $16.00 | `XV3607W2QKM10` | Carne Asada Burrito | $16.00 | Salad Printer, Expo Label | HST 13% | match |
| burritos/barbacoa | Barbacoa Burrito | $17.00 | `BFPYPB2K5R6Z8` | Barbacoa Burrito | $17.00 | Salad Printer, Expo Label | HST 13% | match |
| burritos/surf-turf | Surf + Turf Burrito | $18.00 | `BVZNGBP7W37CR` | Surf + Turf Burrito | $19.00 | Salad Printer, Expo Label | HST 13% | price differs |
| burritos/pescado | Pescado Burrito | $16.00 | `TNJMC572CNVX8` | Pescado Burrito | $16.00 | Salad Printer, Expo Label | HST 13% | match |
| burritos/camaron | Camarón Burrito | $17.00 | `GYCDPRGZEMKEE` | Camarón Burrito | $17.00 | Salad Printer, Expo Label | HST 13% | match |
| burritos/veggie-chorizo | Veggie Chorizo Burrito | $16.00 | `QX7E9QPWYT5PR` | Vegano Chorizo Burrito | $16.00 | Salad Printer, Expo Label | HST 13% | match |
| bowls/pollo | Pollo Bowl | $15.00 | `78PTDPYY9DYHR` | Pollo Bowl | $15.00 | Salad Printer, Expo Label | HST 13% | match |
| bowls/carne-asada | Carne Asada Bowl | $16.00 | `37FNF9XYPQJ2A` | Carne Asada Bowl | $16.00 | Salad Printer, Expo Label | HST 13% | match |
| bowls/barbacoa | Barbacoa Bowl | $17.00 | `HYZZTZ6G46NK6` | Barbacoa Bowl | $17.00 | Salad Printer, Expo Label | HST 13% | match |
| bowls/surf-turf | Surf + Turf Bowl | $18.00 | `QC7B0WM6QBR4J` | Surf + Turf Bowl | $19.00 | Salad Printer, Expo Label | HST 13% | price differs |
| bowls/pescado | Pescado Bowl | $16.00 | `PJC56NWFK00FY` | Pescado Bowl | $16.00 | Salad Printer, Expo Label | HST 13% | match |
| bowls/camaron | Camarón Bowl | $17.00 | `GCQTQ22754ZC8` | Camaron Bowl | $17.00 | Salad Printer, Expo Label | HST 13% | match |
| bowls/veggie-chorizo | Veggie Chorizo Bowl | $16.00 | `2AWQT5N9PTD5G` | Veggie Chorizo Bowl | $16.00 | Salad Printer, Expo Label | HST 13% | match |
| ensaladas/fiesta | Fiesta Ensalada | $12.00 | `DK7BB0E0QSKQT` | Fiesta | $12.00 | Salad Printer, Expo Label | HST 13% | match |
| ensaladas/santa-fe | Santa Fe Ensalada | $12.00 | `X8PM7BZX78W3A` | Santa Fe | $12.00 | Salad Printer, Expo Label | HST 13% | match |
| ensaladas/quinoa | Jalapeño Lime Quinoa Ensalada | $12.00 | `4HVV3E0Z8HAHA` | Jalapeno Lime Quinoa | $12.00 | Salad Printer, Expo Label | HST 13% | match; ambiguous |
| ensaladas/pineapple | Charred Pineapple & Bean Ensalada | $12.00 | `648YKG44QSRRA` | Charred Pineapple Bean | $12.00 | Salad Printer, Expo Label | HST 13% | match |
| quesadillas/classic | Classic Quesadilla | $14.00 | `KB22WCWP9Y0YY` | Cheese Quesadilla | $14.00 | Salad Printer, Expo Label | HST 13% | match |
| quesadillas/pollo | Pollo Quesadilla | $15.00 | `7YEFVPYW0F17P` | Pollo Quesadilla | $15.00 | Salad Printer, Expo Label | HST 13% | match |
| quesadillas/carne-asada | Carne Asada Quesadilla | $16.00 | `N9VY576RS97XJ` | Carne Asada Quesadilla | $16.00 | Salad Printer, Expo Label | HST 13% | match |
| quesadillas/barbacoa | Barbacoa Quesadilla | $17.00 | `WRSKH2XR7XTGP` | Barbacoa Quesadilla | $17.00 | Salad Printer, Expo Label | HST 13% | match |
| quesadillas/surf-turf | Surf + Turf Quesadilla | $18.00 | `WJQEPN4P8X3CT` | Surf + Turf Quesadilla | $18.00 | Salad Printer, Expo Label | HST 13% | match |
| quesadillas/camaron | Camarón Quesadilla | $17.00 | `MVKZQ4EFQJ5KE` | Camarón Quesadilla | $17.00 | Salad Printer, Expo Label | HST 13% | match |
| quesadillas/veggie-chorizo | Veggie Chorizo Quesadilla | $16.00 | `8KSKE1T3K8PVM` | Vegano Chorizo Quesadilla | $16.00 | Salad Printer, Expo Label | HST 13% | match |
| nachos/classic | Classic Loaded | $10.00 | `75NRH4AZJTE6Y` | Classic Loaded Dish | $10.00 | Back Kitchen, Expo Label | HST 13% | match |
| nachos/pollo | Pollo Loaded | $12.00 | `BKJY8DK8Z6S3W` | Pollo Loaded Dish | $12.00 | Back Kitchen, Expo Label | HST 13% | match |
| nachos/carne-asada | Carne Asada Loaded | $13.00 | `04F01FF1G823Y` | Carne Asada Loaded Dish | $13.00 | Back Kitchen, Expo Label | HST 13% | match |
| nachos/veggie-chorizo | Veggie Chorizo Loaded | $13.00 | `CQKN9MSYXW8Y6` | Veggie Chorizo Loaded Dish | $13.00 | Back Kitchen, Expo Label | HST 13% | match |
| drinks/pop | Pop cans | $2.00 | `KFWV5N1TC8NNJ` | Cans | $2.00 | Expo Label | HST 13% | match |
| drinks/jarritos | Jarritos | $3.00 | `WRV4KR7H5MES6` | Jarritos | $3.00 | Expo Label | HST 13% | match; ambiguous |
| drinks/water | Bottled water | $2.50 | `TBXZTE67GX7FM` | Bottle Water | $2.50 | Expo Label | HST 13% | match |

"Ambiguous" means Clover also has another item with the same meaning; the mapped one is the visible item in the
matching category. The others: birria/birria-tacos → `DBYNEJZAMJX58` Birria Tacos 3 pcs ($19.00, hidden); tacos/pollo → `4EP1F59YM59Q2` Chicken Tacos ($14.00, hidden, no category); tacos/carne-asada → `S7R7Z0DREFVHT` Carne Asada Tacos ($16.00, hidden, no category); tacos/pescado → `2XH3GHWGH4VRG` Fish Tacos ($15.00, hidden, no category); tacos/veggie-chorizo → `B4VPS9W9V5FVJ` Chorizo Tacos ($15.00, hidden, no category); ensaladas/quinoa → `86ZG4P2XBVHFP` Jalapeno Lime Quinoa ($0.00, no category), `3ABC5ZJVPPHWE` jalapeño lime quinoa ($10.00, no category); drinks/jarritos → `6G2JHF18D80DP` Jarritos ($3.00, no category).

## Options

Each row is one website option and the Clover modifier it maps to on the listed items. The modifier is always taken
from a modifier group that Clover attaches to that item; an option can map to different modifiers on different items
(e.g. "No onions" is in a different "Remove" group on each kind of dish).

| Group | Website label | Website price | Clover modifier ID | Clover name (group) | Clover price | Items | Status |
|---|---|---|---|---|---|---|---|
| extraBirria | Extra birria taco | $5.00 | `0G42Q6996SM26` | Extra Birria (Add Extra Birria) | $5.00 | birria/birria-tacos | match |
| prep | No onions | $0.00 | `MRCM3M9E4TF4W` | No Onion (Remove 3) | $0.00 | birria/birria-tacos, birria/single-birria | match |
| prep | No cilantro | $0.00 | `DTXZ3YWJW8XF0` | No Cilantro (Remove 3) | $0.00 | birria/birria-tacos, birria/single-birria | match |
| prep | Extra cilantro | $0.00 | – | – | – | birria/* (all 3); tacos/* (all 8); burritos/* (all 7); bowls/* (all 7); ensaladas/* (all 4); quesadillas/* (all 7); nachos/* (all 4) | note |
| prep | Salsa on the side | $0.00 | – | – | – | birria/* (all 3); tacos/* (all 8); burritos/* (all 7); bowls/* (all 7); ensaladas/* (all 4); quesadillas/* (all 7); nachos/* (all 4) | note |
| mix1–3 | Birria | $0.00 | `X1YB8B278BFNT` | Biria Taco (Choose any 3 Tacos) | $0.00 | birria/mix-match | match |
| mix1–3 | Pollo | $0.00 | `X3NZ20KM8A71W` | Pollo Tacos (Choose any 3 Tacos) | $0.00 | birria/mix-match | match |
| mix1–3 | Carne Asada | $0.00 | `AHAKXQKX9FBRT` | Carne Asada Tacos (Choose any 3 Tacos) | $0.00 | birria/mix-match | match |
| mix1–3 | Barbacoa | $0.00 | `X56KB467D95SP` | Barbacoa Tacos (Choose any 3 Tacos) | $0.00 | birria/mix-match | match |
| mix1–3 | Surf + Turf | $0.00 | `BNCTBNCATVMAW` | Surf + Turf Tacos (Choose any 3 Tacos) | $0.00 | birria/mix-match | match |
| mix1–3 | Pescado | $0.00 | `TA290PHZHZNWG` | Pescado Tacos (Choose any 3 Tacos) | $0.00 | birria/mix-match | match |
| mix1–3 | Camarón | $0.00 | `71AEYQ0TMC6TT` | Camarón Tacos (Choose any 3 Tacos) | $0.00 | birria/mix-match | match |
| mix1–3 | Veggie Chorizo | $0.00 | `89KFEWEYTQCS4` | Vegano Chorizo Tacos (Choose any 3 Tacos) | $0.00 | birria/mix-match | match |
| prep | No onions | $0.00 | `MPM2M5QS7WMDJ` | No Onion (Remove 1) | $0.00 | birria/mix-match; tacos/pescado, tacos/camaron | match |
| prep | No cilantro | $0.00 | `4JDKV6ZZRADBJ` | No Cilantro (Remove 1) | $0.00 | birria/mix-match; tacos/pescado, tacos/camaron | match |
| tacoExtras | Extra taco | $4.00 | `KT15RB5CJW570` | Extra Taco (Taco Extras) | $4.00 | tacos/pollo, tacos/carne-asada, tacos/barbacoa, tacos/surf-turf, tacos/pescado, tacos/camaron, tacos/veggie-chorizo | match |
| tacoExtras | Add cheese | $1.00 | `KB7J6RBZV4V3T` | Add Cheese (Taco Extras) | $1.00 | tacos/pollo, tacos/carne-asada, tacos/barbacoa, tacos/surf-turf, tacos/pescado, tacos/camaron, tacos/veggie-chorizo | match |
| prep | No onions | $0.00 | `G9H5KA5ZY9ZXP` | No Onion (Remove 2) | $0.00 | tacos/pollo | match |
| prep | No cilantro | $0.00 | `WSAQ3RZZA3Y02` | No Cilantro (Remove 2) | $0.00 | tacos/pollo | match |
| prep | No onions | $0.00 | `90SZY4XWEV5H0` | No Onion (Remove) | $0.00 | tacos/carne-asada, tacos/barbacoa, tacos/veggie-chorizo | match |
| prep | No cilantro | $0.00 | `FA06AB5GDGMXY` | No Cilantro (Remove) | $0.00 | tacos/carne-asada, tacos/barbacoa, tacos/veggie-chorizo | match |
| prep | No onions | $0.00 | – | – | – | tacos/surf-turf, tacos/single-taco; ensaladas/pineapple | note (no modifier on this item) |
| prep | No cilantro | $0.00 | – | – | – | tacos/surf-turf, tacos/single-taco; ensaladas/fiesta, ensaladas/santa-fe, ensaladas/quinoa; quesadillas/* (all 7); nachos/* (all 4) | note (no modifier on this item) |
| filling | Pollo | $0.00 | `5R5E5XCMX8Z0J` | Chicken (Protein) | $7.00 | tacos/single-taco | match (item $0 + modifier) |
| filling | Carne Asada | $0.00 | `FQ3WRTH15YAMY` | Steak (Protein) | $7.00 | tacos/single-taco | match (item $0 + modifier) |
| filling | Barbacoa | $0.00 | `MRQ9QXAW19F2J` | Pulled Beef (Protein) | $7.00 | tacos/single-taco | match (item $0 + modifier) |
| filling | Surf + Turf | $0.00 | `2Q09E1RRF0E5W` | Surt And Turf (Protein) | $7.00 | tacos/single-taco | match (item $0 + modifier) |
| filling | Pescado | $0.00 | `DWW3PVEYA2V0C` | Fish (Protein) | $7.00 | tacos/single-taco | match (item $0 + modifier) |
| filling | Camarón | $0.00 | `WS092RSBMFDBW` | Shrimp (Protein) | $7.00 | tacos/single-taco | match (item $0 + modifier) |
| filling | Veggie Chorizo | $0.00 | `VEWB30XBE75BP` | Chorizo (Protein) | $7.00 | tacos/single-taco | match (item $0 + modifier) |
| guac | Add guacamole | $3.00 | `RZY1DV6QP3FNE` | Add Guacamole (Add Guacamole) | $3.00 | burritos/* (all 7); bowls/* (all 7) | match |
| prep | No onions | $0.00 | `FC2RETTV1CHNM` | Remove Onions (Toppings) | $0.00 | burritos/* (all 7); bowls/* (all 7) | match |
| prep | No cilantro | $0.00 | `CFSE0ZC5KK402` | Remove Cilantro (Toppings) | $0.00 | burritos/* (all 7); bowls/* (all 7) | match |
| dressing | House vinaigrette | $0.00 | – | – | – | ensaladas/* (all 4) | no match |
| dressing | Cilantro lime | $0.00 | – | – | – | ensaladas/* (all 4) | no match |
| dressing | Chipotle ranch | $0.00 | – | – | – | ensaladas/* (all 4) | no match |
| protein | No protein | $0.00 | – | – | – | ensaladas/* (all 4) | no modifier needed |
| protein | Pollo | $4.00 | `0SNFT3DEC2FJW` | Pollo (Salad Add Ons) | $4.00 | ensaladas/* (all 4) | match |
| protein | Carne Asada | $5.00 | `M96VH2WXKRZJY` | Carne Asada (Salad Add Ons) | $5.00 | ensaladas/* (all 4) | match |
| protein | Pescado | $5.00 | `7FBVVVE67N0RG` | Pescado (Salad Add Ons) | $5.00 | ensaladas/* (all 4) | match |
| protein | Camarón | $6.00 | `5WY2GFBEB97PG` | Camaron (Salad Add Ons) | $6.00 | ensaladas/* (all 4) | match |
| protein | Veggie Chorizo | $5.00 | `2V59XJ46XNWMT` | Vegano Chorizo (Salad Add Ons) | $5.00 | ensaladas/* (all 4) | match |
| protein | Surf + Turf | $8.00 | `DGFX59JRSTK2C` | Surf + Turf (Salad Add Ons) | $8.00 | ensaladas/* (all 4) | match |
| prep | No onions | $0.00 | `A6BN18ARXMDK4` | Remove Red Onions (Salad Mod Fiesta) | $0.00 | ensaladas/fiesta | match |
| prep | No onions | $0.00 | `4B5PDRXM3ZZ5T` | Remove Red Onions (Salad Mod Sante Fe) | $0.00 | ensaladas/santa-fe | match |
| prep | No onions | $0.00 | `EWAKFYKGMVPMC` | Remove Pickled Onions (Salad Mod Quinoa) | $0.00 | ensaladas/quinoa | ambiguous |
| prep | No cilantro | $0.00 | `7M3W9FTYF2T0P` | Remove Cilantro (Salad Mod Pineapple) | $0.00 | ensaladas/pineapple | match |
| prep | No onions | $0.00 | `S93NVEBM3MDT6` | No Onion (Remove 4) | $0.00 | quesadillas/* (all 7) | match |
| base | Nachos | $0.00 | `ZKAX88PB1JDEY` | Nachos (Nachos/Fries) | $0.00 | nachos/* (all 4) | match |
| base | Fries | $0.00 | `K00VYBWJ2CXDP` | Fries (Nachos/Fries) | $0.00 | nachos/* (all 4) | match |
| prep | No onions | $0.00 | `N095Q1PG0E3B8` | No Green Onion (Remove 5) | $0.00 | nachos/* (all 4) | ambiguous |

Status: **match** = same meaning and price; **note** = no Clover modifier, so the option stays in the line-item note
(as today); **no match** = the website option doesn't exist in Clover at all; **ambiguous** = a close but not identical
modifier.

## How Clover models the special cases (proposal)

- **Single Taco**: Clover item `9AQ21XEGDYWBY` "Single Tacos" is **$0.00** with a "Protein" group where every protein
  costs **$7.00** (group max 2, no minimum). Website: $7.00 item + a free filling. Proposal: send the $0 item plus the
  filling's Protein modifier with amount 700 (Pollo → Chicken, Carne Asada → Steak, Barbacoa → Pulled Beef, Pescado →
  Fish, Camarón → Shrimp, Surf + Turf → "Surt And Turf", Veggie Chorizo → Chorizo). Same $7.00 total. The website
  should keep requiring exactly one filling (Clover would allow none or two).
- **Mix & Match**: Clover item `80EBM56YNQBYM` "Mix + Match Any 3 Tacos" $20.00 (in Tacos, Tacos Printer label) with a
  required group "Choose any 3 Tacos" (min 3, max 3, all $0, includes "Biria Taco"). Proposal: send the three picks
  as three modifications from that group. Untested: whether Clover accepts the same modifier twice (e.g. 2 × Pollo) —
  check in the sandbox before relying on it.
- **Loaded Nachos / Fries**: Clover has one item per protein ("Pollo Loaded Dish" etc.) with a "Nachos/Fries" group
  (Nachos `ZKAX88PB1JDEY`, Fries `K00VYBWJ2CXDP`, $0). The base is a modifier, not part of the item name. Proposal:
  send the Loaded Dish item plus the Nachos or Fries modifier. The ticket will read "Pollo Loaded Dish + Fries"
  rather than the website's "Pollo Loaded Fries" (Clover's name wins once items are linked).
- **Ensaladas**: four Clover items at $12.00 with "Salad Dressing" (Honey Dijon, Avocado Poblano Dressing, Ranch,
  Balsamic Vinaigrette; no minimum), "Salad Add Ons" (the protein, priced: Pollo $4, Carne Asada $5, Pescado $5,
  Camaron $6, Vegano Chorizo $5, Surf + Turf $8 — all equal to the website) and a per-salad "Remove …" group.
  Proposal: proteins map 1:1. The website's three dressings are placeholders that don't exist in Clover; replace them
  with Clover's four.
- **Drinks**: Clover models drinks as plain items with **no flavour or size modifiers**: "Cans" $2.00, "Jarritos"
  $3.00, "Bottle Water" $2.50 (plus "Sparkling Water" $3.00, not on the website). Proposal: map 1:1; a flavour can go
  in the note, or add a flavour group in Clover later if the kitchen wants it on the ticket.

## Decisions needed

**Price differences**
- burritos/surf-turf (Surf + Turf Burrito): website $18.00, Clover $19.00
- bowls/surf-turf (Surf + Turf Bowl): website $18.00, Clover $19.00

**Website items with no Clover match**: none.

**Website options with no Clover match** (would stay as notes, or be removed from the website):
- prep "Extra cilantro" on birria/* (all 3); tacos/* (all 8); burritos/* (all 7); bowls/* (all 7); ensaladas/* (all 4); quesadillas/* (all 7); nachos/* (all 4) — note
- prep "Salsa on the side" on birria/* (all 3); tacos/* (all 8); burritos/* (all 7); bowls/* (all 7); ensaladas/* (all 4); quesadillas/* (all 7); nachos/* (all 4) — note
- prep "No onions" on tacos/surf-turf, tacos/single-taco; ensaladas/pineapple — note (no modifier on this item)
- prep "No cilantro" on tacos/surf-turf, tacos/single-taco; ensaladas/fiesta, ensaladas/santa-fe, ensaladas/quinoa; quesadillas/* (all 7); nachos/* (all 4) — note (no modifier on this item)
- dressing "House vinaigrette" on ensaladas/* (all 4) — no match
- dressing "Cilantro lime" on ensaladas/* (all 4) — no match
- dressing "Chipotle ranch" on ensaladas/* (all 4) — no match

**Clover items with no labels** (they won't reach any printer or KDS by label): `7KVXGSMJS2H1R` CHIPS & GUAC ($5.00); `C9CPY8JV31YGM` ELOTES STREETCORN ($7.00); `CGM3EWRS0A1G0` Medium Salad ($65.00); `6G2JHF18D80DP` Jarritos ($3.00); `B4VPS9W9V5FVJ` Chorizo Tacos ($15.00); `2XH3GHWGH4VRG` Fish Tacos ($15.00); `S7R7Z0DREFVHT` Carne Asada Tacos ($16.00); `4EP1F59YM59Q2` Chicken Tacos ($14.00); `4Q4Z2ZRQZ9124` Guacamole ($3.00); `86ZG4P2XBVHFP` Jalapeno Lime Quinoa ($0.00); `3ABC5ZJVPPHWE` jalapeño lime quinoa ($10.00); `4706AGCQ11AKY` Open Item ($0.00).
None of the items mapped above is unlabeled. Note the mapped drinks only carry "Expo Label".

**Items without HST 13%**: `CGM3EWRS0A1G0` Medium Salad ($65.00); `6G2JHF18D80DP` Jarritos ($3.00); `B4VPS9W9V5FVJ` Chorizo Tacos ($15.00); `2XH3GHWGH4VRG` Fish Tacos ($15.00); `S7R7Z0DREFVHT` Carne Asada Tacos ($16.00); `4EP1F59YM59Q2` Chicken Tacos ($14.00); `S61EW9F5BSE08` Gift card ($0.00). None of the mapped items.

**Hidden or unavailable items**: `DBYNEJZAMJX58` Birria Tacos 3 pcs ($19.00); `B4VPS9W9V5FVJ` Chorizo Tacos ($15.00); `2XH3GHWGH4VRG` Fish Tacos ($15.00); `S7R7Z0DREFVHT` Carne Asada Tacos ($16.00); `4EP1F59YM59Q2` Chicken Tacos ($14.00). None of the mapped items.

**Ambiguous matches**
- birria/birria-tacos: mapped to `HVCMBM6P57WC6` Birria Tacos (3); also `DBYNEJZAMJX58` Birria Tacos 3 pcs ($19.00, hidden)
- tacos/pollo: mapped to `6P83JWVFX9B72` Pollo Taco; also `4EP1F59YM59Q2` Chicken Tacos ($14.00, hidden, no labels)
- tacos/carne-asada: mapped to `08WMRP7YD5XSM` Carne Asada Tacos; also `S7R7Z0DREFVHT` Carne Asada Tacos ($16.00, hidden, no labels)
- tacos/pescado: mapped to `BX1PWEWD80X1C` Pescado Tacos; also `2XH3GHWGH4VRG` Fish Tacos ($15.00, hidden, no labels)
- tacos/veggie-chorizo: mapped to `47XEY2VZYWBVY` Vegano Chorizo Tacos; also `B4VPS9W9V5FVJ` Chorizo Tacos ($15.00, hidden, no labels)
- ensaladas/quinoa: mapped to `4HVV3E0Z8HAHA` Jalapeno Lime Quinoa; also `86ZG4P2XBVHFP` Jalapeno Lime Quinoa ($0.00, no labels), `3ABC5ZJVPPHWE` jalapeño lime quinoa ($10.00, no labels)
- drinks/jarritos: mapped to `WRV4KR7H5MES6` Jarritos; also `6G2JHF18D80DP` Jarritos ($3.00, no labels)
- prep "No onions" on ensaladas/quinoa → Remove Pickled Onions (Salad Mod Quinoa) (closest match)
- prep "No onions" on nachos/* (all 4) → No Green Onion (Remove 5) (closest match)

**Required Clover modifier groups the website doesn't ask for**: "Choose any 3 Tacos" (min 3) — only on Mix & Match, which the website already asks for (three picks). No other Clover group has a minimum.

**Clover options the website doesn't offer** (not required; for information): guacamole on tacos and quesadillas
("Add Guacamole" / "Add Q"), "Extra Consomme" $1.00 on Birria Tacos, "Hot Sauce On The Side", the per-dish "Remove …"
options beyond onions/cilantro, and the "Steak Style" and "Bowl/Wrap" groups, which aren't attached to any item.

**Clover items not on the website** (for information): `7KVXGSMJS2H1R` CHIPS & GUAC ($5.00); `C9CPY8JV31YGM` ELOTES STREETCORN ($7.00); `CGM3EWRS0A1G0` Medium Salad ($65.00); `9DHAB47G5BNA8` 1pc Churros Combo ($5.00); `Y5WTTER21BS6C` 2pc Elotes Combo ($5.00); `N1A7PTA1ET65P` Chips And Guac Combo ($5.00); `4Q4Z2ZRQZ9124` Guacamole ($3.00); `4706AGCQ11AKY` Open Item ($0.00); `XHGS5NVQRD9WJ` Chips And Salsa Verde ($4.00); `BP6JXTDNQBMQR` Chips And Cheese ($5.00); `72N7B6AVBQY02` Large Guac ($6.00); `5HZPD7NMVVT4T` Seasoned Rice ($5.00); `K3427ZSVJ2VX0` Seasoned Fries ($5.00); `JSJZTVC6SDFPR` Chips and Guac ($5.00); `FWDWEMWG8S910` Elotes ($7.00); `XN60XZ9JW9DA2` Churro 3 Piece ($7.00); `CVPJ2AZ973F7P` Churro 1 Piece ($2.50); `4PBMM64PX101M` Sparkling Water ($3.00); `S61EW9F5BSE08` Gift card ($0.00).

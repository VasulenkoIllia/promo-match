// What a product of Macma or Easy Gifts is, by the words of its English name: the feeds give only a section (SPARTE,
// about 15 of them: WRITING, BAGS, DRINK TO GO), which holds pens and pencils alike (owner's decision 2026-11-05,
// docs/decisions.md). The kind is ours, not the supplier's: it becomes the second level of the category path
// (["WRITING", "Ball pens"]), named as the shared category it stands for, and src/categories/macma.json and
// easygifts.json map each path. A name no rule knows keeps the section alone and stays out of the shared categories,
// counted in the import report and listed by categories:sync. The first rule that matches wins. Pure.

type KindRule = readonly [RegExp, string];

const PEN = String.raw`(?:ball ?pens?|ballpoints?|pens?|twist ?pens?|paper ?pens?)`;
const KEYRING = String.raw`(?:key ?rings?|key ?chains?)`;

const RULES: readonly KindRule[] = [
  // What a name says besides its main item: a set, a holder, the case of something
  [/\bgift set\b|\bgift box with\b/i, "Gift sets"],
  [/\b(?:colou?r(?:ed|ing)? pencils?|crayons?|colou?ring|watercolou?ring|painting|paint set|chalks?|drawing set|mandala|scratching block)\b/i, "Colouring & art"],
  [new RegExp(String.raw`\b(?:writing set|wrting set|${PEN} set|pen (?:and|&) (?:pencil|rollerball)|set (?:of|with) (?:\w+ )?${PEN})\b`, "i"), "Writing sets"],
  [/\b(?:pencil|pen) (?:zipper )?(?:case|box|pouch|etui)s?\b|\bcase for writing instruments\b/i, "Pen cases"],
  [/^sticky\b|\b(?:page markers?|marking strips?)\b/i, "Sticky notes, memo pads & calendars"],
  [new RegExp(String.raw`\b${PEN}\b.*\b(?:touch|stylus|laser pointer|torch|light)\b|\b(?:touch|stylus)\b.*\b${PEN}\b|\bstylus\b|\btouch ?pens?\b|\blaser pointer\b`, "i"), "Stylus & multifunction pens"],
  [/\bhighlighters?\b|\bmarkers?\b/i, "Highlighters"],
  [/\b(?:rollerball|roller ?ball|fountain pens?)\b/i, "Rollerball & fountain pens"],
  [/\bpencils?\b/i, "Pencils"],
  [new RegExp(String.raw`\b${PEN}\b|\bsemi gel\b`, "i"), "Ball pens"],
  // Keyrings before what hangs on them
  [new RegExp(String.raw`\b${KEYRING}\b.*\b(?:torch|light|led)\b|\b(?:torch|light|led)\b.*\b${KEYRING}\b`, "i"), "Torch keyrings"],
  [new RegExp(String.raw`\b${KEYRING}\b.*\bopener\b|\bopener\b.*\b${KEYRING}\b`, "i"), "Bottle opener keyrings"],
  [new RegExp(String.raw`\b${KEYRING}\b.*\b(?:coin|token|chip)\b|\b(?:shopping coin|trolley coin|token)\b`, "i"), "Token keyrings"],
  [new RegExp(String.raw`\breflect\w*\b.*\b${KEYRING}\b|\b${KEYRING}\b.*\breflect\w*`, "i"), "Reflective keyrings"],
  [new RegExp(String.raw`\b${KEYRING}\b.*\b(?:tool|multi|measur|screwdriver|carabiner|ruler|level)\w*|\b(?:multi-?tool|ruler|spirit level)\w*\b.*\b${KEYRING}\b|\bspirit level keyring\b`, "i"), "Multifunctional keyrings"],
  [new RegExp(String.raw`\b${KEYRING}\b|\bkey (?:holders?|tags?|fobs?)\b`, "i"), "Keyrings"],
  // Electronics
  [/\bpower ?banks?\b/i, "Power banks"],
  [/\b(?:cables?|usb hubs?|hubs?|adapters?|adaptors?|plugs?|plug in)\b/i, "Cables & adapters"],
  [/\bcharg(?:er|ers|ing)\b/i, "Chargers"],
  [/\b(?:speakers?|loudspeakers?|ear ?phones?|in ?earphones?|head ?phones?|headsets?|ear ?buds?|radio|soundbar)\b/i, "Speakers & headphones"],
  [/\b(?:usb[- ]?s\w*cks?|usb cards?|twist usb|usb flash|memory sticks?|mouse ?pads?|gaming pad|mouse|mice|keyboards?|webcam|laptop stand|monitor)\b/i, "Computer accessories"],
  [/\b(?:smart ?watch(?:es)?|fitness trackers?|trackers?|finders?)\b/i, "Trackers, smartwatches & finders"],
  [/\b(?:phones?|smartphones?|mobile|selfie|tablet stand|screen (?:cleaner|protector)s?|cleaning cloth)\b/i, "Phone accessories"],
  [/\b(?:clocks?|weather station|alarm|watch(?:es)?|thermometer|hygrometer)\b/i, "Clocks & weather stations"],
  [/\b(?:torch(?:es)?|flash ?lights?|head ?lamps?|work lights?)\b/i, "Torches"],
  [/\blamps?\b|\b(?:reading|book|bedside) lights?\b/i, "Desk lamps"],
  [/\b(?:batter(?:y|ies)|vr glasses|virtual reality|calculators?)\b/i, "Other electronics"],
  // A material or a container in the name that is not the product
  [/\b(?:trophy|trophies)\b/i, "Home decor & accessories"],
  [/\b(?:candles?|tea ?lights?|tealights?|diffusers?|scented|fragrance|incense|humidifiers?|aroma)\b/i, "Candles & scents"],
  [/\bsun ?glass(?:es)?\b|\bfilter glasses\b/i, "Sunglasses"],
  [/\b(?:knife block|cheese knife|kitchen knife|knives? set|chef'?s knife|santoku)\b/i, "Kitchen knives"],
  // Drinkware: what a cup holds before the cup
  [/\bhip ?flasks?\b/i, "Hip flasks"],
  [/\b(?:vacuum|thermos|thermo ?(?:flask|bottle)s?|insulated bottles?|double[- ]walled bottles?|jugs?|flasks?)\b/i, "Vacuum bottles & flasks"],
  [/\b(?:travel mugs?|thermo ?mugs?|thermal mugs?|to go|tumblers?|drinking cups?|car mugs?|insulated mugs?|double[- ]walled (?:mug|cup)s?)\b/i, "Travel mugs & tumblers"],
  [/\b(?:bottle opener|multi-opener|corkscrew|wine|bar (?:set|measure|mat)|cocktail|bottle stopper|whiske?y|ice (?:cube|bucket)s?|sommelier)\b/i, "Wine & bar"],
  [/\b(?:bottles?|shakers?)\b/i, "Water & sports bottles"],
  [/\b(?:mugs?|cups?|espresso)\b/i, "Mugs & cups"],
  [/\bstraws\b|\bstraw made of\b/i, "Other drinkware"],
  [/\b(?:(?:drinking|shot|champagne|wine|plastic|double-walled|stainless steel) glass(?:es)?|glasses|carafes?|decanters?|goblets?|pitchers?)\b/i, "Glasses & carafes"],
  // Umbrellas and rain
  [/\b(?:rain ?(?:poncho|coat|jacket|cape)s?|ponchos?)\b/i, "Ponchos & raincoats"],
  [/\bumbrellas?\b/i, "Umbrellas"],
  // Bags
  [/\b(?:backpacks?|rucksacks?|daypacks?)\b/i, "Backpacks"],
  [/\b(?:cooler|cooling|cool|insulated|thermo|thermal) ?bags?\b|\bcool ?box\b/i, "Cooler bags"],
  [/\b(?:drawstring|gym[- ]?bags?)\b/i, "Drawstring bags"],
  [/\b(?:laptop|notebook|tablet|document|conference|business) (?:bag|case|sleeve)s?\b|\b(?:briefcase|messenger bag)s?\b/i, "Laptop & document bags"],
  [/\b(?:luggage (?:belt|strap|tag|scale)s?|suitcase (?:strap|belt)s?|travel (?:pillow|sewing|hair dryer)|neck pillow|eye ?masks?|sleep-? and eyemask|passport|suit (?:cover|carrier|bag)|garment cover|travel (?:set|case)|sewing (?:kit|set)|handbag holder)\b/i, "Travel accessories"],
  [/\b(?:trolley|suitcase|carry-?on)s?\b/i, "Trolleys"],
  [/\b(?:waist|belt|hip|shoulder|cross-?body|sling|bum) bags?\b/i, "Waist & shoulder bags"],
  [/\bbeach bags?\b/i, "Beach bags"],
  [/\b(?:cosmetic|toiletry|toilet|wash|make-?up) (?:bag|case|pouch)(?:es|s)?\b/i, "Cosmetic & toiletry bags"],
  [/\b(?:gift|paper|wine|cardboard) ?(?:bag|box|pouch)(?:es|s)?\b/i, "Gift & paper bags"],
  [/\b(?:travel|sports?|duffel|holdall) ?bags?\b|\bweekenders?\b/i, "Travel & sports bags"],
  [/\b(?:shopping|shopper|tote|cotton|jute|non-?woven|foldable|carrier|canvas|city) ?bags?\b|\bshoppers?\b|\bbag with (?:long|short) handles\b|\b(?:shopping|folding|rattan) baskets?\b|\b(?:cotton|fresh) (?:sack|net)s?\b|\bnet, set\b/i, "Shopping & tote bags"],
  [/\bbags?\b|\bpouch(?:es)?\b|\bfeltbags?\b/i, "Other bags"],
  // Office
  [/\b(?:notebooks?|note ?books?|diar(?:y|ies)|journals?|sketchbooks?|pocketbooks?|books?)\b/i, "Notebooks & diaries"],
  [/\b(?:memo|notepads?|note ?pads?|post-?its?|calendars?|message board|sticky notes?|adhesive notes?|note box)\b/i, "Sticky notes, memo pads & calendars"],
  [/\b(?:folders?|portfolios?|ring binders?|binders?|clipboards?|document (?:holder|cover)s?)\b/i, "Folders & portfolios"],
  [/\b(?:lanyards?|badges?|pins?|name tags?|festival bracelets?)\b/i, "Lanyards, badges & pins"],
  [/\b(?:business card|card holders?|card cases?|wallets?|purses?|money clips?|rfid)\b/i, "Wallets & card holders"],
  [/\b(?:desk|pen holder|penpot|organi[sz]er|rulers?|staplers?|paper clips?|letter opener|paper knife|magnifying glass|reading lens|erasers?|sharpeners?|scissors|tape dispenser|magnifier|magnets?)\b/i, "Desk accessories"],
  // Tools, car and safety
  [/\b(?:working gloves?|work gloves?)\b/i, "Tool sets & other tools"],
  [/\b(?:multi-?tools?|pocket knives?|pocket knife|knives|knife|cutters?|blades?)\b/i, "Multitools & knives"],
  [/\b(?:measuring tapes?|tape measures?|folding rules?|spirit levels?|yardsticks?)\b/i, "Measuring tapes"],
  [/\b(?:ice scrapers?|car|cars|parking (?:disc|disk)s?|tyres?|tires?|jump starters?)\b/i, "Car accessories"],
  [/\b(?:bicycles?|bikes?|cycling|saddle covers?|air pumps?)\b/i, "Bicycle accessories"],
  [/\b(?:safety vests?|high[- ]visibility|reflect\w*|warning vests?|flashing light|running light|snap bracelets?|safety led|safety jackets?)\b/i, "Reflective & safety items"],
  [/\b(?:tool ?(?:set|box|case|kit)s?|bit sets?|screwdrivers?|hammers?|pliers|tools?)\b/i, "Tool sets & other tools"],
  // Care before the kitchen: a towel or a tissue of the bathroom
  [/\b(?:first aid|plasters?|hygien\w*|disinfect\w*|desinfect\w*|hand gel|face masks?|disposable gloves?|sanitizer|wipes|pill box|tissues?|tissue box|toothbrush|cooling \/ warming pad|thermal pack|hand warmers?)\b/i, "First aid & hygiene"],
  [/\b(?:lip balms?|sun ?(?:cream|screen|lotion)|lotion|hand cream)\b/i, "Lip balms & sun care"],
  [/\b(?:mirrors?|mirrow|manicure|nail|hair ?brush|combs?|make-?up)\b/i, "Mirrors, manicure & hairbrushes"],
  // Kitchen
  [/\b(?:lunch ?box(?:es)?|lunchbox|food ?containers?|containers? with lid|food storage|storage jars?|bento|cutlery|sporks?|chopsticks?|food jars?)\b/i, "Lunch boxes & cutlery"],
  [/\b(?:cutting boards?|chopping boards?|boards?|serving|cheese|coasters?|trays?|placemats?|table mats?|trivets?|salad)\b/i, "Boards, coasters & cheese sets"],
  [/\b(?:aprons?|oven gloves?|oven mitts?|tea towels?|kitchen towels?)\b/i, "Aprons & kitchen textiles"],
  [/\b(?:tea|coffee|infuser|french press|teapot|honey|milk frother)\b/i, "Tea & coffee"],
  [/\b(?:candies|sweets|mints?|chocolate|gummy|lollipop)\b/i, "Sweets & mints"],
  [/\b(?:kitchen|bottle brush|salt|pepper|grinder|spice mill|spatula|whisk|bowls?|peeler|grater|timer|pans?|frying pan|pots?|spoons?|fork|burger press|dough scraper|pizza|nutcracker|jars?|boxes|plastic box)\b/i, "Kitchen utensils"],
  // Clothing and headwear
  [/\b(?:caps?|sun visors?|visors?)\b/i, "Caps"],
  [/\b(?:hats?|bucket hats?)\b/i, "Hats & bucket hats"],
  [/\b(?:beanies?|scarf|scarves|gloves?|snood|neck warmer|bandana)\b/i, "Beanies, scarves & gloves"],
  [/\b(?:socks?|slippers?|flip[- ]?flops?|shoes?)\b/i, "Footwear & socks"],
  [/\bt-?shirts?\b/i, "T-shirts"],
  [/\b(?:jackets?|vests?|bodywarmers?|softshell)\b/i, "Jackets, bodywarmers & fleece"],
  [/\b(?:teddy|plush|cuddly|soft toy)\b/i, "Plush toys"],
  // Home and leisure
  [/\b(?:blankets?|plaids?|throws?)\b/i, "Blankets"],
  [/\btowels?\b/i, "Towels"],
  [/\b(?:bath|shower|sauna|massag\w*|spa|relax\w*)\b/i, "Bath & relax"],
  [/\b(?:picnic|camping|barbe(?:c|q)ue|bbq|grill|hammocks?|tents?|lanterns?|foldable (?:arm)?chairs?)\b/i, "Picnic, camping & barbecue"],
  [/\b(?:beach|inflatable|air mattress(?:es)?|swim\w*|pool|frisbees?|fans?|sun shade|donut)\b/i, "Beach & summer"],
  [/\b(?:anti-?stress|squeez\w*|stress ball|kneadable)\b/i, "Anti-stress toys"],
  [/\b(?:sports?|fitness|yoga|skipping rope|jump rope|football|basketball|balls?|golf|table tennis|stopwatch|sweatbands?|whistles?|fascia roller)\b/i, "Sport & fitness"],
  [/\b(?:garden\w*|plants?|seeds?|flower ?pots?|watering|bird ?house|insect hotel)\b/i, "Gardening & plants"],
  [/\b(?:dogs?|walking|hiking|outdoor|compass|binoculars?|seat cushions?)\b/i, "Outdoor & walking"],
  // Kids
  [/\b(?:piggy bank|money box|savings box|games?|puzzles?|toys?|cards?|dice|domino|mikado|chess|yo-?yo|kites?|dartboard|stacking|spinner|bubbles?|kaleidoscope|miniature|4 in a row)\b/i, "Games, toys & puzzles"],
  [/\b(?:school|stickers?)\b/i, "School supplies"],
  [/\b(?:baby|bibs?|night light)\b/i, "Baby & toddlers"],
  // Christmas
  [/\b(?:christmas|xmas|advent|santa|reindeer|snowman)\b.*\b(?:decoration|ornament|bauble|tree)s?\b|\b(?:baubles?|christmas tree|star (?:set|pendant)|ornament set)\b/i, "Christmas decorations"],
  [/\b(?:christmas|xmas|advent|santa|reindeer|snowman)\b/i, "Christmas gifts"],
  // Last: what lights a fire, and the rest of the home
  [/\b(?:lighters?|ligthers?|ashtrays?|ash trays?)\b/i, "Home decor & accessories"],
  [/\b(?:photo frames?|picture frames?|vases?|decor\w*|cushions?|pillows?|door ?stops?|roses?|trophy|trophies)\b/i, "Home decor & accessories"],
];

export function kindOf(nameEn: string): string | null {
  return RULES.find(([pattern]) => pattern.test(nameEn))?.[1] ?? null;
}

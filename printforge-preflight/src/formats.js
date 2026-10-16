// Print format catalog, structured the same way PrintGo's picker is:
// category -> sizes, each size in either US (inches) or metric (mm).
// Canonical storage is always mm; `system` just decides how it's displayed.

const MM_PER_IN = 25.4;
const MM_TO_PT = 72 / 25.4;

function inSize(key, label, wIn, hIn, bleedMm = 3.175) {
  return { key, label, wMm: round(wIn * MM_PER_IN), hMm: round(hIn * MM_PER_IN), system: 'us', bleedMm };
}
function mmSize(key, label, wMm, hMm, bleedMm = 3) {
  return { key, label, wMm, hMm, system: 'metric', bleedMm };
}
function round(n) {
  return Math.round(n * 100) / 100;
}

const CATEGORIES = [
  {
    key: 'flyers',
    label: 'Flyers & Leaflets',
    sizes: [
      inSize('us-letter', 'US Letter', 8.5, 11),
      inSize('half-letter', 'Half-Letter', 5.5, 8.5),
      inSize('quarter-page', 'Quarter-Page', 4.25, 5.5),
      inSize('tabloid', 'Tabloid', 11, 17),
      inSize('postcard-4x6', 'Postcard 4x6', 4, 6),
      inSize('postcard-5x7', 'Postcard 5x7', 5, 7),
      inSize('postcard-6x9', 'Postcard 6x9', 6, 9),
      mmSize('a3-flyer', 'A3 Flyer', 297, 420),
      mmSize('a4-flyer', 'A4 Flyer', 210, 297),
      mmSize('a5-flyer', 'A5 Flyer', 148, 210),
      mmSize('a6-flyer', 'A6 Flyer', 105, 148),
      mmSize('a7-flyer', 'A7 Flyer', 74, 105),
      mmSize('dl-flyer', 'DL Flyer', 99, 210),
    ],
  },
  {
    key: 'posters',
    label: 'Posters',
    sizes: [
      inSize('small-poster', 'Small Poster', 11, 17),
      inSize('medium-poster', 'Medium Poster', 18, 24),
      inSize('large-poster', 'Large Poster', 24, 36),
      mmSize('b2-poster', 'B2 Poster', 500, 707),
      mmSize('a1-poster', 'A1 Poster', 594, 841),
      mmSize('a2-poster', 'A2 Poster', 420, 594),
      mmSize('a3-poster', 'A3 Poster', 297, 420),
      mmSize('a4-poster', 'A4 Poster', 210, 297),
    ],
  },
  {
    key: 'door-hangers',
    label: 'Door Hangers',
    sizes: [inSize('door-hanger-3-5x8-5', 'Door Hanger 3.5x8.5', 3.5, 8.5), inSize('door-hanger-4-5x11', 'Door Hanger 4.5x11', 4.5, 11)],
  },
  {
    key: 'roller-banners',
    label: 'Roller Banners',
    sizes: [
      mmSize('rb-600x1660', 'Roller Banner 65x165cm', 600, 1660, 0),
      mmSize('rb-850x2060', 'Roller Banner 85x206cm', 850, 2060, 0),
      mmSize('rb-1000x2050', 'Roller Banner 100x200cm', 1000, 2050, 0),
      mmSize('rb-1180x2060', 'Roller Banner 118x206cm', 1180, 2060, 0),
    ],
  },
  {
    key: 'business-cards',
    label: 'Business Cards',
    sizes: [mmSize('bc-standard', 'Standard', 85, 55), mmSize('bc-square', 'Square', 65, 65)],
  },
];

// Colour profile choices, matching PrintGo's "Universal / Europe / USA" picker.
// NOTE: only FOGRA39 is a real bundled ICC file right now (see profiles/FOGRA39.icc).
// Europe (FOGRA51) and USA (GRACoL 2013) fall back to FOGRA39 under the hood until
// those profile files are sourced and added to profiles/ — this is flagged honestly
// in the API response rather than silently mislabeled.
const COLOUR_PROFILES = {
  universal: { key: 'universal', label: 'Universal', standard: 'FOGRA39', real: true },
  europe: { key: 'europe', label: 'Europe', standard: 'FOGRA51', real: false },
  usa: { key: 'usa', label: 'USA', standard: 'GRACoL 2013', real: false },
};

const BLEED_STYLES = {
  artwork: { key: 'artwork', label: 'Artwork', description: 'Your design fills the full bleed' },
  white: { key: 'white', label: 'White', description: 'White bleed margin' },
  mirror: { key: 'mirror', label: 'Mirror', description: 'Reflected artwork fills the bleed' },
};

function findSize(categoryKey, sizeKey) {
  const cat = CATEGORIES.find((c) => c.key === categoryKey);
  if (!cat) throw new Error(`Unknown category "${categoryKey}"`);
  const size = cat.sizes.find((s) => s.key === sizeKey);
  if (!size) throw new Error(`Unknown size "${sizeKey}" in category "${categoryKey}"`);
  return { ...size, category: cat.key, categoryLabel: cat.label };
}

// Builds the same "format" shape the rest of the pipeline (prepare-image,
// make-pdf, pdfx-convert, preflight) already expects, with an overridable
// bleed amount (custom bleed from the UI) layered on top of the size default.
function getFormat({ category, size, bleedMm }) {
  const s = findSize(category, size);
  const finalBleedMm = bleedMm != null ? bleedMm : s.bleedMm;
  return {
    key: `${category}/${size}`,
    label: `${s.categoryLabel} — ${s.label}`,
    trimWidthMm: s.wMm,
    trimHeightMm: s.hMm,
    bleedMm: finalBleedMm,
    mmToPt: MM_TO_PT,
    trimWidthPt: s.wMm * MM_TO_PT,
    trimHeightPt: s.hMm * MM_TO_PT,
    bleedPt: finalBleedMm * MM_TO_PT,
  };
}

module.exports = { CATEGORIES, COLOUR_PROFILES, BLEED_STYLES, findSize, getFormat, MM_TO_PT, MM_PER_IN };

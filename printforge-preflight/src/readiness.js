const sharp = require('sharp');
const { CATEGORIES } = require('./formats');

const TARGET_DPI = 300;

/**
 * Analyzes a raw, just-uploaded image against a chosen format — before any
 * conversion happens — mirroring PrintGo's "Print readiness: Not ready, N to
 * fix" screen: resolution, colour, bleed, format, fit, and transparency.
 * Each failing item names what the pipeline will do to fix it automatically.
 */
async function analyzeReadiness({ imagePath, originalName, format }) {
  const meta = await sharp(imagePath).metadata();
  const items = [];

  // --- Resolution: what DPI would this image be printed at, at this trim size? ---
  const impliedDpiW = (meta.width / format.trimWidthMm) * 25.4;
  const impliedDpiH = (meta.height / format.trimHeightMm) * 25.4;
  const impliedDpi = Math.round(Math.min(impliedDpiW, impliedDpiH));
  items.push({
    key: 'resolution',
    label: 'Resolution',
    value: `${impliedDpi} DPI`,
    status: impliedDpi >= TARGET_DPI ? 'pass' : 'fail',
    detail:
      impliedDpi >= TARGET_DPI
        ? `${impliedDpi} DPI at ${format.label} — sharp enough to print.`
        : `${impliedDpi} DPI at ${format.label} — too low, prints soft & blocky.`,
    fix: 'We upscale it to 300 DPI.',
  });

  // --- Colour: uploaded web images are effectively always RGB. ---
  items.push({
    key: 'colour',
    label: 'Colour',
    value: 'RGB',
    status: 'fail',
    detail: 'Screen (RGB) colour — reds & blues shift when printed on a press.',
    fix: 'We convert it to CMYK so it prints true.',
  });

  // --- Bleed: a raw upload never has one. ---
  items.push({
    key: 'bleed',
    label: 'Bleed',
    value: 'none',
    status: 'fail',
    detail: "No bleed margin — risks thin white slivers when it's trimmed.",
    fix: `We add a ${format.bleedMm}mm bleed margin.`,
  });

  // --- Format: PNG/JPG/WebP aren't press-ready; only a certified PDF/X-1a is. ---
  const ext = (originalName || '').split('.').pop()?.toUpperCase() || meta.format?.toUpperCase() || 'UNKNOWN';
  items.push({
    key: 'format',
    label: 'Format',
    value: ext,
    status: 'fail',
    detail: `A ${ext} isn't a print-ready format — shops need a certified PDF.`,
    fix: 'We package it as a verified PDF/X-1a.',
  });

  // --- Fit: does the image's aspect ratio actually match the chosen trim size? ---
  const imgRatio = meta.width / meta.height;
  const trimRatio = format.trimWidthMm / format.trimHeightMm;
  const ratioDiffPct = Math.abs(imgRatio - trimRatio) / trimRatio;
  if (ratioDiffPct > 0.04) {
    const padMm = estimatePadding({ imgRatio, trimWidthMm: format.trimWidthMm, trimHeightMm: format.trimHeightMm });
    const closer = suggestCloserFormat({ imgRatio, excludeKey: format.key });
    items.push({
      key: 'fit',
      label: 'Fit',
      value: `~${padMm} mm`,
      status: 'warn',
      detail: `Doesn't fill ${format.label} (${(ratioDiffPct * 100).toFixed(0)}% aspect mismatch) — about ${padMm}mm padded on the long edges.`,
      fix: closer ? `${closer.categoryLabel} ${closer.label} fits closer.` : 'Choose "Mirror" or "White" bleed style to control the padded edges.',
    });
  } else {
    items.push({ key: 'fit', label: 'Fit', value: 'good', status: 'pass', detail: `Fills ${format.label} edge-to-edge.`, fix: null });
  }

  // --- Transparency: PDF/X-1a can't carry an alpha channel. ---
  items.push({
    key: 'transparency',
    label: 'Transparency',
    value: meta.hasAlpha ? 'present' : 'none',
    status: meta.hasAlpha ? 'fail' : 'pass',
    detail: meta.hasAlpha ? 'Image has transparency — PDF/X-1a can\'t carry an alpha channel.' : 'No transparency to flatten.',
    fix: meta.hasAlpha ? 'We flatten it onto a white background.' : null,
  });

  const toFix = items.filter((i) => i.status === 'fail').length;
  const passed = toFix === 0;

  return {
    passed,
    toFix,
    items,
    sourceWidthPx: meta.width,
    sourceHeightPx: meta.height,
    hasAlpha: !!meta.hasAlpha,
  };
}

function estimatePadding({ imgRatio, trimWidthMm, trimHeightMm }) {
  const trimRatio = trimWidthMm / trimHeightMm;
  if (imgRatio > trimRatio) {
    // Image is relatively wider than the trim -> padding on top/bottom.
    const scaledH = trimWidthMm / imgRatio;
    return Math.round((trimHeightMm - scaledH) / 2);
  }
  const scaledW = trimHeightMm * imgRatio;
  return Math.round((trimWidthMm - scaledW) / 2);
}

function suggestCloserFormat({ imgRatio, excludeKey }) {
  let best = null;
  let bestDiff = Infinity;
  for (const cat of CATEGORIES) {
    for (const size of cat.sizes) {
      const key = `${cat.key}/${size.key}`;
      if (key === excludeKey) continue;
      const ratio = size.wMm / size.hMm;
      const diff = Math.abs(ratio - imgRatio);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = { ...size, categoryLabel: cat.label };
      }
    }
  }
  return best;
}

module.exports = { analyzeReadiness };

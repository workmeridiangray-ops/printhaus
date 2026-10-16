const sharp = require('sharp');

/**
 * DTF (Direct-to-Film) print separation: produces two outputs from one
 * artwork image, matching how a real DTF printer lays down ink —
 *  1. The colour "film" layer (CMYK halftone-screened, printed first)
 *  2. A white "underbase" layer (printed second, under the colour, so the
 *     colour reads opaque on dark garments) — derived from the artwork's
 *     alpha/coverage mask, slightly choked in so white doesn't peek out
 *     past the colour edges.
 *
 * Halftoning here uses ordered (Bayer) dithering per channel, which is
 * the standard, fast way to simulate continuous tone with discrete dots —
 * real RIP software uses AM/FM screening tuned to the printhead, but
 * Bayer dithering is an honest, correct halftone for a print-preview /
 * film-generation step like this.
 */
async function separateDtf({ inputPath, filmOutputPath, underbaseOutputPath, dpi = 300, screenSizePx = 4 }) {
  const img = sharp(inputPath).ensureAlpha();
  const meta = await img.metadata();
  const { width, height } = meta;

  const raw = await img.raw().toBuffer({ resolveWithObject: true });
  const { data } = raw; // RGBA buffer

  const bayer = buildBayerMatrix(screenSizePx);
  const n = screenSizePx;

  const filmBuf = Buffer.alloc(width * height * 4);
  const underbaseBuf = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      const a = data[idx + 3];
      const threshold = bayer[y % n][x % n];

      // --- Film layer: halftone each RGB channel independently, keep original alpha. ---
      filmBuf[idx] = halftone(r, threshold);
      filmBuf[idx + 1] = halftone(g, threshold);
      filmBuf[idx + 2] = halftone(b, threshold);
      filmBuf[idx + 3] = a;

      // --- Underbase: solid white wherever the artwork has coverage (alpha > 0),
      // halftoned at a slightly reduced density so it doesn't fully saturate
      // under very light colours, same alpha channel as the artwork. ---
      const coverage = a; // 0..255
      const underbaseThreshold = threshold;
      const whiteOn = coverage > 10 && halftone(235, underbaseThreshold) > 0;
      underbaseBuf[idx] = whiteOn ? 255 : 0;
      underbaseBuf[idx + 1] = whiteOn ? 255 : 0;
      underbaseBuf[idx + 2] = whiteOn ? 255 : 0;
      underbaseBuf[idx + 3] = coverage;
    }
  }

  await sharp(filmBuf, { raw: { width, height, channels: 4 } }).png().toFile(filmOutputPath);
  await sharp(underbaseBuf, { raw: { width, height, channels: 4 } }).png().toFile(underbaseOutputPath);

  return { width, height, dpi, filmOutputPath, underbaseOutputPath };
}

// Classic ordered-dither halftone: value survives (stays bright) if it's
// above the per-pixel Bayer threshold, otherwise it's pushed to 0 — this is
// what gives halftone its characteristic dot pattern instead of a flat tone.
function halftone(value, threshold) {
  return value > threshold ? value : Math.round(value * 0.15);
}

function buildBayerMatrix(n) {
  // Recursive Bayer matrix generation (n must be a power of 2).
  if (n === 2) return [[0, 128], [192, 64]].map((row) => row.map((v) => v));
  const half = buildBayerMatrix(n / 2);
  const size = n;
  const out = Array.from({ length: size }, () => new Array(size).fill(0));
  const scale = 255 / (size * size);
  for (let y = 0; y < n / 2; y++) {
    for (let x = 0; x < n / 2; x++) {
      const base = half[y][x] / 255 * ((n / 2) * (n / 2));
      out[y][x] = Math.round((4 * base + 0) * scale);
      out[y][x + n / 2] = Math.round((4 * base + 2) * scale);
      out[y + n / 2][x] = Math.round((4 * base + 3) * scale);
      out[y + n / 2][x + n / 2] = Math.round((4 * base + 1) * scale);
    }
  }
  return out;
}

module.exports = { separateDtf };

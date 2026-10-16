const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { aiUpscale, planUpscalePasses } = require('./ai-upscale');

const TARGET_DPI = 300;
// Below this, a plain Lanczos stretch gets visibly soft — worth the extra
// seconds to run a real learned upscaler first instead of just stretching.
const AI_UPSCALE_THRESHOLD = 1.5;
const mmToPx = (mm) => Math.round((mm / 25.4) * TARGET_DPI);

/**
 * Takes a raw AI-generated image and produces a high-res raster that
 * exactly fills the trim+bleed area at 300 DPI, using one of three bleed
 * styles (matching PrintGo's "Artwork / White / Mirror" picker):
 *
 *  - artwork: the image itself is upscaled/cropped to cover the full
 *             bleed+trim canvas (no visible seam) — the default.
 *  - white:   the image fills only the trim area; the bleed margin is
 *             solid white.
 *  - mirror:  the image fills the trim area, and the bleed margin is
 *             filled with a mirrored reflection of the image's own edges
 *             (so cutting into the bleed still looks like "more of the
 *             image" rather than a hard white or stretched edge).
 */
async function prepareImage({ inputPath, outputPath, format, bleedStyle = 'artwork' }) {
  const trimW = mmToPx(format.trimWidthMm);
  const trimH = mmToPx(format.trimHeightMm);
  const bleedPx = mmToPx(format.bleedMm);
  const fullW = trimW + bleedPx * 2;
  const fullH = trimH + bleedPx * 2;

  const meta = await sharp(inputPath).metadata();
  const upscaleFactor = Math.max(fullW / meta.width, fullH / meta.height);

  // When the source is well below what's needed, run it through a real
  // learned super-resolution model first (ESPCN) instead of letting the
  // final cover-resize do one big Lanczos stretch, which just smooths
  // existing pixels rather than reconstructing plausible detail.
  let sourcePath = inputPath;
  let aiUpscaled = false;
  let tmpAiPath = null;
  if (upscaleFactor > AI_UPSCALE_THRESHOLD) {
    const passes = planUpscalePasses(upscaleFactor);
    let current = inputPath;
    for (let i = 0; i < passes.length; i++) {
      const next = path.join(os.tmpdir(), `ai-upscale-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}.png`);
      await aiUpscale({ inputPath: current, outputPath: next, scale: passes[i] });
      if (current !== inputPath) fs.unlinkSync(current);
      current = next;
    }
    if (current !== inputPath) {
      sourcePath = current;
      tmpAiPath = current;
      aiUpscaled = true;
    }
  }

  let composite;

  if (bleedStyle === 'artwork' || bleedPx === 0) {
    composite = await coverResize(sourcePath, fullW, fullH);
  } else {
    // Build the trim-sized artwork first, then compose it onto the full
    // bleed canvas with either a white or mirrored margin.
    const trimBuffer = await coverResize(sourcePath, trimW, trimH);

    if (bleedStyle === 'white') {
      composite = await sharp({
        create: { width: fullW, height: fullH, channels: 3, background: { r: 255, g: 255, b: 255 } },
      })
        .composite([{ input: trimBuffer, left: bleedPx, top: bleedPx }])
        .png()
        .toBuffer();
    } else if (bleedStyle === 'mirror') {
      composite = await mirrorBleed(trimBuffer, trimW, trimH, bleedPx, fullW, fullH);
    } else {
      throw new Error(`Unknown bleed style "${bleedStyle}"`);
    }
  }

  await sharp(composite).withMetadata({ density: TARGET_DPI }).toFile(outputPath);
  if (tmpAiPath && fs.existsSync(tmpAiPath)) fs.unlinkSync(tmpAiPath);

  return {
    widthPx: fullW,
    heightPx: fullH,
    dpi: TARGET_DPI,
    upscaleFactor,
    sourceWidthPx: meta.width,
    sourceHeightPx: meta.height,
    bleedStyle,
    aiUpscaled,
  };
}

async function coverResize(inputPath, w, h) {
  return sharp(inputPath)
    .resize(w, h, { fit: 'cover', position: 'centre', kernel: sharp.kernel.lanczos3 })
    .flatten({ background: { r: 255, g: 255, b: 255 } }) // drop alpha: PDF/X-1a can't carry transparency
    .sharpen()
    .toColourspace('srgb')
    .png()
    .toBuffer();
}

async function mirrorBleed(trimBuffer, trimW, trimH, bleedPx, fullW, fullH) {
  if (bleedPx === 0) {
    return sharp(trimBuffer).png().toBuffer();
  }

  const left = await sharp(trimBuffer).extract({ left: 0, top: 0, width: bleedPx, height: trimH }).flop().toBuffer();
  const right = await sharp(trimBuffer)
    .extract({ left: trimW - bleedPx, top: 0, width: bleedPx, height: trimH })
    .flop()
    .toBuffer();

  const middleRow = await sharp({ create: { width: trimW + bleedPx * 2, height: trimH, channels: 3, background: '#fff' } })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: trimBuffer, left: bleedPx, top: 0 },
      { input: right, left: bleedPx + trimW, top: 0 },
    ])
    .png()
    .toBuffer();

  const top = await sharp(middleRow).extract({ left: 0, top: 0, width: fullW, height: bleedPx }).flip().toBuffer();
  const bottom = await sharp(middleRow)
    .extract({ left: 0, top: trimH - bleedPx, width: fullW, height: bleedPx })
    .flip()
    .toBuffer();

  return sharp({ create: { width: fullW, height: fullH, channels: 3, background: '#fff' } })
    .composite([
      { input: top, left: 0, top: 0 },
      { input: middleRow, left: 0, top: bleedPx },
      { input: bottom, left: 0, top: bleedPx + trimH },
    ])
    .png()
    .toBuffer();
}

module.exports = { prepareImage, TARGET_DPI };

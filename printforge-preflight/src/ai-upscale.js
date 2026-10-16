const { execFile } = require('child_process');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'upscale.py');

/**
 * Real learned super-resolution (ESPCN model via OpenCV's dnn_superres),
 * as opposed to a plain Lanczos/bicubic stretch. Matches PrintGo's
 * advertised "Image upscaler (2x / 4x)" feature.
 *
 * `scale` must be 2 or 4 — those are the two pretrained models we ship.
 */
async function aiUpscale({ inputPath, outputPath, scale }) {
  const s = scale >= 4 ? 4 : 2;
  return new Promise((resolve, reject) => {
    execFile('python3', [SCRIPT_PATH, inputPath, outputPath, String(s)], { maxBuffer: 1024 * 1024 * 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`AI upscale failed: ${stderr || err.message}`));
      const [w, h] = stdout.trim().split('x').map(Number);
      resolve({ outputPath, scale: s, widthPx: w, heightPx: h });
    });
  });
}

/**
 * A single AI upscale pass (2x or 4x) is enough: its job is to recover
 * plausible real detail once, not to hit the exact final pixel size —
 * the pipeline's existing Lanczos cover-resize handles precise final
 * sizing afterwards. Chaining multiple AI passes to reach very large
 * factors (e.g. 16x) multiplies memory use fast and OOMs on ordinary
 * hardware for no real quality gain over one good pass + a clean resize.
 */
function planUpscalePasses(neededFactor) {
  if (neededFactor <= 1.05) return [];
  return [neededFactor >= 3.5 ? 4 : 2];
}

module.exports = { aiUpscale, planUpscalePasses };

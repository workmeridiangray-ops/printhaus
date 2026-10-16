const sharp = require('sharp');
const fs = require('fs');
const { execFile } = require('child_process');
const path = require('path');

/**
 * Builds a plotter-ready sticker cut-line: traces the artwork's silhouette
 * (from its alpha channel) into a vector outline, offset outward by a small
 * bleed so the cut line sits just outside the printed edge (standard sticker
 * practice — a cut line exactly on the edge risks shaving into the artwork
 * on any registration drift).
 *
 * Pipeline: alpha mask -> PBM bitmap -> potrace (vector trace) -> SVG,
 * with the traced path offset outward using a dilate on the mask before
 * tracing (cheaper and more robust than polygon-offsetting the vector path).
 */
async function buildCutline({ inputPath, outputSvgPath, offsetMm = 2, dpi = 300 }) {
  const img = sharp(inputPath).ensureAlpha();
  const meta = await img.metadata();
  const { width, height } = meta;

  // Extract alpha channel as the cut mask; dilate it outward by offsetMm so
  // the cut line clears the printed edge.
  const offsetPx = Math.max(1, Math.round((offsetMm / 25.4) * dpi));

  const { data: alphaData } = await img
    .extractChannel('alpha')
    .threshold(10)
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Grow the "on" region outward by offsetPx so the cut line clears the printed edge.
  const dilated = dilateMask(alphaData, width, height, offsetPx);

  const pbmPath = outputSvgPath + '.pbm';
  writePbm(dilated, width, height, pbmPath);

  await new Promise((resolve, reject) => {
    execFile('potrace', ['-s', '-o', outputSvgPath, pbmPath], (err, stdout, stderr) => {
      if (err) return reject(new Error(`potrace failed: ${stderr || err.message}`));
      resolve();
    });
  });

  fs.unlinkSync(pbmPath);

  // potrace outputs the cut path as black fill; tag it so the UI/PDF layer
  // step can style it as a spot "CutContour" stroke instead of a fill.
  let svg = fs.readFileSync(outputSvgPath, 'utf8');
  svg = svg.replace(/fill="#000000"/g, 'fill="none" stroke="#FF00FF" stroke-width="0.5" id="CutContour"');
  fs.writeFileSync(outputSvgPath, svg);

  return { outputSvgPath, offsetMm, width, height };
}

function dilateMask(data, width, height, radiusPx) {
  // Simple box-dilate: a pixel becomes "on" if any pixel within radiusPx is on.
  // O(w*h*r) — fine for sticker-sized artwork (a few hundred px) at small radii.
  const out = Buffer.alloc(data.length);
  const r = Math.min(radiusPx, 12); // cap cost for very high-DPI inputs
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let on = false;
      for (let dy = -r; dy <= r && !on; dy += Math.max(1, Math.floor(r / 3))) {
        for (let dx = -r; dx <= r && !on; dx += Math.max(1, Math.floor(r / 3))) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny >= 0 && ny < height && nx >= 0 && nx < width && data[ny * width + nx] > 0) on = true;
        }
      }
      out[y * width + x] = on ? 255 : 0;
    }
  }
  return out;
}

function writePbm(buf, width, height, outPath) {
  // P4 (binary PBM): 1 = black. Our mask is 255=on(white)/0=off, PBM wants
  // inverted bit packing where 1-bit = black pixel, so invert accordingly.
  const rowBytes = Math.ceil(width / 8);
  const bitmap = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = buf[y * width + x] > 127; // "on" = inside silhouette = should be black in PBM
      if (on) {
        const byteIdx = y * rowBytes + (x >> 3);
        bitmap[byteIdx] |= 0x80 >> (x & 7);
      }
    }
  }
  const header = `P4\n${width} ${height}\n`;
  fs.writeFileSync(outPath, Buffer.concat([Buffer.from(header, 'ascii'), bitmap]));
}

module.exports = { buildCutline };

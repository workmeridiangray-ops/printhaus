const sharp = require('sharp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

/**
 * Raster-to-vector "AI vectorizer": quantizes the artwork down to a small
 * palette (k-means-ish via sharp's built-in palette quantization), traces
 * each colour's mask separately with potrace, and layers the resulting
 * paths into one multi-colour SVG. This is the same general approach real
 * vectorizers use (posterize + per-colour trace) — potrace itself only
 * traces single-colour bitmaps, so the multi-colour layering is what turns
 * it into a usable "vectorize my logo" tool instead of a black/white trace.
 *
 * Also renders a flat PNG preview of the resulting vector (useful for a
 * side-by-side "before/after" in the UI).
 */
async function vectorizeImage({ inputPath, outputSvgPath, outputPngPath, colours = 6 }) {
  const img = sharp(inputPath).ensureAlpha();
  const meta = await img.metadata();
  const { width, height } = meta;

  // Quantize to a small palette. sharp's png({palette:true}) does
  // median-cut quantization under the hood; reading it back gives us a
  // paletted PNG we can pull raw indexed-ish color groups from via raw RGBA.
  const quantPath = path.join(os.tmpdir(), `vectorize-quant-${Date.now()}.png`);
  await img.png({ palette: true, colours }).toFile(quantPath);

  const { data } = await sharp(quantPath).raw().ensureAlpha().toBuffer({ resolveWithObject: true });

  // Collect the distinct colours actually present.
  const colourSet = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 10) continue; // transparent -> no layer
    const key = `${data[i]},${data[i + 1]},${data[i + 2]}`;
    if (!colourSet.has(key)) colourSet.set(key, true);
  }

  const layers = [];
  const tmpFiles = [];
  for (const key of colourSet.keys()) {
    const [r, g, b] = key.split(',').map(Number);
    const maskBuf = Buffer.alloc(width * height);
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      const a = data[i + 3];
      const match = a >= 10 && data[i] === r && data[i + 1] === g && data[i + 2] === b;
      maskBuf[p] = match ? 255 : 0;
    }
    const pbmPath = path.join(os.tmpdir(), `vectorize-${Date.now()}-${r}-${g}-${b}.pbm`);
    writePbm(maskBuf, width, height, pbmPath);
    const svgPath = pbmPath + '.svg';
    tmpFiles.push(pbmPath, svgPath);

    await new Promise((resolve, reject) => {
      execFile('potrace', ['-s', '-o', svgPath, pbmPath], (err, stdout, stderr) => {
        if (err) return reject(new Error(`potrace failed: ${stderr || err.message}`));
        resolve();
      });
    });

    const svgContent = fs.readFileSync(svgPath, 'utf8');
    // potrace's -s output wraps all paths for this trace in one <g transform="...">
    // block (its own point-scale + Y-flip) — keep the whole group intact
    // (including every sub-path, for disconnected regions/holes) and just
    // retint its baked-in fill="#000000" to this layer's real colour.
    const groupMatch = svgContent.match(/<g transform="[^"]*"\n?fill="#000000" stroke="none">[\s\S]*?<\/g>/);
    if (groupMatch) {
      const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      const retinted = groupMatch[0].replace('fill="#000000"', `fill="${hex}"`);
      layers.push(retinted);
    }
  }

  const svgOut = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n${layers.join('\n')}\n</svg>\n`;
  fs.writeFileSync(outputSvgPath, svgOut);

  for (const f of tmpFiles) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  fs.unlinkSync(quantPath);

  if (outputPngPath) {
    await new Promise((resolve, reject) => {
      execFile('rsvg-convert', ['-w', String(width), '-h', String(height), '-o', outputPngPath, outputSvgPath], (err, stdout, stderr) => {
        if (err) return reject(new Error(`rsvg-convert failed: ${stderr || err.message}`));
        resolve();
      });
    });
  }

  return { outputSvgPath, outputPngPath, colours: colourSet.size, width, height };
}

function writePbm(buf, width, height, outPath) {
  const rowBytes = Math.ceil(width / 8);
  const bitmap = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const on = buf[y * width + x] > 127;
      if (on) {
        const byteIdx = y * rowBytes + (x >> 3);
        bitmap[byteIdx] |= 0x80 >> (x & 7);
      }
    }
  }
  const header = `P4\n${width} ${height}\n`;
  fs.writeFileSync(outPath, Buffer.concat([Buffer.from(header, 'ascii'), bitmap]));
}

module.exports = { vectorizeImage };

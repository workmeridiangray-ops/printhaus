const fs = require('fs');
const path = require('path');
const { PDFDocument, rgb, PDFArray, PDFNumber, PDFName } = require('pdf-lib');

const MARK_LENGTH_PT = 3 * (72 / 25.4); // 3mm mark length
const MARK_GAP_PT = 0.5 * (72 / 25.4); // small gap between trim edge and mark start
const MARK_WIDTH_PT = 0.25; // 0.25pt registration stroke, matches PrintGo's spec

/**
 * Builds a PDF where each page:
 *  - IS the bleed box (trim + bleed on every side)
 *  - has its raster image covering the full page
 *  - gets registration/crop marks drawn just outside the trim line
 *  - gets real TrimBox/BleedBox PDF boxes (not just visual guides)
 *
 * Accepts either a single `imagePath` (back-compat, one page) or an
 * `imagePaths` array for multi-page / double-sided (front + back) jobs —
 * page order follows array order, so [front, back] prints front-then-back.
 */
async function makePdf({ imagePath, imagePaths, outputPath, format }) {
  const paths = imagePaths && imagePaths.length ? imagePaths : [imagePath];
  const pdfDoc = await PDFDocument.create();

  const pageW = format.trimWidthPt + format.bleedPt * 2;
  const pageH = format.trimHeightPt + format.bleedPt * 2;
  const trimX0 = format.bleedPt;
  const trimY0 = format.bleedPt;
  const trimX1 = pageW - format.bleedPt;
  const trimY1 = pageH - format.bleedPt;

  for (const p of paths) {
    const imageBytes = fs.readFileSync(p);
    const ext = path.extname(p).toLowerCase();
    const image = ext === '.jpg' || ext === '.jpeg' ? await pdfDoc.embedJpg(imageBytes) : await pdfDoc.embedPng(imageBytes);

    const page = pdfDoc.addPage([pageW, pageH]);
    page.drawImage(image, { x: 0, y: 0, width: pageW, height: pageH });
    drawCropMarks(page, { trimX0, trimY0, trimX1, trimY1, pageW, pageH });

    const trimBox = PDFArray.withContext(pdfDoc.context);
    [trimX0, trimY0, trimX1, trimY1].forEach((v) => trimBox.push(PDFNumber.of(v)));
    page.node.set(PDFName.of('TrimBox'), trimBox);

    const bleedBox = PDFArray.withContext(pdfDoc.context);
    [0, 0, pageW, pageH].forEach((v) => bleedBox.push(PDFNumber.of(v)));
    page.node.set(PDFName.of('BleedBox'), bleedBox);
  }

  const bytes = await pdfDoc.save();
  fs.writeFileSync(outputPath, bytes);

  return { pageW, pageH, trimX0, trimY0, trimX1, trimY1, pageCount: paths.length };
}

function drawCropMarks(page, { trimX0, trimY0, trimX1, trimY1, pageW, pageH }) {
  const color = rgb(0, 0, 0);
  const thickness = MARK_WIDTH_PT;

  const corners = [
    { x: trimX0, y: trimY0, dx: -1, dy: -1 }, // bottom-left
    { x: trimX1, y: trimY0, dx: 1, dy: -1 }, // bottom-right
    { x: trimX0, y: trimY1, dx: -1, dy: 1 }, // top-left
    { x: trimX1, y: trimY1, dx: 1, dy: 1 }, // top-right
  ];

  for (const c of corners) {
    const hStart = c.x + c.dx * MARK_GAP_PT;
    const hEnd = c.x + c.dx * (MARK_GAP_PT + MARK_LENGTH_PT);
    page.drawLine({
      start: { x: clamp(hStart, 0, pageW), y: c.y },
      end: { x: clamp(hEnd, 0, pageW), y: c.y },
      thickness,
      color,
    });

    const vStart = c.y + c.dy * MARK_GAP_PT;
    const vEnd = c.y + c.dy * (MARK_GAP_PT + MARK_LENGTH_PT);
    page.drawLine({
      start: { x: c.x, y: clamp(vStart, 0, pageH) },
      end: { x: c.x, y: clamp(vEnd, 0, pageH) },
      thickness,
      color,
    });
  }
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

module.exports = { makePdf };

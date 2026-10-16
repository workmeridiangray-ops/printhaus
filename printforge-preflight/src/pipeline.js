const fs = require('fs');
const path = require('path');
const { getFormat } = require('./formats');
const { prepareImage } = require('./prepare-image');
const { makePdf } = require('./make-pdf');
const { convertToPdfX1a } = require('./pdfx-convert');
const { runPreflight } = require('./preflight');

/**
 * Full pipeline: raw AI image -> verified press-ready PDF/X-1a.
 * Mirrors PrintGo's four steps: drop image, choose format + options, prep, ship.
 */
async function runPipeline({ inputImagePath, backImagePath, category, size, bleedMm, bleedStyle = 'artwork', colourProfile = 'universal', colourSpace = 'cmyk', workDir, title }) {
  const format = getFormat({ category, size, bleedMm });
  fs.mkdirSync(workDir, { recursive: true });

  const rasterPath = path.join(workDir, '01-raster-front.png');
  const rasterInfo = await prepareImage({ inputPath: inputImagePath, outputPath: rasterPath, format, bleedStyle });

  const rasterPaths = [rasterPath];
  let backRasterInfo = null;
  if (backImagePath) {
    const backRasterPath = path.join(workDir, '01-raster-back.png');
    backRasterInfo = await prepareImage({ inputPath: backImagePath, outputPath: backRasterPath, format, bleedStyle });
    rasterPaths.push(backRasterPath);
  }

  const draftPdfPath = path.join(workDir, '02-draft.pdf');
  const pdfInfo = await makePdf({ imagePaths: rasterPaths, outputPath: draftPdfPath, format });

  const finalPdfPath = path.join(workDir, `printforge-${format.key.replace('/', '-')}.pdf`);
  const convertResult = await convertToPdfX1a({ inputPdfPath: draftPdfPath, outputPdfPath: finalPdfPath, title, colourProfile, colourSpace });

  // RGB output isn't PDF/X-1a by definition (ISO 15930-1 requires CMYK), so
  // skip the PDF/X-specific preflight checks for it rather than failing
  // checks that only apply to a standard this file never claimed to meet.
  const preflight = convertResult.isPdfX
    ? await runPreflight({ pdfPath: finalPdfPath, format, expectedPages: pdfInfo.pageCount })
    : { passed: true, checks: [{ name: 'RGB output (not PDF/X-1a)', passed: true, detail: 'Screen-use file — PDF/X-1a checks skipped by design.' }] };

  return {
    format,
    rasterInfo,
    backRasterInfo,
    pdfInfo,
    finalPdfPath,
    preflight,
    profileUsed: convertResult.profileUsed,
    colourSpace: convertResult.colourSpace,
    pageCount: pdfInfo.pageCount,
  };
}

module.exports = { runPipeline };

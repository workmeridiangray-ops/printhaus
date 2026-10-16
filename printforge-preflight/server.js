const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { runPipeline } = require('./src/pipeline');
const { CATEGORIES, COLOUR_PROFILES, BLEED_STYLES, getFormat } = require('./src/formats');
const { analyzeReadiness } = require('./src/readiness');
const { aiUpscale } = require('./src/ai-upscale');
const { removeBackground } = require('./src/bg-remove');
const { vectorizeImage } = require('./src/vectorize');
const { separateDtf } = require('./src/dtf-separate');
const { buildCutline } = require('./src/sticker-cutline');

const app = express();
const PORT = process.env.PORT || 3000;
const JOBS_DIR = path.join(__dirname, 'jobs');
fs.mkdirSync(JOBS_DIR, { recursive: true });

const upload = multer({
  dest: path.join(JOBS_DIR, '_uploads'),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB cap (matches PrintGo Pro tier)
  fileFilter: (req, file, cb) => {
    const ok = /image\/(png|jpeg|webp)/.test(file.mimetype);
    cb(ok ? null : new Error('Only PNG, JPG, or WebP images are accepted.'), ok);
  },
});
const uploadSides = upload.fields([{ name: 'image', maxCount: 1 }, { name: 'backImage', maxCount: 1 }]);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/jobs', express.static(JOBS_DIR));

app.get('/api/categories', (req, res) => {
  res.json({ categories: CATEGORIES, colourProfiles: COLOUR_PROFILES, bleedStyles: BLEED_STYLES });
});

// Step 1: analyze the raw upload against a chosen category/size, before any
// conversion — this is what drives the "Print readiness: Not ready, N to fix" panel.
app.post('/api/analyze', upload.single('image'), async (req, res) => {
  const file = req.file;
  const { category, size } = req.body;
  if (!file) return res.status(400).json({ error: 'No image uploaded.' });

  try {
    const format = getFormat({ category, size });
    const report = await analyzeReadiness({ imagePath: file.path, originalName: file.originalname, format });
    res.json({ format, ...report });
  } catch (err) {
    res.status(400).json({ error: err.message });
  } finally {
    // Readiness is a quick look, not a job — the real upload happens again on /api/convert.
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
});

app.post('/api/convert', uploadSides, async (req, res) => {
  const file = req.files?.image?.[0];
  const backFile = req.files?.backImage?.[0];
  const { category, size, colourProfile, colourSpace, bleedStyle, bleedMm } = req.body;

  if (!file) return res.status(400).json({ error: 'No image uploaded.' });
  if (!category || !size) {
    return res.status(400).json({ error: 'Missing category/size.' });
  }

  const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workDir = path.join(JOBS_DIR, jobId);

  try {
    const renamedInput = file.path + path.extname(file.originalname || '.png');
    fs.renameSync(file.path, renamedInput);

    let renamedBack;
    if (backFile) {
      renamedBack = backFile.path + path.extname(backFile.originalname || '.png');
      fs.renameSync(backFile.path, renamedBack);
    }

    const result = await runPipeline({
      inputImagePath: renamedInput,
      backImagePath: renamedBack,
      category,
      size,
      bleedMm: bleedMm != null && bleedMm !== '' ? parseFloat(bleedMm) : undefined,
      bleedStyle: bleedStyle || 'artwork',
      colourProfile: colourProfile || 'universal',
      colourSpace: colourSpace || 'cmyk',
      workDir,
      title: `PrintForge - ${category}/${size} - ${jobId}`,
    });

    const relativePdfPath = path.relative(JOBS_DIR, result.finalPdfPath);

    res.json({
      jobId,
      format: result.format,
      raster: result.rasterInfo,
      backRaster: result.backRasterInfo,
      pageCount: result.pageCount,
      preflight: result.preflight,
      profileUsed: result.profileUsed,
      colourSpace: result.colourSpace,
      downloadUrl: `/jobs/${relativePdfPath}`,
    });
  } catch (err) {
    console.error(`[${jobId}] pipeline error:`, err);
    res.status(500).json({ error: 'Conversion failed. ' + (err.message || '') });
  } finally {
    if (file && fs.existsSync(file.path)) fs.unlinkSync(file.path);
    if (backFile && fs.existsSync(backFile.path)) fs.unlinkSync(backFile.path);
  }
});

// ---------------------------------------------------------------------
// Standalone tools (PrintGo's Starter-tier toolkit: upscaler, background
// remover, AI vectorizer, DTF halftone, sticker cut-out). Each one takes
// an uploaded image, runs its tool, and returns a downloadable result —
// independent of the main format/PDF pipeline above.
// ---------------------------------------------------------------------
const TOOLS_DIR = path.join(JOBS_DIR, '_tools');
fs.mkdirSync(TOOLS_DIR, { recursive: true });

function toolJobDir() {
  const id = `tool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(TOOLS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

app.post('/api/tools/upscale', upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No image uploaded.' });
  const scale = parseInt(req.body.scale, 10) === 4 ? 4 : 2;
  const { id, dir } = toolJobDir();
  try {
    const renamed = file.path + path.extname(file.originalname || '.png');
    fs.renameSync(file.path, renamed);
    const outputPath = path.join(dir, `upscaled-${scale}x.png`);
    const result = await aiUpscale({ inputPath: renamed, outputPath, scale });
    res.json({ jobId: id, ...result, downloadUrl: `/jobs/_tools/${id}/${path.basename(outputPath)}` });
  } catch (err) {
    console.error(`[${id}] upscale error:`, err);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
});

app.post('/api/tools/remove-bg', upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No image uploaded.' });
  const { id, dir } = toolJobDir();
  try {
    const renamed = file.path + path.extname(file.originalname || '.png');
    fs.renameSync(file.path, renamed);
    const outputPath = path.join(dir, 'no-bg.png');
    await removeBackground({ inputPath: renamed, outputPath });
    res.json({ jobId: id, downloadUrl: `/jobs/_tools/${id}/no-bg.png` });
  } catch (err) {
    console.error(`[${id}] remove-bg error:`, err);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
});

app.post('/api/tools/vectorize', upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No image uploaded.' });
  const colours = Math.min(16, Math.max(2, parseInt(req.body.colours, 10) || 6));
  const { id, dir } = toolJobDir();
  try {
    const renamed = file.path + path.extname(file.originalname || '.png');
    fs.renameSync(file.path, renamed);
    const svgPath = path.join(dir, 'vectorized.svg');
    const pngPath = path.join(dir, 'vectorized-preview.png');
    const result = await vectorizeImage({ inputPath: renamed, outputSvgPath: svgPath, outputPngPath: pngPath, colours });
    res.json({
      jobId: id,
      colours: result.colours,
      svgUrl: `/jobs/_tools/${id}/vectorized.svg`,
      pngUrl: `/jobs/_tools/${id}/vectorized-preview.png`,
    });
  } catch (err) {
    console.error(`[${id}] vectorize error:`, err);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
});

app.post('/api/tools/dtf', upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No image uploaded.' });
  const { id, dir } = toolJobDir();
  try {
    const renamed = file.path + path.extname(file.originalname || '.png');
    fs.renameSync(file.path, renamed);
    const filmPath = path.join(dir, 'film.png');
    const underbasePath = path.join(dir, 'underbase.png');
    await separateDtf({ inputPath: renamed, filmOutputPath: filmPath, underbaseOutputPath: underbasePath });
    res.json({
      jobId: id,
      filmUrl: `/jobs/_tools/${id}/film.png`,
      underbaseUrl: `/jobs/_tools/${id}/underbase.png`,
    });
  } catch (err) {
    console.error(`[${id}] dtf error:`, err);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
});

app.post('/api/tools/sticker-cutline', upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No image uploaded.' });
  const offsetMm = req.body.offsetMm ? parseFloat(req.body.offsetMm) : 2;
  const { id, dir } = toolJobDir();
  try {
    const renamed = file.path + path.extname(file.originalname || '.png');
    fs.renameSync(file.path, renamed);
    const svgPath = path.join(dir, 'cutline.svg');
    await buildCutline({ inputPath: renamed, outputSvgPath: svgPath, offsetMm });
    res.json({ jobId: id, svgUrl: `/jobs/_tools/${id}/cutline.svg` });
  } catch (err) {
    console.error(`[${id}] sticker-cutline error:`, err);
    res.status(500).json({ error: err.message });
  } finally {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
  }
});

app.listen(PORT, () => {
  console.log(`PrintForge Preflight running at http://localhost:${PORT}`);
});

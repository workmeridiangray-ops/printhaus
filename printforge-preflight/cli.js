#!/usr/bin/env node
const path = require('path');
const { runPipeline } = require('./src/pipeline');
const { CATEGORIES } = require('./src/formats');

async function main() {
  const [inputImage, categorySlash, outDir] = process.argv.slice(2);
  if (!inputImage || !categorySlash) {
    console.log('Usage: node cli.js <image-path> <category/size> [outDir]');
    console.log('\nAvailable category/size keys:');
    for (const cat of CATEGORIES) {
      for (const s of cat.sizes) console.log(`  ${cat.key}/${s.key}  (${cat.label} — ${s.label})`);
    }
    process.exit(1);
  }
  const [category, size] = categorySlash.split('/');

  const workDir = outDir || path.join(__dirname, 'test-output', `job-${Date.now()}`);
  const result = await runPipeline({
    inputImagePath: path.resolve(inputImage),
    category,
    size,
    workDir,
    title: `PrintForge ${categorySlash}`,
  });

  console.log('\n=== PrintForge Preflight — AI Image to Press-Ready PDF ===\n');
  console.log(`Format:        ${result.format.label} (${result.format.trimWidthMm}x${result.format.trimHeightMm}mm, ${result.format.bleedMm}mm bleed)`);
  console.log(`Colour profile:${result.profileUsed.label} (${result.profileUsed.standard})${result.profileUsed.real ? '' : ' [fallback: real profile not bundled yet]'}`);
  console.log(`Source image:  ${result.rasterInfo.sourceWidthPx}x${result.rasterInfo.sourceHeightPx}px`);
  console.log(`Upscaled to:   ${result.rasterInfo.widthPx}x${result.rasterInfo.heightPx}px @ ${result.rasterInfo.dpi} DPI (${result.rasterInfo.upscaleFactor.toFixed(2)}x)`);
  console.log(`Output file:   ${result.finalPdfPath}`);
  console.log(`\nPreflight: ${result.preflight.passed ? 'PASSED ✔' : 'FAILED ✘'}`);
  for (const c of result.preflight.checks) {
    console.log(`  [${c.passed ? 'PASS' : 'FAIL'}] ${c.name} — ${c.detail}`);
  }
}

main().catch((err) => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});

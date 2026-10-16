# PrintForge Preflight — AI Image → Press-Ready PDF/X-1a

A working MVP that replicates PrintGo.ai's core pipeline: drop in an AI-generated
image, pick a print format, and get back a verified, press-ready **PDF/X-1a:2001**
file — upscaled to 300 DPI, converted to real CMYK with the industry-standard
FOGRA39 profile, bled, and marked with crop marks — that any commercial print
shop's preflight should accept without a fight.

Confirmed working end-to-end on this build: `pdfinfo` independently reports
`PDF subtype: PDF/X-1a:2001`, ISO 15930-1, CMYK color, PDF v1.3, single page,
no encryption.

## How it works

```
cli.js / server (you add)
  └─ src/pipeline.js        orchestrates all four steps below

1. src/prepare-image.js    upscale + extend image to fill trim+bleed at 300 DPI
2. src/make-pdf.js          build a PDF: image + crop marks + real TrimBox/BleedBox
3. src/pdfx-convert.js      Ghostscript: force CMYK, embed FOGRA39 ICC, tag PDF/X-1a
4. src/preflight.js         verify the result before it's ever handed to a user
```

### 1. Image prep (`prepare-image.js`)
Resizes/crops the source image to exactly fill the trim+bleed canvas at 300 DPI,
using `sharp`'s lanczos3 kernel (sharpest non-AI upscaler available). This is the
step to swap in a real AI upscaler (Real-ESRGAN / Replicate / ClipDrop API) later
for genuinely AI-upscaled results instead of a high-quality resample.

### 2. PDF build (`make-pdf.js`)
Builds a single-page PDF sized to trim+bleed, draws the image full-bleed, adds
four 0.25pt registration crop marks (3mm long, 0.5mm offset from the trim line —
matches PrintGo's published spec), and sets **real** `TrimBox`/`BleedBox` PDF
dictionary entries (not just visual guides — this is what a press's RIP actually
reads to know where to cut).

### 3. CMYK + PDF/X-1a conversion (`pdfx-convert.js`)
Runs the draft through Ghostscript with `-dPDFX`, forcing `DeviceCMYK` and
embedding the bundled `profiles/FOGRA39.icc` (FOGRA39L coated — the standard
European/international commercial-offset profile) as the file's OutputIntent.
This is what makes the file an *actual* PDF/X-1a file, not just a PDF that
happens to look right.

### 4. Preflight verification (`preflight.js`)
Runs 9 checks against the finished file before it's released — page count, page
size vs. trim+bleed, PDF version, encryption, font embedding, **total ink
coverage (TAC, via Ghostscript's inkcov device, capped at 300%)**, PDF/X tagging,
and DPI. This caught a real problem in testing: a saturated test gradient came
back at 305% TAC and correctly failed — proving the check isn't just decorative.

## Requirements

- Node.js 18+ (tested on 22)
- **Ghostscript** (`apt install ghostscript` — this is the only non-npm
  dependency; it does the CMYK conversion and PDF/X tagging)
- `poppler-utils` (`pdfinfo`, `pdffonts`) — used only by the preflight checker
- npm packages: `sharp`, `pdf-lib` (see `package.json`)

## Try it

```bash
npm install
node cli.js path/to/your-image.png a4-flyer
# or: a5-flyer, a3-poster, dl-leaflet, postcard-a6, business-card
```

Output lands in `test-output/job-<timestamp>/printforge-<format>.pdf`, plus a
console preflight report.

## Adding more formats

Edit `src/formats.js` — it's just trim size (mm) + bleed (mm) per key. Pricing,
product names, etc. live wherever you wire this into Print Haus's product catalog.

## Web UI + API (`server.js`)

A working Express server is now included:

```bash
npm install
node server.js
# open http://localhost:3000
```

- `GET /` — drag-and-drop upload page with a format picker and a live preflight
  report (pass/fail per check, same checks `cli.js` prints)
- `GET /api/formats` — JSON list of print format presets
- `POST /api/convert` — multipart upload (`image`, `format`) → runs the full
  pipeline → returns JSON with the preflight report and a `downloadUrl`
- Finished PDFs are served statically from `/jobs/<jobId>/...`

Tested end-to-end over real HTTP (not just the CLI): uploaded an image via
`curl -F`, got back a 200 with a passing preflight report, downloaded the file
from the returned URL, and re-verified it independently with `pdfinfo` —
confirmed `PDF subtype: PDF/X-1a:2001` on the file that came back over the wire.

**Note on deployment:** this needs a real Node server/container (a VM, Render,
Railway, Fly.io, or a Droplet) — not pure Cloudflare Workers, because Ghostscript
is a native Linux binary Workers can't run. If you want to keep everything on
Cloudflare, run this piece as a small container (Cloudflare Containers, or any
Docker host) and have your existing Worker call it as a separate service.

## Tools (PrintGo Starter-tier feature set)

Five standalone tools, each with its own endpoint and a "Tools" tab in the UI —
independent of the main PDF pipeline:

| Tool | Endpoint | How |
|---|---|---|
| **Image Upscaler (2x/4x)** | `POST /api/tools/upscale` | Real learned super-resolution via OpenCV's `dnn_superres` + a pretrained ESPCN model (not a stretch) — also auto-runs inside the main pipeline whenever a source image is well under the target DPI |
| **Background Remover** | `POST /api/tools/remove-bg` | `rembg` (U²-Net salient object segmentation), outputs transparent PNG |
| **AI Vectorizer** | `POST /api/tools/vectorize` | Palette-quantizes the image, traces each colour separately with `potrace`, layers the results into one multi-colour SVG + PNG preview |
| **DTF Halftone** | `POST /api/tools/dtf` | Ordered (Bayer) dither halftone-screens the artwork into a colour film layer + generates a white underbase layer from the alpha mask |
| **Sticker Cut-Out** | `POST /api/tools/sticker-cutline` | Traces the artwork's alpha-channel silhouette, dilates it outward by the chosen offset, outputs a plotter-ready `CutContour` SVG |

System dependencies added for these: `potrace`, `librsvg2-bin` (apt), and
`rembg`, `opencv-contrib-python-headless`, `numpy` (pip — `pip3 install
--break-system-packages rembg opencv-contrib-python-headless numpy`). The
ESPCN model files (`models/ESPCN_x2.pb`, `models/ESPCN_x4.pb`, ~90KB each)
are bundled in this zip.

## Also added

- **Double-sided / multipage PDFs**: `/api/convert` now accepts an optional
  second file field (`backImage`) and produces a 2-page PDF (front, then
  back), each page with its own crop marks and TrimBox/BleedBox. `make-pdf.js`
  generally accepts an `imagePaths` array for N pages.

## What's NOT in this MVP yet (next steps)

- **No credit/billing system, no persistent file storage (R2/S3), no job queue.**
- **TAC checks flag but don't auto-fix** over-inked files — a real product
  would offer to apply ink limiting (GCR/UCR) automatically rather than
  just rejecting the file. (Known borderline case in current testing: a
  busy image occasionally lands at 301% TAC, just over the 300% cap.)
- **Vectorizer** uses palette quantization + per-colour potrace tracing —
  good for flat logos/illustrations, not a substitute for a true
  gradient-aware vectorizer on photographic source images.
- **DTF halftone** uses standard ordered (Bayer) dithering — a production
  DTF/RIP workflow would let you tune screen angle/frequency per channel.

## Files

```
src/
  formats.js         print format presets (trim size, bleed)
  prepare-image.js    image upscale/extend step
  make-pdf.js          PDF build + crop marks + TrimBox/BleedBox
  pdfx-convert.js      Ghostscript CMYK + PDF/X-1a conversion
  preflight.js         9-point verification
  pipeline.js          orchestrates all of the above
cli.js                 command-line entry point
profiles/FOGRA39.icc    bundled CMYK press profile (FOGRA39L coated)
test-input/             sample test images
```

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { createCanvas } = require('@napi-rs/canvas');

const HANDBOOK_PAGES_DIR = process.env.HANDBOOK_PAGES_DIR
  || path.join(__dirname, '..', '..', 'data', 'handbook-pages');

const ensurePagesDir = (sourceId) => {
  const dir = path.join(HANDBOOK_PAGES_DIR, String(sourceId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const getPageImagePath = (sourceId, pageNumber) => (
  path.join(HANDBOOK_PAGES_DIR, String(sourceId), `page-${String(pageNumber).padStart(3, '0')}.jpg`)
);

const savePageImage = async (sourceId, pageNumber, imageBuffer) => {
  const filePath = getPageImagePath(sourceId, pageNumber);
  ensurePagesDir(sourceId);
  await fs.promises.writeFile(filePath, imageBuffer);
  return filePath;
};

const loadPageImage = async (sourceId, pageNumber) => {
  const filePath = getPageImagePath(sourceId, pageNumber);
  if (!fs.existsSync(filePath)) return null;
  return fs.promises.readFile(filePath);
};

const renderPdfPageToJpeg = async (pdfBuffer, pageNumber, scale = 2) => {
  const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');

  pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
    path.join(pdfjsRoot, 'legacy/build/pdf.worker.mjs')
  ).href;

  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    useSystemFonts: true,
    standardFontDataUrl: path.join(pdfjsRoot, 'standard_fonts/'),
    disableFontFace: true,
  });

  const pdf = await loadingTask.promise;
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext('2d');

  await page.render({
    canvasContext: context,
    viewport,
  }).promise;

  return canvas.toBuffer('image/jpeg', 80);
};

module.exports = {
  HANDBOOK_PAGES_DIR,
  ensurePagesDir,
  getPageImagePath,
  savePageImage,
  loadPageImage,
  renderPdfPageToJpeg,
};

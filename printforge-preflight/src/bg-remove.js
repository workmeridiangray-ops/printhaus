const { execFile } = require('child_process');
const path = require('path');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'remove_bg.py');

/** Background remover (rembg / U^2-Net). Always outputs a transparent PNG. */
async function removeBackground({ inputPath, outputPath }) {
  return new Promise((resolve, reject) => {
    execFile('python3', [SCRIPT_PATH, inputPath, outputPath], { maxBuffer: 1024 * 1024 * 50, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`Background removal failed: ${stderr?.split('\n').pop() || err.message}`));
      resolve({ outputPath });
    });
  });
}

module.exports = { removeBackground };

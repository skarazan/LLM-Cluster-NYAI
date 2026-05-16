'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const { execSync } = require('child_process');
const { BIN_DIR, MODELS_DIR } = require('./configStore');

let activeDownloads = [];

// ── Platform detection ────────────────────────────────────────────────────────
function getPlatformAsset() {
  const platform = process.platform;
  const arch = os.arch();

  if (platform === 'win32') {
    // Check for NVIDIA GPU
    try {
      execSync('nvidia-smi', { encoding: 'utf8', timeout: 5000 });
      return { pattern: 'cuda-cu12', ext: '.zip', platform: 'win-cuda' };
    } catch {
      return { pattern: 'win-x64', ext: '.zip', platform: 'win-cpu' };
    }
  }

  if (platform === 'darwin') {
    if (arch === 'arm64') {
      return { pattern: 'macos-arm64', ext: '.tar.gz', platform: 'mac-arm' };
    }
    return { pattern: 'macos-x64', ext: '.tar.gz', platform: 'mac-x64' };
  }

  // Linux
  try {
    execSync('nvidia-smi', { encoding: 'utf8', timeout: 5000 });
    return { pattern: 'ubuntu-x64-cuda', ext: '.tar.gz', platform: 'linux-cuda' };
  } catch {
    return { pattern: 'ubuntu-x64', ext: '.tar.gz', platform: 'linux-cpu' };
  }
}

// ── HTTP download with progress + resume ─────────────────────────────────────
function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    let existingSize = 0;
    const headers = {};

    // Resume support
    if (fs.existsSync(destPath + '.partial')) {
      existingSize = fs.statSync(destPath + '.partial').size;
      headers.Range = `bytes=${existingSize}-`;
    }

    const controller = { aborted: false };
    activeDownloads.push(controller);

    function doRequest(reqUrl) {
      const proto = reqUrl.startsWith('https') ? https : http;
      const req = proto.get(reqUrl, { headers }, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return doRequest(res.headers.location);
        }

        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} downloading ${reqUrl}`));
        }

        const totalBytes = existingSize + Number(res.headers['content-length'] || 0);
        let downloadedBytes = existingSize;

        const writeStream = fs.createWriteStream(destPath + '.partial', {
          flags: existingSize > 0 ? 'a' : 'w',
        });

        res.on('data', (chunk) => {
          if (controller.aborted) {
            res.destroy();
            writeStream.close();
            return;
          }
          downloadedBytes += chunk.length;
          writeStream.write(chunk);
          if (onProgress) {
            onProgress({
              downloaded: downloadedBytes,
              total: totalBytes,
              percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
              speed: 0, // TODO: calculate rolling speed
            });
          }
        });

        res.on('end', () => {
          writeStream.close(() => {
            if (controller.aborted) return reject(new Error('Cancelled'));
            fs.renameSync(destPath + '.partial', destPath);
            resolve(destPath);
          });
        });

        res.on('error', (err) => {
          writeStream.close();
          reject(err);
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Download timeout')); });
      req.setTimeout(30000);
    }

    doRequest(url);
  });
}

// ── Download llama-server binary ─────────────────────────────────────────────
async function downloadLlamaServer(opts = {}, onProgress) {
  const asset = getPlatformAsset();

  // Get latest release from llama.cpp GitHub
  const releaseUrl = 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest';
  const releaseData = await fetchJSON(releaseUrl);

  // Find matching asset
  const match = releaseData.assets?.find(a =>
    a.name.toLowerCase().includes(asset.pattern.toLowerCase())
  );

  if (!match) {
    throw new Error(`No llama-server binary found for platform: ${asset.platform}. Assets available: ${
      (releaseData.assets || []).map(a => a.name).join(', ')
    }`);
  }

  const downloadUrl = match.browser_download_url;
  const filename = match.name;
  const archivePath = path.join(BIN_DIR, filename);

  if (onProgress) onProgress({ status: 'downloading', filename, total: match.size });

  await downloadFile(downloadUrl, archivePath, onProgress);

  // Extract
  if (onProgress) onProgress({ status: 'extracting', filename });
  const extractedDir = await extractArchive(archivePath, BIN_DIR);

  // Find llama-server binary in extracted files
  const serverBin = findBinary(BIN_DIR, 'llama-server');
  if (!serverBin) {
    throw new Error('Could not find llama-server binary after extraction');
  }

  // Make executable on Unix
  if (process.platform !== 'win32') {
    fs.chmodSync(serverBin, 0o755);
  }

  return { path: serverBin, version: releaseData.tag_name };
}

// ── Download model GGUF ──────────────────────────────────────────────────────
async function downloadModel(model, onProgress) {
  const url = `https://huggingface.co/${model.hfRepo}/resolve/main/${model.hfFile}`;
  const destPath = path.join(MODELS_DIR, model.hfFile);

  // Check if already downloaded
  if (fs.existsSync(destPath)) {
    const stat = fs.statSync(destPath);
    const expectedBytes = model.fileSizeGB * 1024 * 1024 * 1024;
    // Allow 5% tolerance
    if (stat.size > expectedBytes * 0.9) {
      return { path: destPath, alreadyExists: true };
    }
  }

  await downloadFile(url, destPath, onProgress);
  return { path: destPath, alreadyExists: false };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
async function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'LLM-Cluster-Worker-App' },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return fetchJSON(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON from ' + url)); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function extractArchive(archivePath, destDir) {
  const { execSync } = require('child_process');
  const ext = path.extname(archivePath).toLowerCase();

  if (process.platform === 'win32' && archivePath.endsWith('.zip')) {
    // Use PowerShell to extract on Windows
    execSync(
      `powershell -command "Expand-Archive -Force -Path '${archivePath}' -DestinationPath '${destDir}'"`,
      { timeout: 120000 }
    );
  } else if (archivePath.endsWith('.tar.gz') || archivePath.endsWith('.tgz')) {
    execSync(`tar xzf "${archivePath}" -C "${destDir}"`, { timeout: 120000 });
  } else if (archivePath.endsWith('.zip')) {
    execSync(`unzip -o "${archivePath}" -d "${destDir}"`, { timeout: 120000 });
  }

  return destDir;
}

function findBinary(dir, name) {
  const isWin = process.platform === 'win32';
  const target = isWin ? `${name}.exe` : name;

  function search(searchDir) {
    try {
      const entries = fs.readdirSync(searchDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(searchDir, entry.name);
        if (entry.isFile() && entry.name === target) return fullPath;
        if (entry.isDirectory()) {
          const found = search(fullPath);
          if (found) return found;
        }
      }
    } catch { /* skip permission errors */ }
    return null;
  }

  return search(dir);
}

function cancelAll() {
  for (const ctrl of activeDownloads) ctrl.aborted = true;
  activeDownloads = [];
}

module.exports = { downloadLlamaServer, downloadModel, cancelAll, getPlatformAsset };

'use strict';

const { execSync } = require('child_process');
const os = require('os');
const bandwidthTable = require('./gpuBandwidthTable');

/**
 * Detect GPU(s) on the system.
 * Returns { found: boolean, gpus: [...], cpuFallback: boolean }
 */
function detect() {
  const platform = process.platform;

  // Try NVIDIA first (works on Windows + Linux)
  try {
    const raw = execSync(
      'nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader,nounits',
      { encoding: 'utf8', timeout: 10000 }
    ).trim();

    if (raw) {
      const gpus = raw.split('\n').map(line => {
        const [name, vramMB, driver, computeCap] = line.split(',').map(s => s.trim());
        const vram = Math.round(Number(vramMB) / 1024); // MB → GB
        const bandwidth = bandwidthTable.lookup(name);
        return { name, vram, vramMB: Number(vramMB), driver, computeCap, bandwidth };
      });
      return { found: true, gpus, cpuFallback: false };
    }
  } catch {
    // nvidia-smi not found or no NVIDIA GPU
  }

  // macOS: check for Apple Silicon GPU
  if (platform === 'darwin') {
    try {
      const raw = execSync('system_profiler SPDisplaysDataType -json', {
        encoding: 'utf8', timeout: 10000,
      });
      const data = JSON.parse(raw);
      const displays = data.SPDisplaysDataType || [];
      const gpus = [];

      for (const item of displays) {
        const name = item.sppci_model || 'Unknown GPU';
        // Apple Silicon: unified memory, detect total RAM
        const isAppleSilicon = os.arch() === 'arm64';
        if (isAppleSilicon) {
          const totalRAM = Math.round(os.totalmem() / (1024 ** 3));
          // Apple Silicon shares RAM; usable VRAM is roughly 75% of total
          const vram = Math.round(totalRAM * 0.75);
          const bandwidth = bandwidthTable.lookup(name);
          gpus.push({
            name: name.includes('Apple') ? name : `Apple ${name}`,
            vram,
            vramMB: vram * 1024,
            driver: 'Metal',
            computeCap: 'Apple Silicon',
            bandwidth,
            unified: true,
            totalRAM,
          });
        } else {
          // Intel Mac with discrete GPU
          const vramStr = item.spdisplays_vram || item['sppci_vram'] || '0';
          const vramMatch = vramStr.match(/(\d+)/);
          const vramMB = vramMatch ? Number(vramMatch[1]) : 0;
          gpus.push({
            name,
            vram: Math.round(vramMB / 1024),
            vramMB,
            driver: 'Metal',
            computeCap: 'N/A',
            bandwidth: bandwidthTable.lookup(name),
          });
        }
      }

      if (gpus.length > 0) {
        return { found: true, gpus, cpuFallback: false };
      }
    } catch {
      // system_profiler failed
    }
  }

  // CPU fallback
  const cpus = os.cpus();
  return {
    found: false,
    gpus: [],
    cpuFallback: true,
    cpu: {
      model: cpus[0]?.model || 'Unknown',
      cores: cpus.length,
      ram: Math.round(os.totalmem() / (1024 ** 3)),
    },
  };
}

module.exports = { detect };

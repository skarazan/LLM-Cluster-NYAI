'use strict';

const { exec } = require('child_process');
const os = require('os');
const bandwidthTable = require('./gpuBandwidthTable');

// Async exec helper — never blocks the main process event loop
function run(cmd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      if (err) resolve(null);
      else resolve(stdout.trim());
    });
  });
}

async function detect() {
  const platform = process.platform;
  console.log('[gpu-detect] Starting detection, platform:', platform);

  // ── NVIDIA (Windows + Linux) ──────────────────────────────────────────────
  const nvRaw = await run(
    'nvidia-smi --query-gpu=name,memory.total,driver_version,compute_cap --format=csv,noheader,nounits'
  );

  if (nvRaw) {
    console.log('[gpu-detect] nvidia-smi output:', nvRaw);
    const gpus = nvRaw.split('\n').filter(Boolean).map(line => {
      const [name, vramMB, driver, computeCap] = line.split(',').map(s => s.trim());
      const vram = Math.round(Number(vramMB) / 1024);
      const bandwidth = bandwidthTable.lookup(name);
      return { name, vram, vramMB: Number(vramMB), driver, computeCap, bandwidth };
    });
    console.log('[gpu-detect] Found NVIDIA GPUs:', gpus.length);
    return { found: true, gpus, cpuFallback: false };
  }

  console.log('[gpu-detect] No NVIDIA GPU found, trying macOS...');

  // ── macOS ─────────────────────────────────────────────────────────────────
  if (platform === 'darwin') {
    const isAppleSilicon = os.arch() === 'arm64';

    if (isAppleSilicon) {
      // Apple Silicon — skip system_profiler JSON (slow), use os module directly
      const totalRAM = Math.round(os.totalmem() / (1024 ** 3));
      const vram = Math.round(totalRAM * 0.75);

      // Try to get chip name from sysctl (fast, < 100ms)
      const chipRaw = await run('sysctl -n machdep.cpu.brand_string', 2000)
        || await run('sysctl -n hw.model', 2000)
        || '';

      // Map hw.model (e.g. "Mac14,3") to chip name via marketing name lookup
      const gpuName = resolveAppleSiliconName(chipRaw, totalRAM);
      const bandwidth = bandwidthTable.lookup(gpuName);

      console.log('[gpu-detect] Apple Silicon:', gpuName, vram + 'GB usable VRAM');
      return {
        found: true,
        gpus: [{ name: gpuName, vram, vramMB: vram * 1024, driver: 'Metal', computeCap: 'Apple Silicon', bandwidth, unified: true, totalRAM }],
        cpuFallback: false,
      };
    }

    // Intel Mac — use system_profiler but with timeout
    const spRaw = await run('system_profiler SPDisplaysDataType -json', 10000);
    if (spRaw) {
      try {
        const data = JSON.parse(spRaw);
        const displays = data.SPDisplaysDataType || [];
        const gpus = displays.map(item => {
          const name = item.sppci_model || 'Unknown GPU';
          const vramStr = item.spdisplays_vram || item['sppci_vram'] || '0';
          const vramMatch = vramStr.match(/(\d+)/);
          const vramMB = vramMatch ? Number(vramMatch[1]) : 0;
          return { name, vram: Math.round(vramMB / 1024), vramMB, driver: 'Metal', computeCap: 'N/A', bandwidth: bandwidthTable.lookup(name) };
        }).filter(g => g.vram > 0);

        if (gpus.length > 0) {
          console.log('[gpu-detect] Intel Mac GPU:', gpus[0].name);
          return { found: true, gpus, cpuFallback: false };
        }
      } catch (e) {
        console.warn('[gpu-detect] system_profiler parse error:', e.message);
      }
    }
  }

  // ── CPU fallback ──────────────────────────────────────────────────────────
  const cpus = os.cpus();
  console.log('[gpu-detect] No GPU found, using CPU fallback');
  return {
    found: false,
    gpus: [],
    cpuFallback: true,
    cpu: { model: cpus[0]?.model || 'Unknown', cores: cpus.length, ram: Math.round(os.totalmem() / (1024 ** 3)) },
  };
}

// Apple Silicon chip name from sysctl output or RAM size heuristic
function resolveAppleSiliconName(raw, totalRAM) {
  const r = (raw || '').toLowerCase();
  if (r.includes('m4')) {
    if (totalRAM >= 192) return 'Apple M4 Ultra';
    if (totalRAM >= 128) return 'Apple M4 Ultra';
    if (totalRAM >= 64)  return 'Apple M4 Max';
    if (totalRAM >= 24)  return 'Apple M4 Pro';
    return 'Apple M4';
  }
  if (r.includes('m3')) {
    if (totalRAM >= 192) return 'Apple M3 Ultra';
    if (totalRAM >= 64)  return 'Apple M3 Max';
    if (totalRAM >= 18)  return 'Apple M3 Pro';
    return 'Apple M3';
  }
  if (r.includes('m2')) {
    if (totalRAM >= 192) return 'Apple M2 Ultra';
    if (totalRAM >= 64)  return 'Apple M2 Max';
    if (totalRAM >= 16)  return 'Apple M2 Pro';
    return 'Apple M2';
  }
  if (r.includes('m1')) {
    if (totalRAM >= 128) return 'Apple M1 Ultra';
    if (totalRAM >= 32)  return 'Apple M1 Max';
    if (totalRAM >= 16)  return 'Apple M1 Pro';
    return 'Apple M1';
  }
  // Unknown Apple Silicon — guess from RAM
  if (totalRAM >= 64)  return 'Apple M4 Max';
  if (totalRAM >= 24)  return 'Apple M4 Pro';
  return 'Apple M4';
}

module.exports = { detect };

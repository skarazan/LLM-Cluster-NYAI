'use strict';

window.GpuCard = {
  render(container, gpuInfo) {
    if (!gpuInfo) {
      container.innerHTML = '<div class="gpu-card"><span class="gpu-icon">⏳</span><div><div class="gpu-name">Detecting GPU...</div></div></div>';
      return;
    }

    if (gpuInfo.cpuFallback) {
      container.innerHTML = `
        <div class="gpu-card" style="border-color: var(--yellow);">
          <span class="gpu-icon">💻</span>
          <div>
            <div class="gpu-name">No GPU Detected — CPU Only</div>
            <div class="gpu-detail">${gpuInfo.cpu?.model || 'Unknown CPU'} · ${gpuInfo.cpu?.cores || '?'} cores · ${gpuInfo.cpu?.ram || '?'} GB RAM</div>
            <div class="gpu-detail" style="color: var(--yellow); margin-top: 4px;">
              Small models will work but expect slow speeds. A GPU is strongly recommended.
            </div>
          </div>
        </div>`;
      return;
    }

    const html = gpuInfo.gpus.map(gpu => `
      <div class="gpu-card" style="border-color: var(--green);">
        <span class="gpu-icon">🎮</span>
        <div>
          <div class="gpu-name">${gpu.name}</div>
          <div class="gpu-detail">
            ${gpu.vram} GB VRAM · Driver ${gpu.driver || 'N/A'}
            ${gpu.bandwidth ? ` · ${gpu.bandwidth} GB/s bandwidth` : ''}
            ${gpu.unified ? ' · Unified Memory' : ''}
          </div>
          ${gpu.computeCap && gpu.computeCap !== 'N/A' ? `<div class="gpu-detail">Compute: ${gpu.computeCap}</div>` : ''}
        </div>
      </div>
    `).join('');

    container.innerHTML = html;
  }
};

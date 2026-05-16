'use strict';

window.StatsCards = {
  render(container, stats) {
    const items = [
      { label: 'Status', value: stats.status || 'Stopped', color: stats.status === 'running' ? 'var(--green)' : 'var(--text-dim)' },
      { label: 'tok/s', value: stats.tokPerSec || '—', unit: 'tok/s' },
      { label: 'VRAM Used', value: stats.vramUsed || '—', unit: 'GB' },
      { label: 'Jobs Done', value: stats.jobCount ?? 0, unit: '' },
      { label: 'Uptime', value: formatUptime(stats.uptime || 0), unit: '' },
      { label: 'Context', value: stats.contextSize ? `${Math.round(stats.contextSize / 1024)}K` : '—', unit: '' },
    ];

    container.innerHTML = `<div class="stats-row">${items.map(i => `
      <div class="stat-card">
        <div class="stat-label">${i.label}</div>
        <div class="stat-value" ${i.color ? `style="color: ${i.color}"` : ''}>
          ${i.value}<span class="stat-unit">${i.unit || ''}</span>
        </div>
      </div>
    `).join('')}</div>`;
  }
};

function formatUptime(seconds) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds/60)}m ${seconds%60}s`;
  const h = Math.floor(seconds/3600);
  const m = Math.floor((seconds%3600)/60);
  return `${h}h ${m}m`;
}

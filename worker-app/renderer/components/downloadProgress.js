'use strict';

window.DownloadProgress = {
  render(container, downloads) {
    // downloads = [{ label, percent, downloaded, total, status, speed }]
    const html = downloads.map(d => {
      const pct = d.percent || 0;
      const doneClass = pct >= 100 ? 'done' : '';
      const downloadedMB = d.downloaded ? (d.downloaded / (1024*1024)).toFixed(0) : '0';
      const totalMB = d.total ? (d.total / (1024*1024)).toFixed(0) : '?';
      const statusText = d.status === 'extracting'
        ? 'Extracting...'
        : d.status === 'done'
          ? 'Done!'
          : `${downloadedMB} / ${totalMB} MB — ${pct}%`;

      return `
        <div style="margin-bottom: 16px;">
          <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
            <span style="font-size: 13px; font-weight: 600;">${d.label}</span>
            <span style="font-size: 12px; color: var(--text-dim);">${statusText}</span>
          </div>
          <div class="progress-bar">
            <div class="progress-fill ${doneClass}" style="width: ${pct}%;"></div>
          </div>
        </div>`;
    }).join('');

    container.innerHTML = html;
  }
};

'use strict';

window.ModelBrowser = {
  selectedModel: null,

  render(container, models, opts = {}) {
    const turboQuant = opts.turboQuant || false;

    let html = `
      <div style="overflow-x: auto;">
        <table class="model-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Params</th>
              <th>Size</th>
              <th>VRAM</th>
              <th>Context</th>
              <th>Est. tok/s</th>
              <th>Fit</th>
            </tr>
          </thead>
          <tbody>`;

    for (const m of models) {
      const selected = this.selectedModel === m.name ? 'selected' : '';
      const contextLabel = m.contextFitsLabel
        ? `${m.contextFitsLabel}${turboQuant ? ' ⚡' : ''}`
        : '—';

      html += `
            <tr class="${selected}" data-model="${m.name}">
              <td>
                <div class="model-name">${m.name}</div>
                <div class="model-usecase">${m.useCase}</div>
              </td>
              <td>${m.params}</td>
              <td>${m.fileSizeGB} GB</td>
              <td>${m.vramGB} GB</td>
              <td>${contextLabel}</td>
              <td>${m.estimatedTokS ? `~${m.estimatedTokS}` : '—'}</td>
              <td><span class="fit-badge fit-${m.fit}">${m.fitLabel}</span></td>
            </tr>`;
    }

    html += `
          </tbody>
        </table>
      </div>`;

    container.innerHTML = html;

    // Click handler for model selection
    container.querySelectorAll('tr[data-model]').forEach(row => {
      row.addEventListener('click', () => {
        this.selectedModel = row.dataset.model;
        container.querySelectorAll('tr').forEach(r => r.classList.remove('selected'));
        row.classList.add('selected');
        if (opts.onSelect) opts.onSelect(this.selectedModel);
      });
    });
  }
};

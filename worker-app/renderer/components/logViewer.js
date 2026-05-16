'use strict';

window.LogViewer = {
  maxLines: 500,
  logs: { llama: [], worker: [], errors: [] },
  activeTab: 'llama',
  filterText: '',

  addLine(source, line) {
    const entry = { text: line, time: new Date().toLocaleTimeString(), source };
    this.logs[source]?.push(entry);

    // Detect errors → copy to errors tab
    if (/error|fail|exception|GGML_ASSERT/i.test(line)) {
      this.logs.errors.push(entry);
    }

    // Trim
    for (const key of Object.keys(this.logs)) {
      if (this.logs[key].length > this.maxLines) {
        this.logs[key] = this.logs[key].slice(-this.maxLines);
      }
    }
  },

  render(container) {
    const tabs = [
      { id: 'llama', label: 'llama-server' },
      { id: 'worker', label: 'Worker' },
      { id: 'errors', label: `Errors (${this.logs.errors.length})` },
    ];

    container.innerHTML = `
      <div class="log-viewer">
        <div class="log-tabs">
          ${tabs.map(t => `
            <button class="log-tab ${t.id === this.activeTab ? 'active' : ''}" data-tab="${t.id}">
              ${t.label}
            </button>
          `).join('')}
          <div style="flex:1;"></div>
          <input class="input" style="width: 160px; font-size: 12px; margin: 4px 8px; padding: 4px 8px;"
                 placeholder="Filter..." value="${this.filterText}" id="log-filter">
        </div>
        <div class="log-content" id="log-content"></div>
      </div>`;

    this._renderContent();

    container.querySelectorAll('.log-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.activeTab = btn.dataset.tab;
        this.render(container);
      });
    });

    const filterInput = container.querySelector('#log-filter');
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        this.filterText = filterInput.value;
        this._renderContent();
      });
    }
  },

  _renderContent() {
    const el = document.getElementById('log-content');
    if (!el) return;

    let lines = this.logs[this.activeTab] || [];
    if (this.filterText) {
      const lower = this.filterText.toLowerCase();
      lines = lines.filter(l => l.text.toLowerCase().includes(lower));
    }

    el.innerHTML = lines.map(l => {
      let cls = '';
      if (/error|fail|exception/i.test(l.text)) cls = 'log-line-error';
      else if (/warn/i.test(l.text)) cls = 'log-line-warn';
      else if (/ready|registered|success/i.test(l.text)) cls = 'log-line-info';
      return `<div class="${cls}"><span style="color: var(--text-dim);">[${l.time}]</span> ${escapeHtml(l.text)}</div>`;
    }).join('');

    // Auto-scroll to bottom
    el.scrollTop = el.scrollHeight;
  },

  clear(source) {
    if (source) {
      this.logs[source] = [];
    } else {
      this.logs = { llama: [], worker: [], errors: [] };
    }
  }
};

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

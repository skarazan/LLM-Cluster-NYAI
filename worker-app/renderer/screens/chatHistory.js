'use strict';

const { ipcRenderer: ipcH } = require('electron');

window.ChatHistory = {
  authenticated: false,
  conversations: [],
  selectedConv: null,

  init(container) {
    this.container = container;
    this.render();
  },

  render() {
    if (!this.authenticated) {
      this.renderGate();
    } else if (this.selectedConv) {
      this.renderConversation();
    } else {
      this.renderList();
    }
  },

  renderGate() {
    this.container.innerHTML = `
      <div class="history-gate">
        <h2>🔒 Chat History</h2>
        <p style="color: var(--text-dim); font-size: 13px;">Enter password to view chat history.</p>
        <input class="input" type="password" id="history-pass" placeholder="Password">
        <button class="btn btn-primary" id="history-login">Unlock</button>
        <div id="history-error" style="color: var(--red); font-size: 13px;"></div>
      </div>`;

    const passInput = this.container.querySelector('#history-pass');
    const loginBtn = this.container.querySelector('#history-login');
    const errorEl = this.container.querySelector('#history-error');

    const doLogin = async () => {
      const ok = await ipcH.invoke('history:auth', passInput.value);
      if (ok) {
        this.authenticated = true;
        this.conversations = await ipcH.invoke('history:list');
        this.render();
      } else {
        errorEl.textContent = 'Wrong password.';
        passInput.value = '';
      }
    };

    loginBtn.addEventListener('click', doLogin);
    passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  },

  renderList() {
    const convHtml = this.conversations.length === 0
      ? '<p style="color: var(--text-dim); text-align: center; margin-top: 40px;">No conversations yet.</p>'
      : this.conversations.map(c => `
          <div class="conv-item" data-id="${c.id}">
            <span class="conv-time">${new Date(c.timestamp).toLocaleString()}</span>
            <span class="conv-preview">${escapeH(c.preview || 'No preview')}</span>
            <span class="conv-model">${c.model}</span>
            <span style="color: var(--text-dim); font-size: 12px;">${c.messageCount} msgs</span>
          </div>
        `).join('');

    this.container.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h2>💬 Chat History</h2>
        <button class="btn btn-secondary" id="history-refresh">Refresh</button>
      </div>
      <div class="conv-list">${convHtml}</div>`;

    this.container.querySelectorAll('.conv-item').forEach(item => {
      item.addEventListener('click', async () => {
        this.selectedConv = await ipcH.invoke('history:get', item.dataset.id);
        this.render();
      });
    });

    this.container.querySelector('#history-refresh').addEventListener('click', async () => {
      this.conversations = await ipcH.invoke('history:list');
      this.render();
    });
  },

  renderConversation() {
    const msgs = (this.selectedConv?.messages || []).map(m => {
      const isUser = m.role === 'user';
      return `
        <div style="max-width: 80%; align-self: ${isUser ? 'flex-end' : 'flex-start'};
                    background: ${isUser ? 'var(--accent)' : 'var(--bg-hover)'};
                    color: ${isUser ? 'var(--bg-dark)' : 'var(--text)'};
                    padding: 10px 14px; border-radius: 12px; word-wrap: break-word; white-space: pre-wrap;">
          ${escapeH(m.content || '')}
        </div>`;
    }).join('');

    this.container.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
        <button class="btn btn-secondary" id="conv-back">← Back</button>
        <h3 style="flex: 1;">Conversation</h3>
        <span style="color: var(--text-dim); font-size: 12px;">${new Date(this.selectedConv.timestamp).toLocaleString()}</span>
        <span class="conv-model">${this.selectedConv.model}</span>
      </div>
      <div style="display: flex; flex-direction: column; gap: 12px; flex: 1; overflow-y: auto;">
        ${msgs}
      </div>`;

    this.container.querySelector('#conv-back').addEventListener('click', () => {
      this.selectedConv = null;
      this.render();
    });
  },
};

function escapeH(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

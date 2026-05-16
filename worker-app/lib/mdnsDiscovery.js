'use strict';

/**
 * Discover LLM Cluster managers via mDNS (Bonjour).
 * Returns array of { url, name } objects.
 */
async function discover(timeoutMs = 3000) {
  try {
    const { Bonjour } = require('bonjour-service');
    const b = new Bonjour();

    const found = await new Promise((resolve) => {
      const list = [];
      const browser = b.find({ type: 'llmcluster' }, (svc) => {
        const addr = (svc.addresses || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
        if (addr) {
          list.push({
            url: `http://${addr}:${svc.port}`,
            name: svc.name || addr,
          });
        }
      });
      setTimeout(() => {
        browser.stop();
        b.destroy();
        resolve(list);
      }, timeoutMs);
    });

    return found;
  } catch {
    // bonjour not available
    return [];
  }
}

module.exports = { discover };

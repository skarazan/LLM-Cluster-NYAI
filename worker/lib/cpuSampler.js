'use strict';

const os = require('os');

let lastSample = os.cpus();

function getCpuPct() {
  const current = os.cpus();
  let idle = 0, total = 0;
  for (let i = 0; i < current.length; i++) {
    const prev = lastSample[i] || current[i];
    const deltaIdle  = current[i].times.idle  - prev.times.idle;
    const deltaTotal = Object.values(current[i].times).reduce((a, b) => a + b, 0)
                     - Object.values(prev.times).reduce((a, b) => a + b, 0);
    idle  += deltaIdle;
    total += deltaTotal;
  }
  lastSample = current;
  if (total === 0) return 0;
  return Math.round((1 - idle / total) * 1000) / 10; // one decimal
}

module.exports = { getCpuPct };

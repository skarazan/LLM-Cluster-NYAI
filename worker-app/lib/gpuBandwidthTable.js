'use strict';

/**
 * GPU name → memory bandwidth (GB/s) lookup.
 * Used for tok/s estimation: estimated_toks = bandwidth / model_file_size_GB
 */
const TABLE = {
  // NVIDIA RTX 40-series
  'RTX 4090':       1008,
  'RTX 4080 SUPER':  736,
  'RTX 4080':        717,
  'RTX 4070 Ti SUPER': 672,
  'RTX 4070 Ti':     504,
  'RTX 4070 SUPER':  504,
  'RTX 4070':        504,
  'RTX 4060 Ti':     288,
  'RTX 4060':        272,

  // NVIDIA RTX 30-series
  'RTX 3090 Ti':     1008,
  'RTX 3090':        936,
  'RTX 3080 Ti':     912,
  'RTX 3080':        760,
  'RTX 3070 Ti':     608,
  'RTX 3070':        448,
  'RTX 3060 Ti':     448,
  'RTX 3060':        360,

  // NVIDIA RTX 20-series
  'RTX 2080 Ti':     616,
  'RTX 2080 SUPER':  496,
  'RTX 2080':        448,
  'RTX 2070 SUPER':  448,
  'RTX 2070':        448,
  'RTX 2060 SUPER':  448,
  'RTX 2060':        336,

  // NVIDIA GTX 16-series
  'GTX 1660 Ti':     288,
  'GTX 1660 SUPER':  336,
  'GTX 1660':        192,
  'GTX 1650 SUPER':  192,
  'GTX 1650':        128,

  // NVIDIA datacenter / workstation
  'A100':            2039,
  'A100 80GB':       2039,
  'A6000':           768,
  'A5000':           768,
  'A4000':           448,
  'H100':            3350,
  'H100 SXM':        3350,
  'L40':             864,
  'L40S':            864,
  'L4':              300,
  'T4':              300,
  'V100':            900,
  'P100':            732,

  // NVIDIA RTX 50-series (Blackwell consumer)
  'RTX 5090':        1792,
  'RTX 5080':        960,
  'RTX 5070 Ti':     896,
  'RTX 5070':        672,

  // Apple Silicon
  'Apple M1':        68,
  'Apple M1 Pro':    200,
  'Apple M1 Max':    400,
  'Apple M1 Ultra':  800,
  'Apple M2':        100,
  'Apple M2 Pro':    200,
  'Apple M2 Max':    400,
  'Apple M2 Ultra':  800,
  'Apple M3':        100,
  'Apple M3 Pro':    150,
  'Apple M3 Max':    400,
  'Apple M3 Ultra':  800,
  'Apple M4':        120,
  'Apple M4 Pro':    273,
  'Apple M4 Max':    546,
  'Apple M4 Ultra':  819,
};

/**
 * Fuzzy-match a GPU name to the bandwidth table.
 * Returns bandwidth in GB/s or null if unknown.
 */
function lookup(gpuName) {
  if (!gpuName) return null;
  const upper = gpuName.toUpperCase();

  // Exact match first
  for (const [key, bw] of Object.entries(TABLE)) {
    if (upper.includes(key.toUpperCase())) return bw;
  }

  return null;
}

module.exports = { TABLE, lookup };

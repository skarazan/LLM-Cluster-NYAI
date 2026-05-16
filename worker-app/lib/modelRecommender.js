'use strict';

const { MODELS } = require('./modelCatalog');

/**
 * Recommend models based on detected GPU info.
 * Returns models with fit status and estimated tok/s.
 *
 * @param {Object} gpuInfo - { vram: number (GB), bandwidth: number|null (GB/s) }
 * @param {Object} opts - { turboQuant: boolean }
 */
function recommend(gpuInfo, opts = {}) {
  const vram = gpuInfo?.vram || 0;
  const bandwidth = gpuInfo?.bandwidth || null;
  const turboQuant = opts.turboQuant || false;

  return MODELS.map(model => {
    // Fit assessment
    const vramFree = vram - model.vramGB;
    let fit, fitLabel;

    if (vramFree >= 2) {
      fit = 'green';
      fitLabel = 'Fits well';
    } else if (vramFree >= 0) {
      fit = 'yellow';
      fitLabel = 'Tight fit';
    } else {
      fit = 'red';
      fitLabel = 'Won\'t fit';
    }

    // tok/s estimate
    let estimatedTokS = null;
    if (bandwidth && model.fileSizeGB > 0) {
      estimatedTokS = Math.round(bandwidth / model.fileSizeGB);
    }

    // Context size that fits in remaining VRAM
    let contextFits = 0;
    if (vramFree > 0 && model.contextVRAMperK > 0) {
      const contextVRAMperK = turboQuant ? model.contextVRAMperK * 0.6 : model.contextVRAMperK;
      contextFits = Math.min(
        Math.floor(vramFree / contextVRAMperK) * 1024,
        model.maxContext
      );
    }

    // Clamp to at least 2048 if model fits at all
    if (fit !== 'red' && contextFits < 2048) contextFits = 2048;

    return {
      ...model,
      fit,
      fitLabel,
      estimatedTokS,
      contextFits,
      contextFitsLabel: contextFits >= 1024
        ? `${Math.round(contextFits / 1024)}K`
        : `${contextFits}`,
    };
  });
}

module.exports = { recommend };

'use strict';

async function firstNonEmptySequential(sourceIds, loadSource, options = {}) {
  for (const sourceId of sourceIds) {
    try {
      const items = await loadSource(sourceId);
      if (Array.isArray(items) && items.length > 0) {
        return { sourceId, items };
      }
    } catch (error) {
      if (typeof options.onError === 'function') options.onError(sourceId, error);
      if (options.stopOnError) break;
    }
  }
  return { sourceId: null, items: [] };
}

module.exports = { firstNonEmptySequential };

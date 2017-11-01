'use strict';

/**
 *
 */
class ClusterStats {
  /**
   *
   */
  get available() {
    return this._getTotal('available');
  }

  /**
   *
   */
  get borrowed() {
    return this._getTotal('borrowed');
  }

  /**
   *
   */
  get size() {
    return this._getTotal('size');
  }

  /**
   *
   */
  constructor(pools) {
    this._pools = pools;
  }

  /**
   *
   */
  _getTotal(property) {
    return this._pools.reduce((total, pool) => total + pool[property], 0);
  }
}

module.exports = ClusterStats;

'use strict';

/**
 * View stats for {@link Cluster} objects.
 * @class
 * @see Cluster#stats
 */
class ClusterStats {
  /**
   * The number of available resources.
   * @member {number}
   */
  get available() {
    return this._getTotal('available');
  }

  /**
   * The number of borrowed resources.
   * @member {number}
   */
  get borrowed() {
    return this._getTotal('borrowed');
  }

  /**
   * The number of idle resources.
   * @member {number}
   */
  get idle() {
    return this._getTotal('idle');
  }

  /**
   * The total number of resources.
   * @member {number}
   */
  get size() {
    return this._getTotal('size');
  }

  /**
   * @constructs ClusterStats
   * @hideconstructor
   * @param {Pool[]} pools - The pools to get stats for.
   */
  constructor(pools) {
    this._pools = pools;
  }

  /**
   * Generates totals between pools.
   * @private
   * @param {string} property - The property to generate a total for.
   * @return {number}
   */
  _getTotal(property) {
    return this._pools.reduce((total, pool) => total + pool[property], 0);
  }
}

module.exports = ClusterStats;

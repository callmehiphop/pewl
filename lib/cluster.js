'use strict';

const arrify = require('arrify');

const AbstractPool = require('./abstract-pool');
const ClusterStats = require('./cluster-stats');

const SHARED_OPTIONS = [
  'acquireTimeout',
  'diesAfter',
  'fifo',
  'idlesAfter',
  'ping',
  'isDead',
  'isIdle',
];

const EVENTS = ['available', 'createError', 'destroyError', 'pingError'];

/**
 * Creates a new Cluster.
 * @class
 * @extends AbstractPool
 * @example
 * const readPool = new Pool({ attributes: ['r'] });
 * const writePool = new Pool({ attributes: ['r', 'w'] });
 * const cluster = new Cluster({ pools: [readPool, writePool] });
 */
class Cluster extends AbstractPool {
  /**
   * @constructs Cluster
   * @param {object} options - Cluster options.
   * @param {number} [options.acquireTimeout=Infinity] - Time to wait for an
   *     acquire to finish before rejecting the promise.
   * @param {number} [options.concurrency=Infinity] - Maximum number of
   *     concurrent requests allowed to be made.
   * @param {number} [options.diesAfter=Infinity] - Mark resource dead after
   *     specified duration.
   * @param {boolean} [options.fifo=true] - Treat pool like a stack when
   *     acquiring resources.
   * @param {number} [options.idlesAfter=600000] - Mark resource idle after
   *     specified duration.
   * @param {Resource~pingCallback} [options.ping] - Async function that pings
   *     idle resources.
   * @param {number} [options.pingInterval=600000] - Frequency to ping idle
   *    resources.
   * @param {Pool[]} [options.pools] - Pool objects.
   * @param {number} [options.skimInterval] - Frequency to destroy dead and idle
   *    (with respect to maxIdle) resources.
   */
  constructor(options) {
    super(options);

    this._pools = [];
    arrify(this.get('pools')).forEach(pool => this.add(pool));
    this.set('pools', null);
  }

  /**
   * Acquires a resource from the cluster.
   * @param {object} [options] - Acquire options.
   * @param {number} options.priority - Priority of this request.
   * @param {string[]} options.attributes - Desired resource attributes.
   * @return {Promise} Resolves with resource value.
   * @example
   * const resource = await cluster.acquire();
   * @example <caption>Specify resource attributes</caption>
   * const resource = await cluster.acquire({ attributes: ['w'] });
   */
  acquire(options) {
    options = options || {};

    return super.acquire(options, () => {
      const stats = this.stats(options.attributes);

      if (stats.available) {
        return this._acquireWhere(options.attributes);
      }

      return this._waitForAvailableResource(options.attributes);
    });
  }

  /**
   * Add a pool to the cluster. Useful for adding after instantiation time.
   * @param {Pool} pool - The pool to add.
   * @example
   * const pool = new Pool({...});
   * cluster.add(pool);
   */
  add(pool) {
    pool._setRequester(this);

    SHARED_OPTIONS.forEach(option => {
      const clusterOption = this.get(option);

      if (typeof clusterOption !== 'undefined') {
        pool.set(option, clusterOption);
      }
    });

    EVENTS.forEach(event => {
      pool.on(event, message => this.emit(event, message));
    });

    this._pools.push(pool);
  }

  /**
   * Close the cluster and all pools associated with it.
   * @return {Promise} Resolves after cluster and pools have been closed.
   * @example
   * await cluster.close();
   */
  close() {
    super.close();

    return this._exec('close', {flush: false}).then(() => {
      this._pools.length = 0;
    });
  }

  /**
   * Destroy a resource within the cluster.
   * @throws Will throw for unknown resource.
   * @param {*} value - The resource value.
   * @return {Promise} Resolves once the resource has been destroyed.
   * @example
   * const resource = cluster.acquire();
   * await cluster.destroy(resource);
   */
  destroy(value) {
    for (let pool of this._pools) {
      if (pool.includes(value)) {
        return pool.destroy(value);
      }
    }

    throw new Error('Unable to destroy unknown resource.');
  }

  /**
   * Open the cluster and all pools associated with it.
   * @return {Promise} Resolves after cluster and pools have been opened.
   * @example
   * await cluster.open();
   */
  open() {
    super.open();

    return Promise.all(
      this._pools.map(pool => (pool.isOpen ? null : pool.open()))
    );
  }

  /**
   * Releases a resource back into the cluster.
   * @throws Will throw for unknown resource.
   * @param {*} value - The resource value.
   * @example
   * const resource = await pool.acquire();
   * pool.release(resource);
   */
  release(value) {
    for (let pool of this._pools) {
      if (pool.includes(value)) {
        return pool.release(value);
      }
    }

    throw new Error('Unable to release unknown resource.');
  }

  /**
   * Get stats about the cluster, optionally narrowed down by attribute(s).
   * @param {string[]} [attributes] - Resource attributes to get stats for.
   * @return {ClusterStats}
   * @example <caption>Get stats for all resources.</caption>
   * const stats = cluster.stats();
   * @example <caption>Get stats for write enabled resources.</caption>
   * const writeStats = cluster.stats(['write']);
   */
  stats(attributes) {
    return new ClusterStats(this._getPoolsWhere(attributes));
  }

  /**
   * Acquires resource with specific attributes.
   * @private
   * @param {string[]} [attributes] - The attributes.
   * @return {Promise} Resolves with resource.
   */
  _acquireWhere(attributes) {
    const pools = this._getPoolsWhere(attributes).filter(
      pool => pool.available
    );

    return pools[0].acquire();
  }

  /**
   * Calls a class method on all pools.
   * @private
   * @param {string} method - The class method to call.
   * @param {object} [options] - Method options.
   * @return {Promise} Resolves with all class methods resolve.
   */
  _exec(method, options) {
    return Promise.all(this._pools.map(pool => pool[method](options)));
  }

  /**
   * Returns a filtered pool list by attributes.
   * @private
   * @param {string[]} [attributes] - The attributes.
   * @return {Pool[]}
   */
  _getPoolsWhere(attributes) {
    attributes = arrify(attributes);

    if (!attributes.length) {
      return this._pools;
    }

    return this._pools.filter(pool => {
      let poolAttributes = arrify(pool.get('attributes'));

      for (let attribute of attributes) {
        if (poolAttributes.indexOf(attribute) === -1) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   * Pings all idle resources within the cluster.
   * @private
   * @return {Promise} Resolves when ping is complete.
   */
  _pingIdleResources() {
    return this._exec('_pingIdleResources');
  }

  /**
   * Skims all resources within the cluster.
   * @private
   * @return {Promise} Resolves when skim is complete.
   */
  _skimResources() {
    return this._exec('_skimResources');
  }

  /**
   * Waits for next available resource from any of the pools. If no resources
   * are available it will attempt to create one.
   * @private
   * @param {string[]} [attributes] - Desired attributes of resource.
   * @return {Promise} Resolves with a resource when one becomes available.
   */
  _waitForAvailableResource(attributes) {
    const pools = this._getPoolsWhere(attributes);
    const pendingPools = pools.filter(pool => pool._pendingCreates);
    const promises = pools.map(pool => {
      return new Promise(resolve => {
        pool.once('available', () => resolve(pool));
      });
    });

    if (!pendingPools.length) {
      for (let pool of pools) {
        if (pool.size < pool.get('max')) {
          let promise = new Promise((resolve, reject) => {
            pool.once('createError', reject);
          });

          promises.push(promise);
          pool._createResource();
          break;
        }
      }
    }

    return Promise.race(promises).then(pool => pool.acquire());
  }
}

module.exports = Cluster;

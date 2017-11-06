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

const EVENTS = [
  'available',
  'createError',
  'destroyed',
  'destroyError',
  'pingError',
];

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
   * The number of available resources.
   * @member {number}
   */
  get available() {
    return this._stats.available;
  }

  /**
   * The number of borrowed resource.
   * @member {number}
   */
  get borrowed() {
    return this._stats.borrowed;
  }

  /**
   * The number of idle resources.
   * @member {number}
   */
  get idle() {
    return this._stats.idle;
  }

  /**
   * The pools currently in the cluster.
   * @member {Pool[]}
   */
  get pools() {
    return this._pools;
  }

  /**
   * The total number of resources.
   * @member {number}
   */
  get size() {
    return this._stats.size;
  }

  /**
   * @typedef {object} Cluster~CreateOptions
   * @property {number} [acquireTimeout=Infinity] - Time to wait for an
   *     acquire to finish before rejecting the promise.
   * @property {boolean} [autoStart=false] - Automagically open the cluster.
   * @property {number} [concurrency=Infinity] - Maximum number of
   *     concurrent requests allowed to be made.
   * @property {number} [diesAfter=Infinity] - Mark resource dead after
   *     specified duration.
   * @property {boolean} [fifo=true] - Treat pool like a stack when
   *     acquiring resources.
   * @property {number} [idlesAfter=600000] - Mark resource idle after
   *     specified duration.
   * @property {Resource~pingCallback} [ping] - Async function that
   *     pings idle resources.
   * @property {number} [pingInterval=600000] - Frequency to ping idle
   *    resources.
   * @property {Pool[]} [pools] - Pool objects.
   * @property {number} [skimInterval] - Frequency to destroy dead and
   *    idle (with respect to maxIdle) resources.
   */
  /**
   * @constructs Cluster
   * @param {Cluster~CreateOptions} options - Cluster options.
   */
  constructor(options) {
    super(options);

    this._pools = [];

    arrify(this.get('pools')).forEach(pool => this.add(pool));
    this.set('pools', null);

    this._stats = new ClusterStats(this._pools);
  }

  /**
   * @typedef {object} Cluster~AcquireOptions
   * @property {number} [priority] - Priority of this request.
   * @property {string[]} [attributes] - Desired resource attributes.
   */
  /**
   * Acquires a resource from the cluster.
   * @param {Cluster~AcquireOptions} [options] - Acquire options.
   * @return {Promise} Resolves with resource value.
   * @example
   * const resource = await cluster.acquire();
   * @example <caption>Specify resource attributes</caption>
   * const resource = await cluster.acquire({ attributes: ['w'] });
   */
  acquire(options) {
    options = options || {};

    const attributes = options.attributes;
    const pools = this._getPoolsWhere(attributes);

    if (!pools.length) {
      if (attributes) {
        throw new Error(`No pools found with attribute(s) "${attributes}".`);
      }

      throw new Error('No pools found in cluster.');
    }

    if (pools.length === 1) {
      return pools[0].acquire();
    }

    const pool = this._getAcquirablePool(pools);

    if (pool) {
      return pool.acquire();
    }

    return this._waitForAvailableResource(pools, options);
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
      // spread operator not available in Node 4 :(
      pool.on(
        event,
        function() {
          const args = Array.prototype.slice.call(arguments);
          this.emit.apply(this, [event].concat(args));
        }.bind(this)
      );
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

    return this._exec('close', {flush: false});
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
   * Checks to see if resource value belongs in this cluster.
   * @param {*} value - The resource value.
   * @return {boolean}
   * @example
   * const resource = await cluster.acquire();
   * cluster.includes(resource); // returns true
   */
  includes(value) {
    for (let pool of this._pools) {
      if (pool.includes(value)) {
        return true;
      }
    }

    return false;
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
    if (attributes) {
      return new ClusterStats(this._getPoolsWhere(attributes));
    }

    return this._stats;
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
   * Attempt to find a pool that we can safely acquire from.
   * @private
   * @param {Pool[]} pools - Pools we are trying to acquire from.
   * @return {?Pool}
   */
  _getAcquirablePool(pools) {
    // lets try and find a pool with available resources
    for (let pool of pools) {
      if (pool.available) {
        return pool;
      }
    }

    // none available? let's try and find a pool with some room to spare..
    for (let pool of pools) {
      if (pool.size + pool.pending < pool.get('max')) {
        return pool;
      }
    }

    return null;
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
   * @throws Will throw if bad attributes are given.
   * @throws Will throw if no pools exist.
   * @param {Pool[]} pools - Pools to race against one another.
   * @param {Cluster~AcquireOptions} [options] - Acquire options.
   * @return {Promise} Resolves with a resource when one becomes available.
   */
  _waitForAvailableResource(pools, options) {
    return this._queueAcquire(options, () => {
      const pool = this._getAcquirablePool(pools);

      if (pool) {
        return pool.acquire();
      }

      const promises = pools.map(pool => {
        return new Promise(resolve => {
          pool.once('available', () => resolve(pool));
        });
      });

      return Promise.race(promises).then(pool => pool.acquire());
    });
  }
}

module.exports = Cluster;

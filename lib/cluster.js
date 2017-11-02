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
  'shouldRetry',
  'isDead',
  'isIdle',
];

const EVENTS = ['available', 'createError', 'destroyError', 'pingError'];

/**
 *
 */
class Cluster extends AbstractPool {
  /**
   *
   */
  constructor(options) {
    super(options);

    this._pools = [];
    arrify(this.get('pools')).forEach(pool => this.add(pool));
    this.set('pools', null);
  }

  /**
   *
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
   *
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
   *
   */
  close() {
    super.close();

    return this.exec('close', {flush: false}).then(() => {
      this._pools.length = 0;
    });
  }

  /**
   *
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
   *
   */
  exec(method, options) {
    return Promise.all(this._pools.map(pool => pool[method](options)));
  }

  /**
   *
   */
  fill() {
    return this.exec('fill');
  }

  /**
   *
   */
  open() {
    super.open();

    return Promise.all(
      this._pools.map(pool => (pool.isOpen ? null : pool.open()))
    );
  }

  /**
   *
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
   *
   */
  stats(attributes) {
    let pools = this._pools;

    if (attributes) {
      pools = this._getPoolsWhere(attributes);
    }

    return new ClusterStats(pools);
  }

  /**
   *
   */
  _acquireWhere(attributes) {
    const pools = this._getPoolsWhere(attributes).filter(
      pool => pool.available
    );

    return pools[0].acquire();
  }

  /**
   *
   */
  _getPoolsWhere(attributes) {
    attributes = arrify(attributes);

    if (!attributes.length) {
      return this._pools;
    }

    return this._pools.filter(pool => {
      for (let attribute of attributes) {
        if (!pool.get('attributes').includes(attribute)) {
          return false;
        }
      }
      return true;
    });
  }

  /**
   *
   */
  _pingIdleResources() {
    return this.exec('_pingIdleResources');
  }

  /**
   *
   */
  _skimResources() {
    return this.exec('_skimResources');
  }

  /**
   *
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

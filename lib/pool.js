'use strict';

const AbstractPool = require('./abstract-pool');
const Resource = require('./resource');
const ResourceList = require('./resource-list');

const DEFAULTS = {
  attributes: [],
  concurrency: Infinity,
  diesAfter: Infinity,
  fifo: true,
  idlesAfter: 60000 * 10,
  max: Infinity,
  maxIdle: Infinity,
  min: 0,
  isDead: r => Date.now() - r.createdAt >= r.diesAfter || r.pingFailed,
  isIdle: r => Date.now() - r.lastAcquired >= r.idlesAfter,
};

/**
 * Creates a new Pool.
 * @class
 * @extends AbstractPool
 * @example
 * const pool = new Pool({
 *   create: () => someAsyncFunction(),
 *   destroy: resource => someOtherAsyncFunction(resource)
 * });
 */
class Pool extends AbstractPool {
  /**
   * The number of available resources.
   * @member {number}
   */
  get available() {
    return this._available.length;
  }

  /**
   * The number of borrowed resource.
   * @member {number}
   */
  get borrowed() {
    return this._borrowed.length;
  }

  /**
   * The number of idle resources.
   * @member {number}
   */
  get idle() {
    return this._available.filter(resource => resource.isIdle()).length;
  }

  /**
   * The total number of resources.
   * @member {number}
   */
  get size() {
    return this.available + this.borrowed;
  }

  /**
   * @constructs Pool
   * @throws Will throw an error if create or destroy options are missing.
   * @param {object} options - Pool options.
   * @param {number} [options.acquireTimeout=Infinity] - Time to wait for an
   *     acquire to finish before rejecting the promise.
   * @param {string[]} [options.attributes] - Pool attributes, useful for
   *     managing several pools within a cluster.
   * @param {number} [options.concurrency=Infinity] - Maximum number of
   *     concurrent requests allowed to be made.
   * @param {Resource~createCallback} options.create - Async function that
   *     creates a resource.
   * @param {Resource~destroyCallback} options.destroy - Async function that
   *     destroys a resource.
   * @param {number} [options.diesAfter=Infinity] - Mark resource dead after
   *     specified duration.
   * @param {boolean} [options.fifo=true] - Treat pool like a stack when
   *     acquiring resources.
   * @param {number} [options.idlesAfter=600000] - Mark resource idle after
   *     specified duration.
   * @param {Resource~isDeadCallback} [options.isDead] - Function for determining
   *     whether or not a resource is dead. Advanced use only!
   * @param {Resource~isIdleCallback} [options.isIdle] - Function for determining
   *     whether or not a resource is idle. Advanced use only!
   * @param {number} [options.max=Infinity] - Maximum number of resources the
   *     pool should create.
   * @param {number} [options.maxIdle=Infinity] - Maximum number of idle
   *     resources the pool should tolerate before deleting.
   * @param {number} [options.min=0] - Minimum number of resources needed in the
   *     the pool at any time.
   * @param {Resource~pingCallback} [options.ping] - Async function that pings
   *     idle resources.
   * @param {number} [options.skimInterval] - Frequency to destroy dead and idle
   *    (with respect to maxIdle) resources.
   */
  constructor(options) {
    if (!options || !options.create || !options.destroy) {
      throw new Error('Both "create" and "destroy" methods are required.');
    }

    options = Object.assign({}, DEFAULTS, options);

    super(options);

    this._pendingCreates = 0;
    this._available = new ResourceList(this._options);
    this._borrowed = new ResourceList();
  }

  /**
   * Acquires a resource from the pool.
   * @param {object} [options] - Acquire options.
   * @param {number} options.priority - Priority of this request.
   * @return {Promise} Resolves with resource value.
   * @example
   * const resource = await pool.acquire();
   */
  acquire(options) {
    return super
      .acquire(options, () => {
        if (this.available) {
          return this._borrowResource();
        }

        return this._waitForAvailableResource();
      })
      .then(resource => resource.value);
  }

  /**
   * Closes the pool.
   * @param {object} [options] - Close options.
   * @param {boolean} options.flush=true - Flush all pending requests.
   * @return {Promise} Resolves once pool is drained.
   * @example
   * await pool.close();
   */
  close(options) {
    super.close(options);

    return this._onIdle().then(() => this.drain());
  }

  /**
   * Destroy a resource that belongs to the pool.
   * @throws Will throw for unknown resources.
   * @param {*} resource - The resource to destroy.
   * @return {Promise} Resolves once resource is destroyed.
   * @example
   * const resource = await pool.acquire();
   * await pool.destroy(resource);
   */
  destroy(value) {
    let group = this._borrowed;
    let resource = group.findWhere({value});

    if (!resource) {
      group = this._available;
      resource = group.findWhere({value});
    }

    if (!resource) {
      throw new Error('Unable to destroy unknown resource.');
    }

    group.delete(resource);
    return this._destroyResource(resource);
  }

  /**
   * Drains pool of current resources.
   * @return {Promise} Resolves once pool is empty.
   * @example
   * await pool.drain();
   */
  drain() {
    const resources = this._available.concat(this._borrowed);

    this._available.clear();
    this._borrowed.clear();

    return Promise.all(
      resources.map(resource => this._destroyResource(resource))
    );
  }

  /**
   * Fills pool to min value. This is generally only useful when changing the
   * min value on the fly.
   * @return {Promise} Resolves once pool is filled.
   * @example
   * pool.set('min', 5);
   * await pool.fill();
   */
  fill() {
    const needed = this.get('min') - this.available;

    if (needed < 1) {
      return Promise.resolve();
    }

    return Promise.all(
      Array(needed)
        .fill(() => this._createResource())
        .map(request => request())
    );
  }

  /**
   * Checks to see if resource value belong in this pool.
   * @param {*} value - The resource value.
   * @return {boolean}
   * @example
   * const resource = await pool.acquire();
   * pool.includes(resource); // returns true
   */
  includes(value) {
    const options = {value};

    return !!(
      this._borrowed.findWhere(options) || this._available.findWhere(options)
    );
  }

  /**
   * Opens pool.
   * @return {Promise} Resolves once pool is filled.
   * @example
   * await pool.open();
   */
  open() {
    super.open();

    return this.fill();
  }

  /**
   * Releases a resource value back into the pool.
   * @throws Will throw for unknown resources.
   * @fires Pool#available
   * @param {*} value - The resource value.
   * @example
   * const resource = await pool.acquire();
   * pool.release(resource);
   */
  release(value) {
    const resource = this._borrowed.findWhere({value});

    if (!resource) {
      throw new Error('Unable to release unknown resource.');
    }

    this._borrowed.delete(resource);
    this._available.add(resource);

    this.emit('available');
  }

  /**
   * Borrows next resource in the pool.
   * @private
   * @return {Resource} The resource to borrow.
   */
  _borrowResource() {
    const resource = this._available.shift();

    resource.lastAcquired = Date.now();
    this._borrowed.add(resource);

    return resource;
  }

  /**
   * Creates a resource.
   * @private
   * @fires Pool#available
   * @fires Pool#createError
   * @return {Promise} Resolves after resource is created.
   */
  _createResource() {
    const resource = new Resource(this._options);

    this._pendingCreates += 1;

    return this._request(() => resource.create())
      .then(
        () => {
          this._available.add(resource);
          this.emit('available');
        },
        err => this.emit('createError', err, resource.value)
      )
      .then(() => {
        this._pendingCreates -= 1;
      });
  }

  /**
   * Destroys a resource, creating a new one if necessary.
   * @see Pool#_createResource
   * @private
   * @fires Pool#destroyError
   * @param {Resource} The resource to destroy.
   * @return {Promise} Resolves after resource is destroyed.
   */
  _destroyResource(resource) {
    if (this.isOpen && this.size < this.get('min')) {
      this._createResource();
    }

    return this._request(() => resource.destroy()).catch(err =>
      this.emit('destroyError', err, resource.value)
    );
  }

  /**
   * Pings idle resources.
   * @fires Pool#pingError
   * return {Promise} Resolves after resources have been pinged.
   */
  _pingIdleResources() {
    const idleResources = this._available.filter(resource => resource.isIdle());

    return Promise.all(
      idleResources.map(resource => {
        return this._request(() => resource.ping()).then(
          () => (resource.pingFailed = false),
          err => {
            this.emit('pingError', err, resource.value);
            resource.pingFailed = true;
          }
        );
      })
    );
  }

  /**
   * Removes dead resources and idle resources (with respect to maxIdle) from
   * the pool.
   * @see Pool#_destroyResource
   * @private
   * @return {Promise} Resolves after all resources are destroyed.
   */
  _skimResources() {
    const dead = this._available.filter(resource => resource.isDead());
    const idle = this._available.filter(resource => resource.isIdle());

    let idleCount = idle.length;

    while (idleCount-- > this.get('maxIdle')) {
      let resource = idle.pop();

      if (dead.indexOf(resource) === -1) {
        dead.push(resource);
      }
    }

    return Promise.all(
      dead.map(resource => {
        this._available.delete(resource);
        return this._destroyResource(resource);
      })
    );
  }

  /**
   * Waits for next available resource, optionally creating a new resource if
   * none are available and the pools max has not been hit.
   * @see Pool#_createResource
   * @private
   * @return {Promise} Resolves once a resource becomes available.
   */
  _waitForAvailableResource() {
    return new Promise((resolve, reject) => {
      let onavailable;
      let onerror;

      onavailable = () => {
        this.removeListener('createError', onerror);
        resolve(this._borrowResource());
      };

      onerror = () => {
        this.removeListener('available', onavailable);
        reject(err);
      };

      if (
        this.size < this.get('max') &&
        this._pendingCreates < this._acquireQueue.pending
      ) {
        this._createResource();
        this.once('createError', onerror);
      }

      this.once('available', onavailable);
    });
  }
}

module.exports = Pool;

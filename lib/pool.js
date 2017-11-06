'use strict';

const AbstractPool = require('./abstract-pool');
const Resource = require('./resource');
const ResourceList = require('./resource-list');

const DEFAULTS = {
  attributes: [],
  autoStart: false,
  concurrency: Infinity,
  diesAfter: Infinity,
  fifo: true,
  idlesAfter: 60000 * 10,
  max: Infinity,
  maxIdle: Infinity,
  min: 0,
  isDead: r => Date.now() - r.createdAt >= r.diesAfter,
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
   * @typedef {object} Pool~CreateOptions
   * @property {number} [acquireTimeout=Infinity] - Time to wait for an
   *     acquire to finish before rejecting the promise.
   * @property {string[]} [attributes] - Pool attributes, useful for
   *     managing several pools within a cluster.
   * @property {boolean} [autoStart=false] - Automagically open the pool.
   * @property {number} [concurrency=Infinity] - Maximum number of
   *     concurrent requests allowed to be made.
   * @property {Resource~createCallback} create - Async function that
   *     creates a resource.
   * @property {Resource~destroyCallback} destroy - Async function that
   *     destroys a resource.
   * @property {number} [diesAfter=Infinity] - Mark resource dead after
   *     specified duration.
   * @property {boolean} [fifo=true] - Treat pool like a stack when
   *     acquiring resources.
   * @property {number} [idlesAfter=600000] - Mark resource idle after
   *     specified duration.
   * @property {Resource~isDeadCallback} [isDead] - Function for determining
   *     whether or not a resource is dead. Advanced use only!
   * @property {Resource~isIdleCallback} [isIdle] - Function for determining
   *     whether or not a resource is idle. Advanced use only!
   * @property {number} [max=Infinity] - Maximum number of resources the
   *     pool should create.
   * @property {number} [maxIdle=Infinity] - Maximum number of idle
   *     resources the pool should tolerate before deleting.
   * @property {number} [min=0] - Minimum number of resources needed in the
   *     the pool at any time.
   * @property {Resource~pingCallback} [ping] - Async function that pings
   *     idle resources.
   * @property {number} [pingInterval=600000] - Frequency to ping idle
   *    resources.
   * @property {number} [skimInterval] - Frequency to destroy dead and idle
   *    (with respect to maxIdle) resources.
   */
  /**
   * @constructs Pool
   * @throws Will throw an error if create or destroy options are missing.
   * @param {Pool~CreateOptions} options - Pool options.
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
   * @typedef {object} Pool~AcquireOptions
   * @property {number} priority - Priority of this request.
   */
  /**
   * Acquires a resource from the pool.
   * @param {Pool~AcquireOptions} [options] - Acquire options.
   * @return {Promise} Resolves with resource value.
   * @example
   * const resource = await pool.acquire();
   */
  acquire(options) {
    if (this.available && !this.pending) {
      return Promise.resolve(this._borrowResource());
    }

    return this._waitForAvailableResource(options);
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
    if (!this.includes(value)) {
      throw new Error('Unable to destroy unknown resource.');
    }

    let resource = this._borrowed.findWhere({value});

    if (resource) {
      this._available.add(resource);
      this._borrowed.delete(resource);
    } else {
      resource = this._available.findWhere({value});
    }

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
      resources.map(resource => {
        return this._destroyResource(resource, {create: false});
      })
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
   * Checks to see if resource value belongs in this pool.
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

    return resource.value;
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
   * @fires Pool#destroyed
   * @fires Pool#destroyError
   * @param {Resource} The resource to destroy.
   * @param {object} [options] - Destroy options.
   * @param {boolean} [options.create=true] - Create a new resource.
   * @return {Promise} Resolves after resource is destroyed.
   */
  _destroyResource(resource, options) {
    options = options || {};

    this._available.delete(resource);
    this.emit('destroyed');

    if (
      options.create !== false &&
      this.isOpen &&
      this.size < this.get('min')
    ) {
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
        return this._request(() => resource.ping()).catch(err => {
          this._destroyResource(resource);
          this.emit('pingError', err, resource.value);
        });
      })
    );
  }

  /**
   * Removes dead resources and idle resources (with respect to min and maxIdle)
   * from the pool.
   * @see Pool#_destroyResource
   * @private
   * @return {Promise} Resolves after all resources are destroyed.
   */
  _skimResources() {
    const maxIdle = this.get('maxIdle');
    const min = this.get('min');

    const dead = this._available.filter(resource => resource.isDead());
    const idle = this._available.filter(resource => resource.isIdle());

    let idleCount = idle.length;

    while (idleCount-- > maxIdle && idleCount >= min) {
      let resource = idle.pop();

      if (dead.indexOf(resource) === -1) {
        dead.push(resource);
      }
    }

    return Promise.all(
      dead.map(resource => {
        return this._destroyResource(resource);
      })
    );
  }

  /**
   * Waits for next available resource, optionally creating a new resource if
   * none are available and the pools max has not been hit.
   * @see Pool#_createResource
   * @private
   * @param {Pool~AcquireOptions} [options] - Acquire options.
   * @return {Promise} Resolves once a resource becomes available.
   */
  _waitForAvailableResource(options) {
    return this._queueAcquire(options, () => {
      return new Promise((resolve, reject) => {
        let onavailable;
        let onerror;

        onavailable = () => {
          this.removeListener('createError', onerror);
          resolve(this._borrowResource());
        };

        onerror = err => {
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
    });
  }
}

module.exports = Pool;

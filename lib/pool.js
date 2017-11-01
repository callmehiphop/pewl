'use strict';

const AbstractPool = require('./abstract-pool');
const Resource = require('./resource');
const ResourceList = require('./resource-list');

const DEFAULTS = {
  attributes: [],
  concurrency: Infinity,
  fifo: true,
  max: Infinity,
  maxIdle: Infinity,
  min: 0,
  shouldRetry: () => false,
  isDead: r => Date.now() - r.createdAt >= r.diesAfter || r.pingFailed,
  isIdle: r => Date.now() - r.lastAcquired >= r.idlesAfter,
};

/**
 *
 */
class Pool extends AbstractPool {
  /**
   *
   */
  get available() {
    return this._available.length;
  }

  /**
   *
   */
  get borrowed() {
    return this._borrowed.length;
  }

  /**
   *
   */
  get idle() {
    return this._available.filter(resource => resource.isIdle()).length;
  }

  /**
   *
   */
  get size() {
    return this.available + this.borrowed;
  }

  /**
   *
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
   *
   */
  acquire(options) {
    return super
      .acquire(options, () => {
        if (this.available) {
          return Promise.resolve(this._borrowResource());
        }

        if (
          this.size < this.get('max') &&
          this._pendingCreates < this._acquireQueue.pending
        ) {
          setImmediate(() => this._createResource());
        }

        return this._waitForAvailableResource();
      })
      .then(resource => resource.value);
  }

  /**
   *
   */
  close(options) {
    super.close(options);

    return this._onIdle().then(() => (this.size ? this.drain() : null));
  }

  /**
   *
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
   *
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
   *
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
   *
   */
  includes(value) {
    const options = {value};

    return !!(
      this._borrowed.findWhere(options) || this._available.findWhere(options)
    );
  }

  /**
   *
   */
  open() {
    super.open();

    return this.fill();
  }

  /**
   *
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
   *
   */
  _borrowResource() {
    const resource = this._available.shift();

    resource.lastAcquired = Date.now();
    this._borrowed.add(resource);

    return resource;
  }

  /**
   *
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
   *
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
   *
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
   *
   */
  _skimResources() {
    const dead = this._available.filter(resource => resource.isDead());
    const idle = this._available.filter(resource => resource.isIdle());

    let idleCount = idle.length;

    while (idleCount-- > this.get('maxIdle')) {
      let resource = idle.pop();

      if (!dead.includes(resource)) {
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
   *
   */
  _waitForAvailableResource() {
    return new Promise((resolve, reject) => {
      let timeout;

      const onavailable = () => {
        if (timeout) clearTimeout(timeout);
        resolve(this._borrowResource());
      };

      const ontimeout = () => {
        this.removeListener('available', onavailable);
        reject(new Error('No resources available.'));
      };

      if (isFinite(this._options.acquireTimeout)) {
        timeout = setTimeout(ontimeout, this._options.acquireTimeout);
      }

      this.once('available', onavailable);
    });
  }
}

module.exports = Pool;

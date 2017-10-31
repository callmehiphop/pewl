'use strict';

const EventEmitter = require('events').EventEmitter;
const PQueue = require('p-queue');

const debug = require('./debug');
const Resource = require('./resource');
const ResourceList = require('./resource-list');

const DEFAULTS = {
  acquireTimeout: Infinity,
  autoStart: true,
  concurrency: Infinity,
  debug: false,
  diesAfter: Infinity,
  fifo: true,
  idlesAfter: 60000 * 10,
  max: Infinity,
  maxIdle: Infinity,
  min: 0,
  pingInterval: 60000 * 10,
  skimInterval: 60000 * 30,
  shouldRetry: () => false,
  isDead: r => Date.now() - r.createdAt >= r.diesAfter || r.pingFailed,
  isIdle: r => Date.now() - r.lastAcquired >= r.idlesAfter,
};

/**
 *
 */
class Pool extends EventEmitter {
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
  constructor(options = {}) {
    if (!options.create || !options.destroy) {
      throw new Error('Both "create" and "destroy" methods are required.');
    }

    super();

    this._options = Object.assign({}, DEFAULTS, options);
    this._pendingCreates = 0;

    this._pingHandle = null;
    this._skimHandle = null;

    this._acquireQueue = new PQueue({concurrency: 1});
    this._requestQueue = new PQueue(this._options);

    this._available = new ResourceList(this._options);
    this._borrowed = new ResourceList();

    if (this._options.autoStart) {
      this.open();
    }

    if (this._options.debug) {
      debug.enable();
    }
  }

  /**
   *
   */
  acquire(options) {
    if (!this.isOpen) {
      throw new Error('The pool you are trying to acquire from is closed.');
    }

    debug.info('acquiring resource');

    return this._acquireQueue
      .add(() => {
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
      }, options)
      .then(resource => resource.value);
  }

  /**
   *
   */
  close() {
    debug.info('closing pool');

    this.isOpen = false;

    if (this._pingHandle) {
      clearInterval(this._pingHandle);
    }

    if (this._skimHandle) {
      clearInterval(this._skimHandle);
    }

    this._requestQueue.clear();

    return this._requestQueue
      .onIdle()
      .then(() => (this.size ? this.drain() : null));
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
    debug.info('draining pool');

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
    debug.info('refilling pool');

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
  get(option) {
    return this._options[option];
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
    debug.info('opening pool');

    this.isOpen = true;

    return this.fill().then(() => {
      if (typeof this._options.ping === 'function') {
        this._pingHandle = setInterval(
          () => this._pingIdleResources(),
          this._options.pingInterval
        );
      }

      if (typeof this._options.skimInterval === 'number') {
        this._skimHandle = setInterval(
          () => this.skim(),
          this._options.skimInterval
        );
      }
    });
  }

  /**
   *
   */
  release(value) {
    debug.info('releasing resource', value);

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
  set(option, value) {
    this._options[option] = value;
    return this;
  }

  /**
   *
   */
  skim() {
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
  _borrowResource() {
    const resource = this._available.shift();

    debug.info('resource acquired', resource.value);

    resource.lastAcquired = Date.now();
    this._borrowed.add(resource);

    return resource;
  }

  /**
   *
   */
  _createResource() {
    debug.info('creating new resource');

    const resource = new Resource(this._options);

    this._pendingCreates += 1;

    return this._requestQueue
      .add(() => resource.create())
      .then(
        () => {
          this._available.add(resource);
          this.emit('available');
        },
        err => {
          debug.info('error creating resource', err);
          this.emit('createError', err, resource.value);
        }
      )
      .then(() => {
        this._pendingCreates -= 1;
      });
  }

  /**
   *
   */
  _destroyResource(resource) {
    debug.info('destroying resource', resource.value);

    if (this.isOpen && this.size < this.get('min')) {
      this._createResource();
    }

    return this._requestQueue.add(() => resource.destroy()).catch(err => {
      debug.info('destroy error', err);
      this.emit('destroyError', err, resource.value);
    });
  }

  /**
   *
   */
  _pingIdleResources() {
    const idleResources = this._available.filter(resource => resource.isIdle());

    debug.info(`pinging ${idleResources.length} idle resources`);

    return Promise.all(
      idleResources.map(resource => {
        return this._requestQueue.add(() => resource.ping()).then(
          () => (resource.pingFailed = false),
          err => {
            debug.info('ping error', err);
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
  _waitForAvailableResource() {
    debug.info('waiting for resource to become available');

    return new Promise((resolve, reject) => {
      let timeout;

      const onavailable = () => {
        if (timeout) clearTimeout(timeout);
        resolve(this._borrowResource());
      };

      const ontimeout = () => {
        debug.info('acquire timeout occurred');
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

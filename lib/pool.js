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
  expires: Infinity,
  fifo: true,
  idleAfter: 60000 * 10,
  max: Infinity,
  maxIdle: Infinity,
  min: 0,
  pingInterval: 60000 * 10,
  resourceLifespan: Infinity,
  shouldRetry: () => false,
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
  get max() {
    return this._options.max;
  }

  /**
   *
   */
  get min() {
    return this._options.min;
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
    if (!options.create || !options.destroy) {
      throw new Error('Both "create" and "destroy" methods are required.');
    }

    super();

    this._options = Object.assign({}, DEFAULTS, options);
    this._pingHandle = null;

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
    clearInterval(this._pingHandle);

    if (this.size) {
      this.drain();
    }

    return this._requestQueue.onIdle().then(() => {
      this._acquireQueue = this._requestQueue = null;
    });
  }

  /**
   *
   */
  destroy(value) {
    const resource = this._borrowed.findWhere({value});

    if (!resource) {
      throw new Error('Unable to destroy unknown resource.');
    }

    this._borrowed.delete(resource);
    setImmediate(() => this.fill());

    return this._requestQueue.add(() => this._destroyResource(resource));
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
      resources.map(resource => {
        return this._requestQueue.add(() => {
          return this._destroyResource(resource);
        });
      })
    );
  }

  /**
   *
   */
  fill() {
    debug.info('refilling pool');

    return Promise.all(
      Array(this.min - this.available)
        .fill(() => this._createResource())
        .map(request => request())
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

    return this._requestQueue.add(() => resource.create()).then(
      () => {
        this._available.add(resource);
        this.emit('available');
      },
      err => {
        debug.info('error creating resource', err);
        this.emit('createError', err);
      }
    );
  }

  /**
   *
   */
  _destroyResource(resource) {
    debug.info('destroying resource', resource.value);

    return resource.destroy().catch(err => {
      debug.info('destroy error', err);
      this.emit('destroyError', err);
    });
  }

  /**
   *
   */
  _pingIdleResources() {
    const idleResources = this._available.filter(resource => resource.isIdle);

    debug.info(`pinging ${idleResources.length} idle resources`);

    return Promise.all(
      idleResources.map(resource => {
        return this._requestQueue.add(() => resource.ping()).catch(err => {
          debug.info('ping error', err);
          this.emit('pingError', err);
        });
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

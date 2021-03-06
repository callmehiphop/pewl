'use strict';

const delay = require('delay');
const EventEmitter = require('events').EventEmitter;
const PQueue = require('p-queue');

const DEFAULTS = {
  acquireTimeout: Infinity,
  autoStart: false,
  concurrency: Infinity,
  pingInterval: 60000 * 10,
};

/**
 * Abstract pool interface.
 * @class
 * @extends module:events/EventEmitter
 */
class AbstractPool extends EventEmitter {
  /**
   * Number of pending acquire requesters.
   * @member {number}
   */
  get pending() {
    return this._acquireQueue.pending;
  }

  /**
   * @constructs AbstractPool
   * @param {object} options - Pool options.
   * @param {number} [options.acquireTimeout=Infinity] - Time to wait for an
   *     acquire to finish before rejecting the promise.
   * @param {boolean} [options.autoStart=false] - Automagically open the pool.
   * @param {number} [options.concurrency=Infinity] - Maximum number of
   *     concurrent requests allowed to be made.
   * @param {Resource~pingCallback} [options.ping] - Async function that pings
   *     idle resources.
   * @param {number} [options.pingInterval=600000] - Frequency to ping idle
   *    resources.
   * @param {number} [options.skimInterval] - Frequency to destroy dead and idle
   *    (with respect to maxIdle) resources.
   */
  constructor(options) {
    super();

    this.isOpen = false;
    this._onClose = null;

    this._options = Object.assign({}, DEFAULTS, options);

    this._pingHandle = null;
    this._skimHandle = null;

    this._acquireQueue = new PQueue({concurrency: 1});
    this._requestQueue = new PQueue(this._options);

    this._requester = this;

    // @TODO test this..
    if (this.get('autoStart')) {
      setImmediate(() => {
        this.open().then(() => this.emit('open'));
      });
    }
  }

  /**
   * Closes the Pool(ish) object.
   * @fires AbstractPool#close
   * @param {object} [options] - Closing options.
   * @param {boolean} [options.flush=true] - If request queue should be flushed.
   */
  close(options) {
    options = options || {flush: true};

    if (options.flush) {
      this._requester._requestQueue.clear();
    }

    this.isOpen = false;
    this.emit('close');
  }

  /**
   * Gets a single Pool configuration.
   * @param {string} option - The desired option.
   * @return {*}
   */
  get(option) {
    return this._options[option];
  }

  /**
   * Sets pool state to open and sets up re-occuring tasks if applicable.
   */
  open() {
    this.isOpen = true;
    this._onClose = new Promise(resolve => this.once('close', resolve));

    if (this.get('ping') || this.get('skimInterval')) {
      this._listenForEvents();
    }
  }

  /**
   * Sets options.
   * @param {string} option - The option to set.
   * @param {*} value - The value.
   * @return {AbstractPool}
   */
  set(option, value) {
    this._options[option] = value;
    return this;
  }

  /**
   * Listens for available and destroyed events, starting and stopping
   * reoccuring tasks as resources come and go.
   * @private
   */
  _listenForEvents() {
    const onavailable = () => {
      if (!this._pingHandle && this.get('ping')) {
        this._pingHandle = setInterval(
          () => this._pingIdleResources(),
          this.get('pingInterval')
        );
      }

      if (!this._skimHandle && this.get('skimInterval')) {
        this._skimHandle = setInterval(
          () => this._skimResources(),
          this.get('skimInterval')
        );
      }
    };

    const ondestroyed = () => {
      if (!this.available) {
        if (this._pingHandle) {
          clearInterval(this._pingHandle);
          this._pingHandle = null;
        }

        if (this._skimHandle) {
          clearInterval(this._skimHandle);
          this._skimHandle = null;
        }
      }
    };

    this.on('available', onavailable);
    this.on('destroyed', ondestroyed);

    this.once('close', () => {
      this.removeListener('available', onavailable);
      this.removeListener('destroyed', ondestroyed);
    });
  }

  /**
   * Promise that is used to determine when the pool becomes idle.
   * @private
   * @return {Promise}
   */
  _onIdle() {
    return this._requester._requestQueue.onIdle();
  }

  /**
   * @callback acquireCallback
   * @return {Promise} Resolves with resource.
   */
  /**
   * Queues up an acquire request.
   * @throws Will throw if pool is closed.
   * @param {object} [options] - Acquire configuration.
   * @param {number} options.priority - Queue priority.
   * @param {acquireCallback} fn - The acquiring function.
   * @return {Promise} Resolves with acquired resource.
   */
  _queueAcquire(options, fn) {
    const closedError = new Error('The pool has been closed.');

    if (!this.isOpen) {
      throw closedError;
    }

    const acquireTimeout = this.get('acquireTimeout');
    const promises = [];

    if (isFinite(acquireTimeout)) {
      let promise = delay.reject(
        acquireTimeout,
        new Error('No resources available.')
      );

      promises.push(promise);
    }

    return this._acquireQueue.add(() => {
      promises.push(
        this._onClose.then(() => Promise.reject(closedError)),
        fn()
      );

      return Promise.race(promises);
    }, options);
  }

  /**
   * @callback requestCallback
   * @return {Promise} Resolves when request is finished.
   */
  /**
   * Adds a request to the request queue.
   * @private
   * @param {requestCallback} fn - The request function.
   * @return {Promise} Resolves after function resolves within the queue.
   */
  _request(fn) {
    return this._requester._requestQueue.add(fn);
  }

  /**
   * Set a requester. This is useful when you want to have multiple Pool objects
   * all use the same request queue.
   * @private
   * @param {AbstractPool} requester - The pool object to act as a requester.
   */
  _setRequester(requester) {
    this._requester = requester;
  }
}

module.exports = AbstractPool;

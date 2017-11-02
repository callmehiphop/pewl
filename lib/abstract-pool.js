'use strict';

const delay = require('delay');
const EventEmitter = require('events').EventEmitter;
const PQueue = require('p-queue');

const DEFAULTS = {
  acquireTimeout: Infinity,
  concurrency: Infinity,
  diesAfter: Infinity,
  idlesAfter: 60000 * 10,
  pingInterval: 60000 * 10,
};

/**
 *
 */
class AbstractPool extends EventEmitter {
  /**
   *
   */
  constructor(options) {
    super();

    this.isOpen = false;

    this._options = Object.assign({}, DEFAULTS, options);

    this._pingHandle = null;
    this._skimHandle = null;

    this._acquireQueue = new PQueue({concurrency: 1});
    this._requestQueue = new PQueue(this._options);

    this._requester = this;
    this._onClose = new Promise(resolve => this.once('close', resolve));
  }

  /**
   *
   */
  acquire(options, fn) {
    const closedError = new Error('The pool is closed.')

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
   *
   */
  close(options) {
    options = options || {
      flush: true
    };

    this.isOpen = false;

    if (this._pingHandle) {
      clearInterval(this._pingHandle);
    }

    if (this._skimHandle) {
      clearInterval(this._skimHandle);
    }

    if (options.flush) {
      this._requester._requestQueue.clear();
    }

    this.emit('close');
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
  open() {
    this.isOpen = true;

    if (this.get('ping')) {
      this._pingHandle = setInterval(
        () => this._pingIdleResources(),
        this.get('pingInterval')
      );
    }

    if (this.get('skimInterval')) {
      this._skimHandle = setInterval(
        () => this._skimResources(),
        this.get('skimInterval')
      );
    }
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
  _onIdle() {
    return this._requester._requestQueue.onIdle();
  }

  /**
   *
   */
  _request(fn) {
    return this._requester._requestQueue.add(fn);
  }

  /**
   *
   */
  _setRequester(requester) {
    this._requester = requester;
  }
}

module.exports = AbstractPool;
module.exports.DEFAULTS = DEFAULTS;
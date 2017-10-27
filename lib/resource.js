'use strict';

/**
 *
 */
class Resource {
  /**
   *
   */
  get isExpired() {
    return Date.now() - this.createdAt >= this.expires;
  }
  /**
   *
   */
  get isIdle() {
    return Date.now() - this.lastAcquired >= this.idleAfter;
  }

  /**
   *
   */
  constructor(options) {
    this.lastAcquired = Date.now();
    this.idleAfter = options.idleAfter;
    this.expires = options.expires;

    this.value = null;
    this.lastPing = null;
    this.createdAt = null;

    this._create = options.create;
    this._destroy = options.destroy;
    this._ping = options.ping;
    this._shouldRetry = options.shouldRetry;
  }

  /**
   *
   */
  create() {
    return this._request(() => {
      return this._create().then(value => {
        this.value = value;
        this.createdAt = Date.now();
      });
    });
  }

  /**
   *
   */
  destroy() {
    return this._request(() => this._destroy(this.value));
  }

  /**
   *
   */
  ping() {
    return this._request(() => this._ping(this.value));
  }

  /**
   *
   */
  _request(fn) {
    return fn().catch(err => {
      if (this._shouldRetry(err)) {
        return this._request(fn);
      }

      return Promise.reject(err);
    });
  }
}

module.exports = Resource;

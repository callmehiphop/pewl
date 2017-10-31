'use strict';

/**
 *
 */
class Resource {
  /**
   *
   */
  constructor(options) {
    this.lastAcquired = Date.now();
    this.idlesAfter = options.idlesAfter;
    this.diesAfter = options.diesAfter;

    this.createdAt = null;
    this.value = null;
    this.pingFailed = false;

    this._create = options.create;
    this._destroy = options.destroy;
    this._isDead = options.isDead;
    this._isIdle = options.isIdle;
    this._ping = options.ping;
    this._shouldRetry = options.shouldRetry;
  }

  /**
   *
   */
  create() {
    return this._request(() => this._create()).then(value => {
      this.value = value;
      this.createdAt = Date.now();
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
  isDead() {
    return this._isDead(this);
  }

  /**
   *
   */
  isIdle() {
    return this._isIdle(this);
  }

  /**
   *
   */
  ping() {
    if (!this._ping) {
      throw new Error('Must provide a "ping" function to use this feature.');
    }

    return this._request(() => this._ping(this.value));
  }

  /**
   *
   */
  _request(fn) {
    return Promise.resolve()
      .then(() => fn())
      .catch(err => {
        if (this._shouldRetry(err)) {
          return this._request(fn);
        }

        throw err;
      });
  }
}

module.exports = Resource;

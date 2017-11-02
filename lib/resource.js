'use strict';

/**
 * Creates a new Resource.
 * @class
 * @example
 * const resource = new Resource({
 *   create: () => someAsyncFunction(),
 *   destroy: resource => someOtherAsyncFunction(resource)
 * });
 */
class Resource {
  /**
   * @callback Resource~createCallback
   * @returns {Promise} Returns resource to store in pool.
   */
  /**
   * @callback Resource~destroyCallback
   * @param {*} resource - The resource to be destroyed.
   * @return {Promise} Resolves once resource is destroyed.
   */
  /**
   * @callback Resource~isDeadCallback
   * @param {Resource} resource - The resource to inspect.
   * @return {boolean} If the resource is dead.
   */
  /**
   * @callback Resource~isIdleCallback
   * @param {Resource} resource - The resource to inspect.
   * @return {boolean} If the resource is idle.
   */
  /**
   * @callback Resource~pingCallback
   * @param {*} resource - The resource to ping.
   * @return {Promise} Resolves after ping.
   */
  /**
   * @constructs Resource
   * @param {object} options - Resource options.
   * @param {number} [options.diesAfter=Infinity] - Mark resource dead after
   *     specified duration.
   * @param {number} [options.idlesAfter=600000] - Mark resource idle after
   *     specified duration.
   * @param {isResourceDeadCallback} [options.isDead] - Function for determining
   *     whether or not a resource is dead. Advanced use only!
   * @param {isResourceIdleCallback} [options.isIdle] - Function for determining
   *     whether or not a resource is idle. Advanced use only!
   * @param {pingResourceCallback} [options.ping] - Async function that pings
   *     idle resources.
   */
  constructor(options) {
    /**
     * Timestamp of when the resource was last acquired.
     * @member {number}
     */
    this.lastAcquired = Date.now();

    /**
     * Timestamp of when the resource was created.
     * @member {number}
     */
    this.createdAt = null;

    /**
     * Resource value.
     * @member {*}
     */
    this.value = null;

    /**
     * Signifies whether or not the last ping failed.
     * @member {boolean}
     */
    this.pingFailed = false;

    /**
     * Duration after resource is considered idle.
     * @member {number}
     */
    this.idlesAfter = options.idlesAfter;

    /**
     * Duration after resource is considered dead.
     * @member {number}
     */
    this.diesAfter = options.diesAfter;

    this._create = options.create;
    this._destroy = options.destroy;
    this._isDead = options.isDead;
    this._isIdle = options.isIdle;
    this._ping = options.ping;
  }

  /**
   * Calls the {@link Resource~createCallback} and stores the resource value.
   * @return {Promise} Resolves after resource is created.
   * @example
   * await resource.create();
   */
  create() {
    return this._create().then(value => {
      this.value = value;
      this.createdAt = Date.now();
    });
  }

  /**
   * Calls the {@link Resource~destroyCallback}
   * @return {Promise} Resolves after resource is destroyed.
   * @example
   * await resource.destroy();
   */
  destroy() {
    return this._destroy(this.value);
  }

  /**
   * Calls the {@link Resource~isDeadCallback} to see if the resource is dead.
   * @return {boolean}
   * @example
   * resource.isDead(); // returns false
   */
  isDead() {
    return this._isDead(this);
  }

  /**
   * Calls the {@link Resource~isIdleCallback} to see if the resource is idle.
   * @return {boolean}
   * @example
   * resource.isIdle(); // returns false
   */
  isIdle() {
    return this._isIdle(this);
  }

  /**
   * Pings the resource via {@link Resource~pingCallback}.
   * @throws Will throw if {@link Resource~pingCallback} was not provided.
   * @return {Promise} Resolves after the resource has been pinged.
   * @example
   * await resource.ping();
   */
  ping() {
    if (!this._ping) {
      throw new Error('Must provide a "ping" function to use this feature.');
    }

    return this._ping(this.value);
  }
}

module.exports = Resource;

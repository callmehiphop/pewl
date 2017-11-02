'use strict';

/**
 * Creates a new resource list.
 * @class
 * @extends Array
 * @example
 * const list = new ResourceList();
 */
class ResourceList extends Array {
  /**
   * @constructs ResourceList
   * @param {object} [options] - Configuration object.
   * @param {boolean} [options.fifo=true] - Treat the list like a stack.
   */
  constructor(options) {
    super();

    options = options || {};
    this.fifo = !!options.fifo;
  }

  /**
   * Adds an item to the list. It will add the item to the front of the list
   * if the fifo option was set to true, otherwise it will append to the end.
   * @param {Resource} resource - The resource to add.
   * @example
   * const resource = new Resource({...});
   * list.add(resource);
   */
  add(resource) {
    if (this.fifo) {
      return this.unshift(resource);
    }

    return this.push(resource);
  }

  /**
   * Removes all resources from the list.
   * @example
   * list.clear();
   */
  clear() {
    this.length = 0;
  }

  /**
   * Deletes a resource from the list.
   * @param {Resource} resource - The resource to delete.
   * @example
   * list.delete(resource);
   */
  delete(resource) {
    const index = this.indexOf(resource);

    if (index > -1) {
      return this.splice(index, 1);
    }
  }

  /**
   * Finds a resource that matches the specified properties.
   * @param {object} properties - The properties to search for.
   * @return {Resource|null}
   * @example
   * const resource = list.findWhere({ foo: 'bar' });
   */
  findWhere(properties) {
    resourceLoop: for (let i = 0; i < this.length; i++) {
      let resource = this[i];

      for (let key in properties) {
        if (properties[key] !== resource[key]) {
          continue resourceLoop;
        }
      }

      return resource;
    }

    return null;
  }
}

module.exports = ResourceList;

'use strict';

/**
 *
 */
class ResourceList extends Array {
  /**
   *
   */
  constructor(options = {}) {
    super();

    this.fifo = !!options.fifo;
  }

  /**
   *
   */
  add(resource) {
    if (this.fifo) {
      this.unshift(resource);
    } else {
      this.push(resource);
    }
  }

  /**
   *
   */
  clear() {
    this.length = 0;
  }

  /**
   *
   */
  delete(resource) {
    const index = this.indexOf(resource);

    if (index > -1) {
      return this.splice(index, 1);
    }
  }

  /**
   *
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
  }
}

module.exports = ResourceList;

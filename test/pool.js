'use strict';

const assert = require('assert');
const delay = require('delay');
const spyny = require('spyny').sandbox();

const spy = spyny.spy;

const Pool = require('../lib/pool');

class FakeResource {
  create() {
    return Promise.resolve(this);
  }
  destroy() {
    return Promise.resolve();
  }
}

describe('Pool', () => {
  const defaultOptions = {
    create: () => new FakeResource().create(),
    destroy: resource => resource.destroy()
  };

  let pool;

  beforeEach(() => {
    spyny.restore();
    pool = new Pool(defaultOptions);

    return pool.open();
  });

  afterEach(() => pool.close());

  describe('instantiating', () => {
    it('should fill the pool to the min value', () => {
      const stub = spy.on(FakeResource.prototype, 'create').passthrough();
      const min = 5;

      const options = Object.assign({ min }, defaultOptions);
      const pool = new Pool(options);

      return pool.open().then(() => {
        assert.strictEqual(pool.size, min);
        assert.strictEqual(stub.callCount, min);

        return pool.close();
      });
    });
  });

  describe('acquiring resources', () => {
    it('should create resources while under max threshold', () => {
      const stub = spy.on(FakeResource.prototype, 'create').passthrough();

      assert.strictEqual(pool.size, 0);

      return pool.acquire().then(resource => {
        assert(resource instanceof FakeResource);

        assert.strictEqual(stub.called, true);
        assert.strictEqual(pool.size, 1);

        pool.release(resource);
      });
    });

    it('should not create resources when there are available ones', () => {
      let stub;

      return pool
        .set('min', 1)
        .fill()
        .then(() => {
          assert.strictEqual(pool.size, 1);
          stub = spy.on(FakeResource.prototype, 'create').passthrough();
          return pool.acquire();
        })
        .then(resource => {
          assert.strictEqual(stub.called, false);
          assert.strictEqual(pool.size, 1);

          pool.release(resource);
        });
    });

    it('should not create a new resource if the max is hit', () => {
      let cachedResource;

      pool.set('max', 1);

      pool.acquire().then(resource => {
        cachedResource = resource;
        setTimeout(() => pool.release(resource), 500);
      });

      return pool.acquire().then(resource => {
        assert.strictEqual(resource, cachedResource);

        pool.set('max', Infinity);
        pool.release(resource);
      });
    });
  });

  describe('releasing resources', () => {
    it('should throw an error for unknown resources', () => {
      assert.throws(() => {
        pool.release({});
      }, /Unable to release unknown resource\./);
    });

    it('should release resources back to the pool', () => {
      return pool.acquire().then(resource => {
        assert.strictEqual(pool.available, 0);
        assert.strictEqual(pool.borrowed, 1);

        pool.release(resource);

        assert.strictEqual(pool.available, 1);
        assert.strictEqual(pool.borrowed, 0);
      });
    });
  });

  describe('destroying resources', () => {
    it('should throw an error for unknown resources', () => {
      assert.throws(() => {
        pool.destroy({});
      }, /Unable to destroy unknown resource\./);
    });

    it('should destroy resources', () => {
      let stub;

      return pool.acquire().then(resource => {
        assert.strictEqual(pool.size, 1);
        stub = spy.on(resource, 'destroy').passthrough();

        return pool.destroy(resource);
      }).then(() => {
        assert.strictEqual(pool.size, 0);
        assert.strictEqual(stub.called, true);
      });
    });
  });

  describe('skimming resources', () => {
    it('should destroy expired resources', () => {
      const stub = spy.on(FakeResource.prototype, 'destroy').passthrough();
      const options = Object.assign({
        diesAfter: 1000,
        min: 5,
        skimInterval: 1500
      }, defaultOptions);

      const pool = new Pool(options);

      return pool.open()
        .then(() => delay(2000))
        .then(() => {
          assert.strictEqual(stub.callCount, 5);
          return pool.close();
        });
    });

    it('should respect the maxIdle option', () => {
      const stub = spy.on(FakeResource.prototype, 'destroy').passthrough();
      const options = Object.assign({
        idlesAfter: 1000,
        maxIdle: 1,
        min: 5,
        skimInterval: 1500
      }, defaultOptions);

      const pool = new Pool(options);

      return pool.open()
        .then(() => {
          pool.set('min', 0)
          return delay(1100);
        })
        .then(() => {
          assert.strictEqual(pool.size, 5);
          assert.strictEqual(pool.idle, 5);
          return delay(900);
        })
        .then(() => {
          assert.strictEqual(stub.callCount, 4);
          assert.strictEqual(pool.size, 1);
          assert.strictEqual(pool.idle, 1);
          return pool.close();
        });
    });
  });

  describe('pinging resources', () => {
    it('should ping the resources', () => {
      const ping = spy(resource => {
        assert(resource instanceof FakeResource);
        return Promise.resolve();
      });

      const options = Object.assign({
        idlesAfter: 500,
        min: 5,
        ping,
        pingInterval: 1000
      }, defaultOptions);

      const pool = new Pool(options);

      return pool.open()
        .then(() => delay(600))
        .then(() => {
          return pool.acquire().then(resource => pool.release(resource));
        })
        .then(() => delay(500))
        .then(() => {
          assert.strictEqual(ping.callCount, 4);
          return delay(1000);
        })
        .then(() => {
          assert.strictEqual(ping.callCount, 9);
          return pool.close();
        });
    });
  });
});

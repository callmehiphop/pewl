'use strict';

const assert = require('assert');
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

  const pool = new Pool(defaultOptions);

  beforeEach(() => spyny.restore());
  after(() => pool.close());

  describe('instantiating', () => {
    it('should throw an error if "create" is missing', () => {
      assert.throws(() => {
        new Pool();
      }, /Both \"create\" and \"destroy\" methods are required\./);
    });

    it('should throw an error if "destroy" is missing', () => {
      assert.throws(() => {
        new Pool({ create: defaultOptions.create });
      }, /Both \"create\" and \"destroy\" methods are required\./);
    });

    it('should not auto start the pool when specified', () => {
      const stub = spy.on(Pool.prototype, 'open').passthrough();
      const options = Object.assign({ autoStart: false }, defaultOptions);
      const pool = new Pool(options);

      assert.strictEqual(stub.called, false);
    });

    it('should fill the pool to the min value', () => {
      const stub = spy.on(FakeResource.prototype, 'create').passthrough();
      const min = 5;

      const options = Object.assign({ autoStart: false, min }, defaultOptions);
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
      const stub = spy.on(FakeResource.prototype, 'create').passthrough();

      assert.strictEqual(pool.size, 1);

      return pool.acquire().then(resource => {
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
      assert.strictEqual(pool.available, 1);
      assert.strictEqual(pool.borrowed, 0);

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
        autoStart: false,
        diesAfter: 1000,
        min: 5,
        skimInterval: 1500
      }, defaultOptions);

      const pool = new Pool(options);

      return pool.open()
        .then(() => wait(2000))
        .then(() => {
          assert.strictEqual(stub.callCount, 5);
          return pool.close();
        });
    });

    it('should respect the maxIdle option', () => {
      const stub = spy.on(FakeResource.prototype, 'destroy').passthrough();
      const options = Object.assign({
        autoStart: false,
        idlesAfter: 1000,
        maxIdle: 1,
        min: 5,
        skimInterval: 1500
      }, defaultOptions);

      const pool = new Pool(options);

      return pool.open()
        .then(() => {
          pool.set('min', 0)
          return wait(1100);
        })
        .then(() => {
          assert.strictEqual(pool.size, 5);
          assert.strictEqual(pool.idle, 5);
          return wait(900);
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
        autoStart: false,
        idlesAfter: 500,
        min: 5,
        ping,
        pingInterval: 1000
      }, defaultOptions);

      const pool = new Pool(options);

      return pool.open()
        .then(() => wait(600))
        .then(() => {
          return pool.acquire().then(resource => pool.release(resource));
        })
        .then(() => wait(500))
        .then(() => {
          assert.strictEqual(ping.callCount, 4);
          return wait(1000);
        })
        .then(() => {
          assert.strictEqual(ping.callCount, 9);
          return pool.close();
        });
    });
  });
});

function wait(duration) {
  return new Promise(resolve => setTimeout(resolve, duration));
}

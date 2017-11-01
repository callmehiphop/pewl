'use strict';

const assert = require('assert');
const delay = require('delay');
const spyny = require('spyny').sandbox();

const spy = spyny.spy;

const Cluster = require('../lib/cluster');
const Pool = require('../lib/pool');

class FakeResource {
  create() {
    return Promise.resolve(this);
  }
  destroy() {
    return Promise.resolve();
  }
}

class ReadOnlyFakeResource extends FakeResource {}
class ReadWriteFakeResource extends FakeResource {}

describe('Cluster', () => {
  const readPool = new Pool({
    min: 6,
    attributes: ['read'],
    create: () => new ReadOnlyFakeResource().create(),
    destroy: resource => resource.destroy()
  });

  const readWritePool = new Pool({
    min: 4,
    attributes: ['read', 'write'],
    create: () => new ReadWriteFakeResource().create(),
    destroy: resource => resource.destroy()
  });

  const cluster = new Cluster({
    pools: [readPool, readWritePool]
  });

  before(() => cluster.open());
  beforeEach(() => spyny.restore());
  after(() => cluster.close());

  describe('instantiating', () => {
    it('should give status about the cluster', () => {
      const stats = cluster.stats();

      assert.strictEqual(stats.size, 10);
      assert.strictEqual(stats.available, 10);
      assert.strictEqual(stats.borrowed, 0);

      const readOnlyStats = cluster.stats('read');

      assert.strictEqual(readOnlyStats.size, 10);
      assert.strictEqual(readOnlyStats.available, 10);
      assert.strictEqual(readOnlyStats.borrowed, 0);

      const readWriteStats = cluster.stats('write');

      assert.strictEqual(readWriteStats.size, 4);
      assert.strictEqual(readWriteStats.available, 4);
      assert.strictEqual(readWriteStats.borrowed, 0);
    });
  });

  describe('acquiring resources', () => {
    it('should acquire a resource', () => {
      return cluster.acquire().then(resource => {
        const stats = cluster.stats();

        assert(resource instanceof FakeResource);
        assert.strictEqual(stats.available, 9);
        assert.strictEqual(stats.borrowed, 1);

        cluster.release(resource);
      });
    });

    it('should accept attributes when acquiring', () => {
      return cluster.acquire({ attributes: 'write' }).then(resource => {
        const stats = cluster.stats();
        const writeStats = cluster.stats('write');

        assert(resource instanceof ReadWriteFakeResource);
        assert.strictEqual(stats.available, 9);
        assert.strictEqual(stats.borrowed, 1);
        assert.strictEqual(writeStats.available, 3);
        assert.strictEqual(writeStats.borrowed, 1);

        cluster.release(resource);
      });
    });
  });

  describe('releasing resources', () => {
    it('should throw an error for unknown resources', () => {
      assert.throws(() => {
        cluster.release({});
      }, /Unable to release unknown resource\./);
    });

    it('should release a resource to the correct pool', () => {
      return cluster.acquire({ attributes: 'write' }).then(resource => {
        const stats = cluster.stats();

        assert.strictEqual(stats.borrowed, 1);
        assert.strictEqual(readWritePool.borrowed, 1);

        cluster.release(resource);

        assert.strictEqual(stats.borrowed, 0);
        assert.strictEqual(readWritePool.borrowed, 0);
      });
    });
  });

  describe('destroying resources', () => {
    it('should throw an error for unknown resources', () => {
      assert.throws(() => {
        cluster.destroy({});
      }, /Unable to destroy unknown resource\./);
    });

    it('should destroy resources', () => {
      let cachedResource;
      let stub;

      return cluster.acquire().then(resource => {
        assert(readPool.includes(resource));

        cachedResource = resource;
        stub = spy.on(resource, 'destroy').passthrough();

        return cluster.destroy(resource);
      }).then(() => {
        assert.strictEqual(stub.called, true);
        assert.strictEqual(readPool.includes(cachedResource), false);
      });
    });
  });

  describe('skimming resources', () => {
    it('should destroy expired resources', () => {
      const stub = spy.on(FakeResource.prototype, 'destroy').passthrough();
      const cluster = new Cluster({
        diesAfter: 1000,
        skimInterval: 1500,
        pools: [createGenericPool(), createGenericPool()]
      });

      return cluster.open()
        .then(() => delay(2000))
        .then(() => {
          assert.strictEqual(stub.callCount, 10);
          return cluster.close();
        })
    });
  });

  describe('pinging resources', () => {
    it('should ping the resources', () => {
      const ping = spy(resource => {
        assert(resource instanceof FakeResource);
        return Promise.resolve();
      });

      const pools = [createGenericPool(), createGenericPool()];

      const cluster = new Cluster({
        idlesAfter: 500,
        pingInterval: 1000,
        pools,
        ping
      });

      return cluster.open()
        .then(() => delay(600))
        .then(() => {
          return Promise.all(
            pools.map(pool => {
              return pool.acquire().then(resource => pool.release(resource));
            })
          );
        })
        .then(() => delay(500))
        .then(() => {
          assert.strictEqual(ping.callCount, 8);
          return delay(1000);
        })
        .then(() => {
          assert.strictEqual(ping.callCount, 18);
          return cluster.close();
        });
    });
  });

  function createGenericPool() {
    return new Pool({
      min: 5,
      create: () => new FakeResource().create(),
      destroy: resource => resource.destroy()
    });
  }
});

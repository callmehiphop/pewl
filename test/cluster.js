import delay from 'delay';
import inRange from 'in-range';
import spyny from 'spyny';
import test from 'ava';
import timeSpan from 'time-span';
import Pool, {Cluster} from '../';

class FakeResource {
  create() {
    return Promise.resolve(this);
  }
  destroy() {
    return Promise.resolve();
  }
}

class ReadOnlyResource extends FakeResource {}
class ReadWriteResource extends FakeResource {}

async function createCluster(options = {}) {
  const readOnlyPool = createPool({
    attributes: ['r'],
    create: () => new ReadOnlyResource().create(),
  });

  const readWritePool = createPool({
    attributes: ['r', 'w'],
    create: () => new ReadWriteResource().create(),
  });

  const cluster = new Cluster(
    Object.assign(
      {
        pools: [readOnlyPool, readWritePool],
      },
      options
    )
  );

  if (options.open !== false) {
    await cluster.open();
  }

  return {
    readOnlyPool,
    readWritePool,
    cluster,
  };
}

function createPool(options = {}) {
  return new Pool(
    Object.assign(
      {
        create: () => new FakeResource().create(),
        destroy: resource => resource.destroy(),
      },
      options
    )
  );
}

function isAround(actual, around) {
  return inRange(actual, around - 10, around + 50);
}

test('acquire()', async t => {
  t.plan(4);

  const {cluster} = await createCluster();
  const resource = await cluster.acquire();

  t.true(resource instanceof ReadOnlyResource);
  t.is(cluster.size, 1);
  t.is(cluster.available, 0);
  t.is(cluster.borrowed, 1);
});

test('acquire() - by attributes', async t => {
  t.plan(1);

  const {cluster} = await createCluster();
  const resource = await cluster.acquire({attributes: ['w']});

  t.true(resource instanceof ReadWriteResource);
});

test('acquire() - no available resources', async t => {
  t.plan(2);

  const {readOnlyPool, readWritePool, cluster} = await createCluster();
  const resource = await cluster.acquire();

  readOnlyPool.set('max', readOnlyPool.size);
  readWritePool.set('max', readWritePool.size);

  setTimeout(() => cluster.release(resource), 500);

  const end = timeSpan();
  const nextResource = await cluster.acquire();

  t.is(nextResource, resource);
  t.true(isAround(end(), 500));
});

test('acquire() - timeout error', async t => {
  t.plan(3);

  const {readOnlyPool, readWritePool, cluster} = await createCluster({
    acquireTimeout: 500,
  });

  readOnlyPool.set('max', 0);
  readWritePool.set('max', 0);

  const end = timeSpan();
  const error = await t.throws(cluster.acquire());

  t.is(error.message, 'No resources available.');
  t.true(isAround(end(), 500));
});

test('acquire() - closed error', async t => {
  t.plan(2);

  const {cluster} = await createCluster();
  await cluster.close();

  const error = t.throws(() => cluster.acquire());

  t.is(error.message, 'The pool has been closed.');
});

test('acquire() - async closed error', async t => {
  t.plan(3);

  const {readOnlyPool, readWritePool, cluster} = await createCluster();

  readOnlyPool.set('max', 0);
  readWritePool.set('max', 0);

  setTimeout(() => cluster.close(), 500);

  const end = timeSpan();
  const error = await t.throws(cluster.acquire());

  t.is(error.message, 'The pool has been closed.');
  t.true(isAround(end(), 500));
});

test('acquire() - create error', async t => {
  t.plan(2);

  const createError = new Error('ohnoes');
  const {readOnlyPool, cluster} = await createCluster();

  readOnlyPool.set('create', () => Promise.reject(createError));
  const error = await t.throws(cluster.acquire());

  t.is(error, createError);
});

test('acquire() - bad attributes', async t => {
  t.plan(2);

  const {cluster} = await createCluster();
  const error = await t.throws(cluster.acquire({attributes: ['nope']}));

  t.is(error.message, 'No pools found with attribute(s) "nope".');
});

test('acquire() - empty cluster', async t => {
  t.plan(2);

  const cluster = new Cluster();
  await cluster.open();

  const error = await t.throws(cluster.acquire());

  t.is(error.message, 'No pools found in cluster.');
});

test('add()', async t => {
  t.plan(1);

  const cluster = new Cluster();
  const pool = createPool();

  cluster.add(pool);

  t.true(cluster.pools.indexOf(pool) > -1);
});

test('add() - shared options', async t => {
  const clusterOptions = {
    acquireTimeout: 20000,
    diesAfter: 60000,
    fifo: false,
    idlesAfter: 30000,
    ping: () => Promise.resolve(),
    isDead: () => false,
    isIdle: () => true,
  };

  t.plan(Object.keys(clusterOptions).length);

  const cluster = new Cluster(clusterOptions);
  const pool = createPool();

  cluster.add(pool);

  for (let option in clusterOptions) {
    let poolValue = pool.get(option);
    let clusterValue = cluster.get(option);

    t.is(poolValue, clusterValue);
  }
});

test('add() - proxying events', async t => {
  const events = [
    'available',
    'createError',
    'destroyed',
    'destroyError',
    'pingError',
  ];

  t.plan(events.length);

  const cluster = new Cluster();
  const pool = createPool();

  cluster.add(pool);

  events.forEach(event => {
    cluster.on(event, (...args) => {
      t.deepEqual(args, ['a', 'b', 'c']);
    });

    pool.emit(event, 'a', 'b', 'c');
  });
});

test('close()', async t => {
  t.plan(4);

  const cluster = new Cluster({
    pools: [createPool({min: 4}), createPool({min: 6})],
  });

  const spies = cluster.pools.map(pool => {
    return spyny.on(pool, 'close').passthrough();
  });

  await cluster.open();
  t.is(cluster.size, 10);

  await cluster.close();
  t.is(cluster.size, 0);

  spies.forEach(spy => {
    t.is(spy.callCount, 1);
  });
});

test('close() - clears queue', async t => {
  t.plan(2);

  const poolOptions = {
    min: 5,
    create: () => delay(100).then(() => new FakeResource().create()),
  };

  const cluster = new Cluster({
    pools: [createPool(poolOptions), createPool(poolOptions)],
  });

  const end = timeSpan();

  cluster.open();
  await cluster.close();

  t.true(isAround(end(), 100));
  t.is(cluster.size, 0);
});

test('destroy()', async t => {
  t.plan(3);

  const {cluster} = await createCluster();
  const resource = await cluster.acquire();

  spyny.on(resource, 'destroy').passthrough();

  t.true(cluster.includes(resource));
  await cluster.destroy(resource);
  t.false(cluster.includes(resource));
  t.is(resource.destroy.callCount, 1);
});

test('destroy() - unknown', async t => {
  t.plan(2);

  const {cluster} = await createCluster();
  const error = t.throws(() => cluster.destroy({}));

  t.is(error.message, 'Unable to destroy unknown resource.');
});

test('includes()', async t => {
  t.plan(1);

  const {cluster} = await createCluster();
  const resource = await cluster.acquire();

  t.true(cluster.includes(resource));
});

test('includes() - unknown', async t => {
  t.plan(1);

  const {cluster} = await createCluster();

  t.false(cluster.includes({}));
});

test('open()', async t => {
  t.plan(4);

  const cluster = new Cluster({
    pools: [createPool({min: 4}), createPool({min: 6})],
  });

  const spies = cluster.pools.map(pool => {
    return spyny.on(pool, 'open').passthrough();
  });

  t.is(cluster.size, 0);
  await cluster.open();
  t.is(cluster.size, 10);

  spies.forEach(spy => {
    t.is(spy.callCount, 1);
  });
});

test('open() - open pools', async t => {
  t.plan(5);

  const openPool = createPool();
  const closedPool = createPool();

  const cluster = new Cluster({
    pools: [openPool, closedPool],
  });

  await openPool.open();

  spyny.on(openPool, 'open').passthrough();
  spyny.on(closedPool, 'open').passthrough();

  await cluster.open();

  t.true(cluster.isOpen);
  t.true(openPool.isOpen);
  t.is(openPool.open.callCount, 0);
  t.true(closedPool.isOpen);
  t.is(closedPool.open.callCount, 1);
});

test('release()', async t => {
  t.plan(4);

  const {cluster} = await createCluster();
  const resource = await cluster.acquire();

  t.is(cluster.available, 0);
  t.is(cluster.borrowed, 1);

  cluster.release(resource);

  t.is(cluster.available, 1);
  t.is(cluster.borrowed, 0);
});

test('release() - unknown', async t => {
  t.plan(2);

  const {cluster} = await createCluster();
  const error = t.throws(() => cluster.release({}));

  t.is(error.message, 'Unable to release unknown resource.');
});

test('stats()', async t => {
  t.plan(3);

  const {cluster} = await createCluster();

  await Promise.all(
    cluster.pools.map(pool => {
      return pool.set('min', 5).fill();
    })
  );

  const stats = cluster.stats();

  t.is(stats.available, 10);
  t.is(stats.borrowed, 0);
  t.is(stats.size, 10);
});

test('stats() - with borrowed resources', async t => {
  t.plan(9);

  const {cluster} = await createCluster();
  const stats = cluster.stats();

  const readResource = await cluster.acquire();
  const writeResource = await cluster.acquire({attributes: ['w']});

  t.is(stats.available, 0);
  t.is(stats.borrowed, 2);
  t.is(stats.size, 2);

  cluster.release(readResource);

  t.is(stats.available, 1);
  t.is(stats.borrowed, 1);
  t.is(stats.size, 2);

  cluster.release(writeResource);

  t.is(stats.available, 2);
  t.is(stats.borrowed, 0);
  t.is(stats.size, 2);
});

test('stats() - idle resources', async t => {
  t.plan(3);

  const {cluster} = await createCluster({idlesAfter: 1000});
  const stats = cluster.stats();

  await Promise.all(
    cluster.pools.map(pool => {
      return pool.set('min', 5).fill();
    })
  );

  t.is(stats.idle, 0);
  await delay(1000);
  t.is(stats.idle, 10);

  const resource = await cluster.acquire();
  t.is(stats.idle, 9);
});

test('stats() - by attributes', async t => {
  t.plan(2);

  const {cluster} = await createCluster({idlesAfter: 1000});
  const stats = cluster.stats(['w']);

  await Promise.all(
    cluster.pools.map(pool => {
      return pool.set('min', 5).fill();
    })
  );

  t.is(cluster.size, 10);
  t.is(stats.size, 5);
});

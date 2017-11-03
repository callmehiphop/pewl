import delay from 'delay';
import inRange from 'in-range';
import spyny from 'spyny';
import test from 'ava';
import timeSpan from 'time-span';
import Pool from '../';

class FakeResource {
  create() {
    return Promise.resolve(this);
  }
  destroy() {
    return Promise.resolve();
  }
}

async function createPool(options = {}) {
  const pool = new Pool(
    Object.assign(
      {
        create: () => new FakeResource().create(),
        destroy: resource => resource.destroy(),
      },
      options
    )
  );

  if (options.open !== false) {
    await pool.open();
  }

  return pool;
}

function isAround(actual, around) {
  return inRange(actual, around - 10, around + 50);
}

test('acquire()', async t => {
  t.plan(4);

  const pool = await createPool();
  const resource = await pool.acquire();

  t.true(resource instanceof FakeResource);
  t.is(pool.size, 1);
  t.is(pool.available, 0);
  t.is(pool.borrowed, 1);
});

test('acquire() - no available resources', async t => {
  t.plan(2);

  const pool = await createPool({max: 1});
  const resource = await pool.acquire();

  setTimeout(() => pool.release(resource), 500);

  const end = timeSpan();
  const nextResource = await pool.acquire();

  t.is(nextResource, resource);
  t.true(isAround(end(), 500));
});

test('acquire() - timeout error', async t => {
  t.plan(3);

  const pool = await createPool({acquireTimeout: 500, max: 0});
  const end = timeSpan();
  const error = await t.throws(pool.acquire());

  t.is(error.message, 'No resources available.');
  t.true(isAround(end(), 500));
});

test('acquire() - closed error', async t => {
  t.plan(2);

  const pool = await createPool();
  await pool.close();

  const error = t.throws(() => pool.acquire());

  t.is(error.message, 'The pool has been closed.');
});

test('acquire() - async closed error', async t => {
  t.plan(3);

  const pool = await createPool({max: 0});

  setTimeout(() => pool.close(), 500);

  const end = timeSpan();
  const error = await t.throws(pool.acquire());

  t.is(error.message, 'The pool has been closed.');
  t.true(isAround(end(), 500));
});

test('acquire() - create error', async t => {
  t.plan(2);

  const createError = new Error('ohnoes');
  const pool = await createPool({
    create: () => Promise.reject(createError),
  });
  const error = await t.throws(pool.acquire());

  t.is(error, createError);
});

test('close()', async t => {
  t.plan(6);

  const pool = await createPool({min: 5});

  t.true(pool.isOpen);
  t.is(pool.size, 5);
  t.is(pool.available, 5);

  await pool.close();

  t.false(pool.isOpen);
  t.is(pool.size, 0);
  t.is(pool.available, 0);
});

test('close() - clears queue', async t => {
  t.plan(2);

  const pool = await createPool({
    create: () => delay(100).then(() => new FakeResource().create()),
  });

  const end = timeSpan();

  pool.set('min', 5).fill();
  await pool.close();

  t.true(isAround(end(), 100));
  t.is(pool.size, 0);
});

test('destroy()', async t => {
  t.plan(3);

  const pool = await createPool();
  const resource = await pool.acquire();

  spyny.on(resource, 'destroy').passthrough();

  t.true(pool.includes(resource));
  await pool.destroy(resource);
  t.false(pool.includes(resource));
  t.is(resource.destroy.callCount, 1);
});

test('destroy() - available', async t => {
  t.plan(2);

  const pool = await createPool();
  const resource = await pool.acquire();

  pool.release(resource);
  t.true(pool.includes(resource));
  pool.destroy(resource);
  t.false(pool.includes(resource));
});

test('destroy() - unknown', async t => {
  t.plan(2);

  const pool = await createPool();
  const error = t.throws(() => pool.destroy({}));

  t.is(error.message, 'Unable to destroy unknown resource.');
});

test('destroy() - error', async t => {
  t.plan(2);

  const destroyErr = new Error('ohnoes');
  const pool = await createPool({
    destroy: () => Promise.reject(destroyErr),
  });
  const resource = await pool.acquire();
  const end = timeSpan();

  pool.on('destroyError', (err, rsrc) => {
    t.is(err, destroyErr);
    t.is(rsrc, resource);
  });

  await pool.destroy(resource);
});

test('drain()', async t => {
  t.plan(2);

  const pool = await createPool({min: 5});

  t.is(pool.size, 5);

  await pool.drain();

  t.is(pool.size, 0);
});

test('fill()', async t => {
  t.plan(2);

  const pool = await createPool();

  t.is(pool.size, 0);
  pool.set('min', 5);
  await pool.fill();
  t.is(pool.size, 5);
});

test('fill() - already filled', async t => {
  t.plan(2);

  const pool = await createPool({min: 5});

  t.is(pool.size, 5);
  await pool.fill();
  t.is(pool.size, 5);
});

test('includes()', async t => {
  t.plan(1);

  const pool = await createPool();
  const resource = await pool.acquire();

  t.true(pool.includes(resource));
});

test('includes() - available', async t => {
  t.plan(1);

  const pool = await createPool();
  const resource = await pool.acquire();

  pool.release(resource);
  t.true(pool.includes(resource));
});

test('includes() - unknown', async t => {
  t.plan(1);

  const pool = await createPool();
  t.false(pool.includes({}));
});

test('open()', async t => {
  t.plan(4);

  const pool = await createPool({open: false, min: 5});

  t.false(pool.isOpen);
  t.is(pool.size, 0);

  await pool.open();

  t.true(pool.isOpen);
  t.is(pool.size, 5);
});

test('release()', async t => {
  t.plan(4);

  const pool = await createPool();
  const resource = await pool.acquire();

  t.is(pool.borrowed, 1);
  t.is(pool.available, 0);

  pool.release(resource);

  t.is(pool.borrowed, 0);
  t.is(pool.available, 1);
});

test('release() - unknown', async t => {
  t.plan(2);

  const pool = await createPool();
  const error = t.throws(() => pool.release({}));

  t.is(error.message, 'Unable to release unknown resource.');
});

test('pinging resources', async t => {
  t.plan(2);

  const spy = spyny(() => Promise.resolve());
  const pool = await createPool({
    ping: spy,
    min: 2,
    pingInterval: 1000,
    idlesAfter: 600,
  });

  await delay(500);
  // check 1 out so its not considered idle
  const resource = await pool.acquire();
  pool.release(resource);
  await delay(500);

  t.is(spy.callCount, 1);
  await delay(1000);

  t.is(spy.callCount, 3);
  await pool.close();
});

test('pinging resources - error', async t => {
  t.plan(3);

  const pingError = new Error('ohnoes');
  const spy = spyny(() => Promise.reject(pingError));
  const pool = await createPool({
    ping: spy,
    min: 1,
    pingInterval: 500,
    idlesAfter: 400,
  });

  pool.on('pingError', (err, resource) => {
    t.is(err, pingError);
    t.true(resource instanceof FakeResource);
    t.false(pool.includes(resource));
  });

  await delay(550);
  await pool.close();
});

test('skimming resources - dead', async t => {
  t.plan(4);

  const spy = spyny(() => Promise.resolve());
  const pool = await createPool({
    min: 5,
    skimInterval: 500,
    diesAfter: 400,
    destroy: spy,
  });

  await delay(600);
  t.is(spy.callCount, 5);
  t.is(pool.size, 5);

  await delay(600);
  t.is(spy.callCount, 10);
  t.is(pool.size, 5);

  await pool.close();
});

test('skimming resources - idle', async t => {
  t.plan(6);

  const spy = spyny(() => Promise.resolve());
  const pool = await createPool({
    min: 10,
    maxIdle: 0,
    skimInterval: 500,
    idlesAfter: 400,
    destroy: spy,
  });

  pool.set('min', 5);
  await delay(600);
  t.is(spy.callCount, 5);
  t.is(pool.size, 5);

  await delay(600);
  t.is(spy.callCount, 5);
  t.is(pool.size, 5);

  pool.set('min', 0);
  await delay(600);
  t.is(spy.callCount, 10);
  t.is(pool.size, 0);

  await pool.close();
});

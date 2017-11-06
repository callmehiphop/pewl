# Pewl [![CircleCI](https://img.shields.io/circleci/project/github/callmehiphop/pewl.svg?style=flat)](https://circleci.com/gh/callmehiphop/pewl)

> Generic pooling library

Useful for managing resources like database connections.

## Install

```sh
$ npm install pewl
```

## Usage

Here's a simple example of how to get up and running with `pewl`.

```js
const Pool = require('pewl');

// create a Pool instance.
const pool = new Pool({
  create: () => asyncFuncThatCreatesResource(),
  destroy: resource => asyncFuncThatDestroysResource(resource)
});

// open the pool
await pool.open();

// get a resource from the pool
const resource = await pool.acquire();

// return the resource to the pool
pool.release(resource);

// close the pool when finished
await pool.close();
```

## API

### Pool([options])

Returns a new `pool` instance.

#### options

Type: `Object`

##### acquireTimeout

Type: `number`
Default: `Infinity`

Duration to wait before rejecting acquire request.

##### attributes

Type: `string[]`

Attributes used to describe the Pool when using a Cluster.

##### concurrency

Type: `number`
Default: `Infinity`

Concurrency limit for making resource requests.

##### create

Type: `Function`

Function that returns a Promise that resolves with a resource.

##### destroy

Type: `Function`

Accepts a resource value and attempts to destroy it, returning a promise upon
completion.

##### diesAfter

Type: `number`
Default: `Infinity`

Marks a resource as *dead* after this duration.

##### fifo

Type: `boolean`
Default: `true`

Treats the Pool like a stack (as opposed to a queue).

##### idlesAfter

Type: `number`
Default: `600000`

Marks a resource as *idle* after this duration.

##### isDead

Type: `Function`

Accepts a Resource object and returns a boolean stating whether or not the
resource is dead.

##### isIdle

Type: `Function`

Accepts a Resource object and returns a boolean stating whether or not the
resource is idle.

##### max

Type: `number`
Default: `Infinity`

Maximum number of resources the pool can create.

##### maxIdle

Type: `number`
Default: `Infinity`

Maximum number of idle resources the pool can contain with respect to the `min`
and `max` options.

##### min

Type: `number`
Default: `0`

Minimum number of resources that must be in the pool at all times.

##### ping

Type: `Function`

Accepts a resource value and attempts to ping it, returning a promise upon
completion.

##### pingInterval

Type: `number`
Default: `600000`

Frequency to ping idle resources.

##### skimInterval

Type: `number`

Frequency to check for and dispose of dead and idle resources with respect to
the `min` and `max` options.

### Pool#acquire([options])

Returns a promise that settles when a resource is acquired.

#### options

Type: `Object`

##### priority

Type: `Number`
Default: `0`

Priority of operation. Operations with greater priority will be schedule first.

### Pool#close()

Returns a promise that settles once all resources have been destroyed.

### Pool#destroy(resource)

Returns a promise that settles once the suppled resource is destroyed.

### Pool#open()

Returns a promise that settles once the pool is opened and filled to the `min`
value.

### Pool#release(resource)

Releases a resource back into the pool.

### Pool#available

Number of available resources.

### Pool#borrowed

Number of borrowed resources.

### Pool#idle

Number of idle resources.

### Pool#size

Total number of resources in pool.

### Cluster([options])

Returns a new `cluster` instance.

#### options

Type: `Object`

Options to be applied to all `pool` instances within the cluster.

##### acquireTimeout

Type: `number`
Default: `Infinity`

Duration to wait before rejecting acquire request.

##### concurrency

Type: `number`
Default: `Infinity`

Concurrency limit for making resource requests.

##### diesAfter

Type: `number`
Default: `Infinity`

Marks a resource as *dead* after this duration.

##### fifo

Type: `boolean`
Default: `true`

Treats the Pool like a stack (as opposed to a queue).

##### idlesAfter

Type: `number`
Default: `600000`

Marks a resource as *idle* after this duration.

##### ping

Type: `Function`

Accepts a resource value and attempts to ping it, returning a promise upon
completion.

##### pingInterval

Type: `number`
Default: `600000`

Frequency to ping idle resources.

##### pools

Type: `Pool[]`

List of `pool` instances.

##### skimInterval

Type: `number`

Frequency to check for and dispose of dead and idle resources with respect to
the `min` and `max` options.

### Cluster#acquire([options])

Returns a promise that settles when a resource is acquired.

#### options

Type: `Object`

##### attributes

Type: `string[]`

List of attributes that the resource must have.

##### priority

Type: `number`
Default: `0`

Priority of operation. Operations with greater priority will be schedule first.

### Cluster#add(pool)

Adds a `pool` instance to the cluster.

### Cluster#close()

Returns a promise that settles once the cluster and all the `pool` instances
have been closed.

### Cluster#destroy(resource)

Destroys the provided resource.

### Cluster#open()

Returns a promise that settles once all the `pool` instances have been opened
and filled.


### Cluster#release(resource)

Releases the resource back into the cluster.

### Cluster#stats([attributes])

Gets a `ClusterStats` object for the cluster resources.

#### attributes

Type: `String[]`

Attributes to apply to the stats.

## Managing multiple Pools

```js
const Pool = require('pewl');

// create a pool of read-only resources
const readPool = new Pool({
  attributes: ['r'],
  ...
});

// create a pool of read-write resources
const readWritePool = new Pool({
  attributes: ['r', 'w'],
  ...
});

// create a cluster to manage both pools
const cluster = new Pool.Cluster({
  pools: [readPool, readWritePool]
});

// start all the things!
await cluster.open();

// acquire the first available resource
const readOnlyResource = await cluster.acquire();

// release the resource back into the cluster
cluster.release(readOnlyResource);

// acquire a write capable resource
const readWriteResource = await cluster.acquire({ attributes: ['w'] });

// destroy the write capable resource
cluster.destroy(readWriteResource);

// close all the things!
await cluster.close();
```

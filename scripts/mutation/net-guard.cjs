'use strict';

// Loaded into every test process the harness starts (NODE_OPTIONS --require).
// The tests are offline; this makes sure a mutated copy cannot reach a network,
// including Google. A blocked attempt fails the test and is reported as ERROR.

const net = require('node:net');
const dns = require('node:dns');

const blocked = (what) => () => { throw new Error(`mutation harness: network access is blocked (${what})`); };

net.Socket.prototype.connect = blocked('socket connect');
dns.lookup = blocked('dns lookup');
if (typeof globalThis.fetch === 'function') globalThis.fetch = blocked('fetch');

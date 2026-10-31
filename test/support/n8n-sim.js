'use strict';

// A small interpreter for the subset of n8n the SheetOps workflow uses: the
// manual and schedule triggers, Set 3.4, Code 2 (run once for all items), HTTP
// Request 4.2, Switch 3.2 in expression mode and Wait. It executes the real
// workflow JSON, including the real Code-node source, against a fake Google.
// Items are passed through JSON between nodes, as n8n does. It is a test
// double: scripts/verify-in-n8n.js replays recorded runs in the real engine.

const vm = require('node:vm');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

class NodeFailure extends Error {
  constructor(node, message) {
    super(`${node}: ${message}`);
    this.node = node;
  }
}

function runWorkflow(workflow, options) {
  const google = options.google;
  const now = options.now;
  const executionId = String(options.executionId || '1');
  const nodes = new Map(workflow.nodes.map((node) => [node.name, node]));
  const outputs = new Map();
  const order = [];

  const accessor = (name) => {
    if (!nodes.has(name)) throw new Error(`Referenced node "${name}" does not exist`);
    const items = outputs.get(name);
    const require = () => {
      if (!items) throw new Error(`Referenced node "${name}" is unexecuted`);
      return items;
    };
    return {
      get isExecuted() { return outputs.has(name); },
      first: () => clone(require()[0]),
      all: () => clone(require()),
    };
  };

  const evaluate = (value, item) => {
    if (typeof value !== 'string' || !value.startsWith('=')) return value;
    const template = value.slice(1);
    const run = (expression) => new Function('$json', '$', `return (${expression});`)(clone(item.json), accessor);
    const whole = /^\{\{([\s\S]*)\}\}$/.exec(template.trim());
    if (whole) return run(whole[1]);
    return template.replace(/\{\{([\s\S]*?)\}\}/g, (match, expression) => String(run(expression)));
  };

  const executors = {
    'n8n-nodes-base.manualTrigger': () => [[{ json: {} }]],
    'n8n-nodes-base.scheduleTrigger': () => [[{ json: {} }]],
    'n8n-nodes-base.set': (node, items) => {
      const json = node.parameters.includeOtherFields ? clone(items[0].json) : {};
      for (const assignment of node.parameters.assignments.assignments) {
        const value = evaluate(assignment.value, items[0]);
        json[assignment.name] = assignment.type === 'boolean' ? value === true || value === 'true' : (assignment.type === 'string' ? String(value) : value);
      }
      return [[{ json }]];
    },
    'n8n-nodes-base.code': (node, items) => {
      const context = vm.createContext({
        $input: { all: () => clone(items), first: () => clone(items[0]), last: () => clone(items[items.length - 1]) },
        $: accessor,
        $execution: { id: executionId },
        $now: { toUTC: () => ({ toISO: () => now }) },
      });
      const result = vm.runInContext(`(function () {\n${node.parameters.jsCode}\n})()`, context, { filename: node.name });
      if (!Array.isArray(result) || result.some((item) => !item || typeof item.json !== 'object')) {
        throw new NodeFailure(node.name, 'Code node did not return [{ json }] items');
      }
      return [clone(result)];
    },
    'n8n-nodes-base.httpRequest': (node, items) => {
      const p = node.parameters;
      const response = (p.options && p.options.response && p.options.response.response) || {};
      const url = evaluate(p.url, items[0]);
      const body = p.sendBody ? JSON.parse(evaluate(p.jsonBody, items[0])) : undefined;
      const tries = node.retryOnFail ? node.maxTries : 1;
      let failure = null;
      for (let attempt = 0; attempt < tries; attempt += 1) {
        try {
          const reply = google.request({ method: p.method, url, body, node: node.name });
          if (reply.status >= 400 && !response.neverError) {
            failure = { message: `${reply.status} - ${JSON.stringify(reply.body)}`, httpCode: String(reply.status) };
            continue;
          }
          const property = response.outputPropertyName || 'data';
          let json;
          if (response.responseFormat === 'text') {
            const text = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
            json = response.fullResponse
              ? { [property]: text, headers: {}, statusCode: reply.status, statusMessage: reply.statusMessage || '' }
              : { [property]: text };
          } else {
            json = response.fullResponse
              ? { body: reply.body === undefined ? {} : reply.body, headers: {}, statusCode: reply.status, statusMessage: reply.statusMessage || '' }
              : reply.body;
          }
          return [[{ json: clone(json) }]];
        } catch (err) {
          if (!err.code) throw err;
          failure = { message: err.message, code: err.code };
        }
      }
      if (node.onError === 'continueRegularOutput') return [[{ json: { error: failure } }]];
      throw new NodeFailure(node.name, failure.message);
    },
    'n8n-nodes-base.switch': (node, items) => {
      const p = node.parameters;
      if (p.mode !== 'expression') throw new NodeFailure(node.name, 'only expression mode is simulated');
      const index = evaluate(p.output, items[0]);
      if (!Number.isInteger(index) || index < 0 || index >= p.numberOutputs) {
        throw new NodeFailure(node.name, `output index ${index} is out of range`);
      }
      return Array.from({ length: p.numberOutputs }, (unused, i) => (i === index ? clone(items) : []));
    },
    'n8n-nodes-base.wait': (node, items) => {
      if (options.onWait) options.onWait(node.name);
      return [clone(items)];
    },
  };

  const queue = [{ name: options.trigger, items: [{ json: {} }] }];
  while (queue.length > 0) {
    const { name, items } = queue.shift();
    const node = nodes.get(name);
    const execute = executors[node.type];
    if (!execute) throw new Error(`Node type ${node.type} is not simulated`);
    let produced;
    try {
      produced = execute(node, items);
    } catch (err) {
      order.push(name);
      return { order, outputs, error: err instanceof NodeFailure ? err : new NodeFailure(name, err.message) };
    }
    order.push(name);
    outputs.set(name, [].concat(...produced));
    const links = (workflow.connections[name] && workflow.connections[name].main) || [];
    produced.forEach((outItems, index) => {
      if (outItems.length === 0) return;
      for (const link of links[index] || []) queue.push({ name: link.node, items: outItems });
    });
  }
  return { order, outputs, error: null };
}

module.exports = { runWorkflow, NodeFailure };

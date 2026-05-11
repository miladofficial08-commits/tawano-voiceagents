const { getStore } = require('@netlify/blobs');

const STORE = getStore('tawano-live-data');
const KEYS = {
  analytics: 'analytics-events',
  calls: 'debug-calls',
};

const LIMITS = {
  analytics: 10000,
  calls: 500,
};

async function readArray(key) {
  const data = await STORE.get(key, { type: 'json' });
  return Array.isArray(data) ? data : [];
}

async function appendLimited(key, item, maxSize) {
  const list = await readArray(key);
  list.push(item);
  if (list.length > maxSize) {
    list.splice(0, list.length - maxSize);
  }
  await STORE.setJSON(key, list);
  return list;
}

module.exports = {
  KEYS,
  LIMITS,
  readArray,
  appendLimited,
};

// A child for tests/pdf/isolation.test.ts: answers with the names in its
// environment, after waiting as long as it is told.
process.once('message', (message) => {
  setTimeout(() => process.send({ env: Object.keys(process.env) }, () => process.exit(0)), message.waitMs ?? 0);
});

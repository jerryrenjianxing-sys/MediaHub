import readline from 'node:readline';
// Protocol stdout is NDJSON only. Diagnostics must never corrupt it.
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
console.log = (...values) => process.stderr.write(values.join(' ') + '\n');
const { HyperframesAdapter } = await import('./adapter.mjs');
const adapter = new HyperframesAdapter({ onEvent: write });
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  let request;
  try {
    if (Buffer.byteLength(line) > 1024 * 1024) throw Object.assign(new Error('Request exceeds 1 MiB'), {code:'REQUEST_TOO_LARGE'});
    request = JSON.parse(line);
    if (!request || typeof request.id !== 'string' || typeof request.method !== 'string') throw Object.assign(new Error('Invalid RPC request'), {code:'INVALID_REQUEST'});
    const result = await adapter.dispatch(request.method, request.params || {});
    write({id:request.id,result});
    if (request.method === 'shutdown' || request.method === 'stop') { input.close(); setTimeout(() => process.exit(0), 50); }
  } catch (error) { write({id:request?.id ?? null,error:{code:error.code || 'TOOL_ERROR',message:error.message}}); }
});
input.on('close', () => adapter.shutdown().then(() => { if (!process.connected) process.exit(0); }));
process.on('SIGTERM', () => adapter.shutdown().then(() => process.exit(0)));
process.on('SIGINT', () => adapter.shutdown().then(() => process.exit(0)));

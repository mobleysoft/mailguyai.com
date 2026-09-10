// Test-only ESM loader hook: stubs Cloudflare Workers runtime modules
// (cloudflare:email) that plain Node can't resolve, so real production
// files (outbound.js) can be imported and tested as-shipped, without
// restructuring their imports for test convenience.
//
// Usage: node --experimental-loader ./test/cloudflare-stub-loader.mjs --test ...

const STUB_URL = 'cloudflare-stub:email';

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'cloudflare:email') {
    return { url: STUB_URL, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === STUB_URL) {
    return {
      format: 'module',
      shortCircuit: true,
      source: `
        export class EmailMessage {
          constructor(from, to, raw) {
            this.from = from;
            this.to = to;
            this.raw = raw;
          }
        }
      `,
    };
  }
  return nextLoad(url, context);
}

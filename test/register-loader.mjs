import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

register('./test/cloudflare-stub-loader.mjs', pathToFileURL('./'));

import { register } from 'node:module';

register('./test-resolver-loader.mjs', import.meta.url);

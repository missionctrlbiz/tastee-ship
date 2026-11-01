#!/usr/bin/env node
import { main } from '../lib/cli.js';

main(process.argv.slice(2)).catch((err) => {
  console.error(`tship: ${err.message}`);
  if (process.env.TSHIP_DEBUG) console.error(err.stack);
  process.exit(1);
});

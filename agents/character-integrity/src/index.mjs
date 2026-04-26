#!/usr/bin/env node
/**
 * index.mjs — CLI entrypoint for character-integrity agent.
 * Subcommands: recover, sync, normalize, dedup, integrity
 */

import { recover }    from './recover.mjs';
import { sync }       from './sync.mjs';
import { normalize }  from './normalize.mjs';
import { dedup }      from './dedup.mjs';
import { integrity }  from './integrity.mjs';
import { tickEvent }  from './acmi.mjs';

const cmd = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

const commands = { recover, sync, normalize, dedup, integrity };

if (!cmd || !commands[cmd]) {
  console.error(`Usage: character-integrity <${Object.keys(commands).join('|')}> [--dry-run]`);
  process.exit(1);
}

try {
  await commands[cmd]({ dryRun });
} catch (e) {
  await tickEvent('error', e.message).catch(() => {});
  console.error('ERROR:', e.message);
  process.exit(1);
}

/** The entry bin/build-agent-clis.sh bundles into cli-board.mjs for a client machine (see cli-remote.ts). */
import { runRemote } from './cli-remote.js';

await runRemote(process.argv.slice(2));

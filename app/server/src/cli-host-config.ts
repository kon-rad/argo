import { config } from './config.js';
import { scaffoldHostDefinition, usage } from './hosts/scaffold.js';

const args = process.argv.slice(2);
if (args.length === 1 && ['--help', '-h', 'help'].includes(args[0]!)) {
  console.log(usage);
} else {
  try {
    console.log(scaffoldHostDefinition(config.vaultRoot, args));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Could not generate the definition');
    process.exitCode = 1;
  }
}

/**
 * `secondbrain auth-setup` — creates the one login the server deployment has.
 *
 * Prompts for a password (hidden), generates a TOTP secret, shows it as a QR
 * code if `qrencode` is installed, and refuses to finish until a code from the
 * authenticator app verifies — so a mistyped secret can never lock you out.
 * Prints the three env lines to paste into the server's env file. Nothing is
 * written to disk here.
 */
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { hashPassword } from './auth/password.js';
import { generateSecret, otpauthUri, verifyTotp } from './auth/totp.js';
import { config } from './config.js';

function ask(question: string, hidden = false): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Swallow the echo: readline writes each keystroke through _writeToOutput.
      const out = rl as unknown as { _writeToOutput: (s: string) => void };
      out._writeToOutput = (s: string) => {
        if (s.startsWith(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  console.log('Second Brain — create the server login\n');

  let password = '';
  for (;;) {
    password = await ask('New password (16+ characters; a passphrase is ideal): ', true);
    if (password.length < 16) {
      console.log('  too short — use at least 16 characters.');
      continue;
    }
    const again = await ask('Repeat it: ', true);
    if (again === password) break;
    console.log("  they don't match — try again.");
  }

  const secret = generateSecret();
  const uri = otpauthUri(secret, config.ownerName);
  console.log('\nAdd this to your authenticator app (1Password, Authy, Google Authenticator, …):\n');
  try {
    process.stdout.write(execFileSync('qrencode', ['-t', 'ansiutf8', uri], { encoding: 'utf8' }));
  } catch {
    console.log('  (install qrencode to see a QR code here: brew install qrencode)');
  }
  console.log(`  or enter the key by hand: ${secret.match(/.{1,4}/g)!.join(' ')}\n`);

  for (;;) {
    const code = await ask('Enter the 6-digit code it shows now: ');
    if (verifyTotp(secret, code) !== null) break;
    console.log("  that code doesn't match — check the key was entered correctly and the phone clock is right.");
  }

  const hash = await hashPassword(password);
  console.log('\nVerified. Put these three lines in the server env file (/etc/secondbrain/env, mode 600):\n');
  console.log(`AUTH_PASSWORD_HASH=${hash}`);
  console.log(`AUTH_TOTP_SECRET=${secret}`);
  console.log(`PUBLIC_ORIGIN=${config.publicOrigin ?? 'https://<your domain or IP>'}`);
  console.log('\nThe secret is shown once. Also save it in your password manager as the recovery copy.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

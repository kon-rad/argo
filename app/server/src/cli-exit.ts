/**
 * Exit once stdout and stderr have drained. `process.exit` drops whatever is still queued on a pipe: a CLI whose JSON
 * is over 64 KiB was cut at exactly 65536 bytes when a dispatcher read it through a pipe (a file or a terminal hid it).
 */
export async function exitFlushed(code: number): Promise<void> {
  await Promise.all([process.stdout, process.stderr].map((s) => new Promise<void>((done) => s.write('', () => done()))));
  process.exit(code);
}

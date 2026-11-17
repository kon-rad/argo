/** The board's user-facing error. Its own module, so the HTTPS client bundle (cli-remote.ts) loads no database code. */
export class BoardError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 = 400) {
    super(message);
  }
}

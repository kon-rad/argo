/** The org's user-facing error, in its own module so a client bundle can throw it without loading the database. */
export class OrgError extends Error {}

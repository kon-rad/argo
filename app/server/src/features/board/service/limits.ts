/** Board limits shared by the service and the database-free CLI half (cli-core.ts), so the client bundle loads no database code. */

/** Automatic host-up retries a host-down block gets before it waits for a person (board_reclaim's max_retries). */
export const HOST_RETRIES = 3;

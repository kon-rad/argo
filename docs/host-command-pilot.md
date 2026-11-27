# Host command pilot

Use the optional `host-pilot` module to send a word-count request from the board server to an enrolled worker. The server stores requests and results in its database. The worker polls the server over HTTPS. Each request carries a string of up to 65,536 characters.

## Configure the server

Create these files in your private vault. Each filename must match its definition's ID. Both directories must exist. The worker supports the built-in `word-count` handler.

`.agents/org/config/commands/count-words.yaml`

```yaml
id: count-words
handler: word-count
```

`.agents/org/config/machines/sample-host.yaml`

```yaml
id: sample-host
enabled: true
slots: 1
commands: [count-words]
```

Add `host-pilot` to the server's configured modules and apply the engine migrations using your usual deployment process. Before enrollment, an owner previews the private YAML and applies its revision. When upgrading an existing pilot, drain workers before the upgrade, apply the existing YAML once and resume polling. Stored machine tokens and command history survive the upgrade. Later edits take effect after the owner applies them. The server loads the last applied revision from PostgreSQL across restarts.

A machine may declare `ramGiB`; a command may declare `minRamGiB`. An omitted minimum allows any otherwise eligible machine. A positive minimum requires a declared capacity that meets it. The machine's optional `allowAgentSessions` flag declares a separate permission for future session hosting; it grants zero command IDs. The module is disabled by default.

## Enroll and run the example

Use the signed-in owner's session on the board server for the owner requests below. Send same-origin JSON requests with `Content-Type: application/json`. The endpoint prefix for every row is `/api/host-pilot`.

| Caller | Method and path | Request body |
|---|---|---|
| Owner | `POST /registry/preview` | `{}` returns the current base revision, proposed revision and before/after definitions by ID. |
| Owner | `POST /registry/apply` | Echo the preview's `baseRevision` and `revision`. The base is `null` on first apply. |
| Owner | `POST /enrollment-codes` | `{"machine":"sample-host"}` |
| Worker | `POST /enroll` | `{"code":"<single-use enrollment code>"}` |
| Owner | `POST /requests` | `{"requestKey":"example-1","command":"count-words","text":"one two three"}` |
| Owner | `GET /requests/<id>` | Use the ID returned at submission. |
| Owner | `POST /revoke` | `{"machine":"sample-host"}` |

If the YAML changes after preview, or someone applies a different revision, apply returns HTTP 409. Preview again and review the new changes. Invalid YAML returns HTTP 400. In either case the previous revision continues to serve work. To restore an earlier configuration, restore those YAML files, preview them and apply against the current base.

Transfer the enrollment code privately to the target machine. Exchange it there for the worker token, then supply the token through the worker environment as `SECONDBRAIN_HOST_TOKEN`. Keep credentials out of vault YAML, command history and logs. Once the sample request is queued, run this on the enrolled machine using your own board origin:

```sh
secondbrain host-worker https://board.example --once
```

Read the request again as the owner. A successful sample returns a count of three. Reusing its request key with identical input returns the existing ID. Reusing it with different input returns HTTP 409. Omitting `--once` keeps the worker polling. Stop the worker process to stop polling. Revoke the machine to invalidate its worker access.

## Worker lifecycle and limitations

The worker sends its bearer credential to `POST /poll`, `POST /start` and `POST /finish` under the same prefix. An enabled worker takes an eligible request when a slot is free. The server records a reservation, a start receipt and a terminal result. A lost or disconnected process can leave a reserved or running request that needs operator investigation.

This pilot accepts owner-submitted inline text and returns a count. Ticket dispatch, arbitrary executable registration, file uploads, digest verification, agent permissions, OS service enrollment and a web history page belong to later milestones.

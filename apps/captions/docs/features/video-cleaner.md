# Video Cleaner

### Video Cleaner in the demo

A Cleaner run is `$DATA_DIR/clean/sources/<uuid>/` (`session.json` with `owner`, `original.<ext>`). A run owned by `demo` never expires (`expired` in `api/clean-workspace.ts`). Its results are stored beside it as `showcase.json` (`CleanShowcase`: per preset its options, the fast `score`/`sscd` answers and the full `measurement`). `GET /:id` returns it as `showcase`, and `GET /api/clean/sources/showcase` names the newest showcase run of the account.

A demo visitor's `/clean` opens that showcase and shows its stored results, with Reframe and Just clean to switch between. The settings are locked, there is no score, frame or measure request, and nothing that uploads, renders, downloads, deletes, compares or sends on is offered (`demo` in `CleanPage.tsx`).

The full guide to what the Cleaner measures and changes is in [Video Cleaner — what it does and how it cleans](../video-cleaner/README.md).

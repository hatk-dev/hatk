# hatk as the appview for a spaces-based app

Analysis, 2026-09-17. What hatk would need to serve `~/code/opensocial/apps/community`
(or any app whose data lives in permissioned spaces) as its appview. Cites hatk at
alpha.85, the community app and host at the opensocial main line, the spaces-alpha
reference PDS (`0.0.0-spaces-alpha-20260910230440`), pds.js's `@pdsjs/spaces`, and
Grain's `groups` branch.

## The short version

There are two ways for hatk to be the appview, and the choice between them
matters more than any of the six items in the earlier list.

**Read-through as the viewer.** Each request trades the viewer's own PDS session
for a space credential and reads the space live. Authorization is the
authority's, not hatk's. Grain's `groups` branch already does exactly this on
hatk alpha.83 with no framework change, through `ctx.pds`. hatk's gap here is
small: lift Grain's space client into the framework.

**Index as a service.** hatk gets a DID, is admitted to each space, follows write
notices, stores rows, and filters per viewer on every read. This is the
six-item plan. It has a seventh item the list missed, and that one is not in
hatk: the space authority has to authorize hatk's DID to read, which for the
community host means a membership record or a host-side syncer rule. That is an
opensocial change and a per-community act of trust, and it has to land before
any ingest code is worth writing.

Recommendation: do read-through first. It covers every page the community app
has today, it is authoritatively correct, and it touches nothing Grain relies
on. Index as a service only for the things an index actually buys (below), and
only once the host can admit an indexer.

## What the community app reads

From `apps/community/src/lib/*.ts`:

| Source                          | Records                                                                                                                              | Read how                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| Public repo of the community    | `fyi.opensocial.{declaration,profile,rule,member}`, `app.bsky.feed.post`                                                             | plain `repo.listRecords`, no auth     |
| Public repos of members         | `app.bsky.feed.post` (mentions, quotes, replies), `fyi.opensocial.reaction`, `fm.teal.alpha.feed.play`, `social.grain.actor.profile` | fan-out over the public roster        |
| Members space                   | `fyi.opensocial.{membership,role,permissions,space}`                                                                                 | credential                            |
| Events space                    | `community.lexicon.calendar.{event,rsvp}`, `fyi.opensocial.{eventImage,access}`                                                      | credential; blobs via `space.getBlob` |
| Forum spaces (one per board)    | `com.atmoboards.forum.{thread,post,vote,pin,config}`                                                                                 | credential                            |
| Pool space `social.grain.group` | `social.grain.{gallery,gallery.item,photo}`                                                                                          | credential; blobs via `space.getBlob` |

The first two rows are ordinary firehose data. hatk indexes them today: `relays`
tails the host's `subscribeRepos`, and Grain pins the host DID in
`backfill.repos` so the community repo is tracked at all (Grain commit
`9a57fad`). Only the last four rows are the gap.

Every one of those four is read as "the whole space, every writer, these
collections", assembled client-side. The app's own comments call this "a
community-sized read, not a global search". Nothing on its pages needs an
index; what it needs is one server-side request per page instead of
`writers × collections` credentialed reads from the browser.

## Protocol facts that constrain the design

Verified in the reference PDS and pds.js, not from the lexicon prose alone.

- **No anonymous read path exists.** A credential starts with a delegation token
  from the reader's own PDS. `readableBy: ["public"]` means any authenticated
  DID. An indexer that served space rows to a signed-out visitor would widen
  access past what the protocol permits. hatk must never serve space rows
  without a viewer.
- **Only the authority decides.** Repo hosts check that the credential is
  signed by the space's authority and bound to the presented DPoP key, nothing
  else. Membership is evaluated once, at `getSpaceCredential`, and for the
  community host that call goes to `checkUserAccess`, which reads
  `access.readableBy` against `membership.roles`.
- **Delegation tokens are self-mintable.** Verification resolves the `#atproto`
  key from the issuer's DID document; nothing requires the issuer to be a
  person or the token to have come from an XRPC call. A did:web with an ES256
  key in its document can sign its own. Lifetime is 60 seconds, single-use
  `jti`, `aud` = `<authority>#atproto_space_host`.
- **Credentials last 2 hours**, carry no `aud`, and are bound to a DPoP key via
  `cnf.jkt`. Every read carries a fresh DPoP proof with `ath`.
- **Notices are one-shot.** The reference PDS forwards `notifyWrite` from an
  in-memory background queue with one try and a log line on failure. pds.js is
  the same. A reconcile sweep against `listRepos` is mandatory, not a nicety.
- **The forwarded notice has the shape the user described.** `iss` is the
  authority DID, `aud` is the registered service identifier verbatim including
  its fragment, `lxm` is `com.atproto.space.notifyWrite`, `exp` is 60 seconds.
  The PDS's own inbound handler rejects that shape on both `iss` and `aud`
  checks, so a receiver needs its own verifier.
- **Registration needs a credential and lasts 24 hours.** `registerNotify` is
  authenticated with a space credential, so the syncer must already be
  admitted. The service's delivery endpoint is resolved from its DID document.
- **The oplog has no history guarantee.** `listRepoOps` may be compacted or
  dropped and does not survive account migration. Initial sync and any gap
  recovery must use `getRepo`, a CAR with two roots (signed commit, then a
  DRISL index) that `@atproto/space` can verify. `@atproto/space` is Node-only,
  which is fine for hatk.
- **Ops carry no action.** An op is `{rev, collection, rkey, cid, prev, value?}`.
  Create, update, and delete are inferred from `cid` and `prev` nullability.
  `value` is inlined only when it is still the current record.
- **The writer set is host state and does not migrate.** After a community
  moves hosts, `listRepos` is empty until each writer writes again. An indexer
  that remembers writers can keep reading by known repo. This is the one place
  an index is strictly better than a live read.
- **Space URIs are seven segments**:
  `at://{authority}/space/{type}/{skey}/{writer}/{collection}/{rkey}`. hatk's
  `collectionFromUri` returns segment 3, which for a space URI is the literal
  string `space`. Anything in hatk that splits an at-uri positionally will
  misparse these.

## Path A: read-through as the viewer

What Grain's `groups` branch built (`server/spaces/client.ts`,
`server/helpers/pool.ts`, `server/xrpc/getPrivateBlob.ts`,
`server/spaces/errors.ts`), and what hatk would absorb:

1. **`ctx.space` helper.** Per-viewer, per-space credential cache: delegation
   token via `ctx.pds("com.atproto.space.getDelegationToken")`, exchange at the
   authority's PDS with a DPoP proof from a server-held ES256 key, cache well
   inside the 2-hour TTL, re-mint once on 401. Methods: `listRepos`,
   `listRecords`, `getRecord`, `getBlob`, plus a `readSpace(space, collections)`
   that fans out over writers and their PDSes. hatk already has the ES256 and
   DPoP primitives in `oauth/crypto.ts` and `oauth/dpop.ts`, and a
   per-DID PDS resolver in `backfill.ts`.
2. **Credentialed blob route.** hatk's `/blob/:did/:cid` is unauthenticated and
   only mounted for a local relay. Space blobs need a viewer-gated route that
   fetches with the viewer's credential and answers `private, no-store` with a
   content-type allowlist. Grain's `getPrivateBlob` is the shape.
3. **Error mapping.** 401 → sign in again; 403/404 → probe whether the viewer's
   PDS serves spaces at all (hatk's `service-describe.ts` already does this
   probe for scope negotiation) and answer `SpacesUnsupported` or
   `NotAuthorized`.
4. **Scopes.** Already supported: `conditionalScopes` keyed on
   `com.atproto.space.getDelegationToken` is how Grain requests the pool scope
   only from PDSes that can honor it.

No schema change, no ingest change, no new identity. Every community-app page
maps one-to-one onto `readSpace` calls the app already makes in
`lib/atproto.ts`; moving them behind `defineQuery` handlers is the whole port.
Grain deletes its local copy and gains nothing it has to re-test.

What this path cannot do: search inside a space, feeds with cursors over space
rows, cross-community aggregation without reading every pool (Grain's
`listPoolFeed` does exactly that and accepts the cost), push on space writes,
SSR or OG for member-only content (OG cannot be per-viewer anyway), and reading
by known repo after a host migration.

## Path B: index as a service

The six items, refined against what is actually in hatk, plus the seventh.

**0. Admission (not in hatk).** `getSpaceCredential` for hatk's DID goes through
`checkUserAccess`, which reads a `fyi.opensocial.membership` record for the
caller. Either each community assigns hatk's did:web a role that appears in
every space's `readableBy`, or the host grows a syncer allowlist evaluated
before RBAC. Spaces with `readableBy: ["public"]` need nothing beyond an
authenticated DID. This is the gating dependency for everything below.

**1. Ingest.** The seam is narrower than "call `applyCommit`". `CommitOp` has no
DID, URI, or rev; the URI is minted inside `applyCommit` at `indexer.ts:699` as
`at://{did}/{collection}/{rkey}`. Needed: a URI override or a sibling
`applySpaceOps(space, writer, ops)`; `did` column stays the writer. Ops need
action inference from `cid`/`prev`. Cursor per `(space, writer)` is the rev, a
fine `_cursor` key. `_repos` does not fit; a `_space_repos(space, did, rev,
hash, status)` table is the writer registry and the reconcile target. The
existing wire-parity test (relay frame and Jetstream frame produce identical
rows and `cid`) becomes a three-wire test.

**2. Identity.** A did:web at `/.well-known/did.json` publishing the existing
server ES256 key as `#atproto` (multibase encoding of the JWK) and a service
entry such as `#atproto_space_syncer` pointing at hatk. Self-minted delegation
tokens, a credential cache per space (2h, DPoP-bound to the server key),
renewal inside the TTL. `@atproto/space` exports `createSpaceToken`,
`createDpopProof`, and the CAR verifier; depending on it is the shortest route.

**3. Notice receiver.** Two inbound XRPC routes on hatk's flat route chain:
`notifyWrite` (verify service-auth JWT with `iss` = authority, `aud` = hatk's
service id with fragment, `lxm`, 60s `exp`; then pull `listRepoOps
since=<stored rev>`) and `notifySpaceDeleted` (drop the space's rows).
`registerNotify` per space, renewed roughly every 12 hours. A sweep comparing
`listRepos` `{rev, hash}` against `_space_repos` on an interval, since delivery
is one-shot. hatk verifies OAuth and DPoP today but has no service-auth
verifier; that is new but small.

**4. Per-viewer reads.** The architectural item, and where the read path Grain
uses gets touched. Facts: hydration has no viewer parameter at all; OpenGraph
hardcodes the viewer to null; `getRecords`, `getRecord`, and `searchRecords`
compute a viewer and ignore it; `privateCollections` is collection-level and
viewer-independent. The one precedent for row-level filtering is the
`_repos.status = 'takendown'` join in `queryRecords` and friends.

Two sub-decisions:

- _Where the yes/no comes from._ Re-deriving "viewer may read space S" from
  indexed `access` and `membership` records duplicates the host's RBAC inside
  hatk and drifts from it (the host keeps ejected members' content readable;
  credentials lag revocation by up to 2 hours; invites spaces are
  write-for-anyone). The protocol-generic answer is to use the credential mint
  itself as the oracle: attempt `getSpaceCredential` as the viewer via
  `ctx.pds`, cache the answer for the credential's lifetime. That is Path A's
  first step reused as an authorization check, and it is the same posture the
  app takes ("a refused credential is the ordinary shape of not a member").
- _Where the filter applies._ Space rows must be invisible to every built-in
  endpoint, feed, hydration, and OG path unless a viewer-scoped filter is in
  the query. Cheapest safe form: a nullable `space` column with an index on
  every generated table (`migrateSchema` adds columns, so Grain's prod tables
  gain a null column), plus a `space IS NULL OR space IN (...)` predicate
  injected at the same place as the takedown join, with the readable set
  coming from `ctx`. App-authored feed SQL has to opt in with a helper.

**5. Blobs.** Same credentialed route as Path A, with the bytes cached in
memory so a photo is read from its repo once rather than once per member
looking at it. The posture that buys is worth stating: hatk holds members'
private photos for as long as the process lives and no longer, bounded and
never written to disk, and every request is authorized before the cache is
consulted at all.

**6. Backfill.** `listRepos` at the authority, then per writer either `getRepo`
(verified CAR) or `listRecords` per collection (simpler, unverified). Writer
PDS resolution already exists in `backfill.ts`. The writer set hatk builds
outlives the host's, which is the migration win.

**Discovery.** Not in the list at all. Which spaces exist is itself in a space:
the community writes one `fyi.opensocial.space` record per space into its
members space. So indexing a community means: see its `declaration` on the
firehose, read its members space (requires admission), learn its spaces, index
each. That loop is opensocial-specific; hatk should expose it as a hook or a
config of space types by convention rather than hardcode it.

## Cost to Grain

Path A adds code that only runs when an app calls it. Path B items 1, 2, 3, 5,
and 6 are new paths that are inert without space config. Item 4 is the one
that changes tables Grain already has and the query helpers Grain already
calls. If Path B is ever built, the `space` column and the injected predicate
should ship behind a config flag and be exercised by Grain's suite before the
flag defaults on.

## What Bulletin does

`~/code/bulletin` is the alpha's reference syncer, and it is Path B with one
twist that dissolves the admission problem.

**It reads as a borrowed user.** Bulletin has a did:web, but the document
carries no signing key, only a service entry `#bulletin`. That identity exists
to be addressed: it is the `aud` of `checkUserAccess` calls and the recipient
of forwarded notices. For reading, `credentialFor` in `lib/sync/engine.ts`
restores a stored OAuth session, preferring the board owner's and falling back
to any stored session whose DID follows the owner, and mints the delegation
token as that person. The indexer never asks to be admitted anywhere. The cost
is that a board syncs only while someone who can read it has a session in
Bulletin's store.

**It only indexes spaces it governs.** Bulletin is the managing app: its
`checkUserAccess` answers "does the user follow the owner" from
`api.bsky.app`. Before watching a space it calls `getSpace` and refuses unless
`policy.managingApp` is itself. That is why its per-viewer read gate is
trivially consistent with the credential policy: the board page calls the same
`userFollows` function, then filters owner-removed posts. The community app
cannot do this, because its policy lives in the community host.

**The sync engine is the shape hatk would need.** Two tables, `syncSpace` and
`syncRepo`, the latter holding `rev`, the LtHash state, and the commit hash
per `(space, writer)`. Incremental sync pages `listRepoOps since=rev`, applies
each op to `RepoCommit.fromState`, verifies the returned commit's signature
against the writer's DID key and the hash against local state, and on any
failure falls back to `getRepo` plus `verifyRepoCarFull` and replaces the
writer's rows. Reconcile lists writers at the authority, syncs any whose rev
differs, and deletes local writers the authority no longer names. It runs at
boot, on every watch, on an optional poll timer, and five minutes after any
failure. Registration renews an hour before expiry. Per-`(space, repo)` jobs
are serialized in memory.

**The notice receiver is small.** `verifyJwt` from `@atproto/xrpc-server`
with `aud` = its own service id and `lxm` = the method, then `iss` must equal
the space authority. It answers 200 immediately and syncs in the background.
It ignores the `hash` in the notice entirely and just triggers a sync.

**Blobs are cached on disk** at sync time by CID, refcounted per
`(space, writer, cid)`, pruned when no post references them, and served by a
route that re-checks the viewer's follow relationship and answers
`private, no-store`.

**Discovery is on demand.** Visiting a board page calls an internal `/watch`,
which starts indexing that space if it is not already tracked. Nothing crawls.

**Own writes are mirrored.** `createPost` writes to the PDS, then applies the
same change to the local index, the way hatk's PDS proxy already does.

Bulletin's `parseChange` is hand-written per collection, three of them, one
space type, and the sync code is roughly a thousand lines with tests. hatk
would generate the row mapping from lexicons and would get commit verification
from `@atproto/space` for the cost of a dependency.

**What it changes in the recommendation.** "Index as a borrowed member" is a
third option between the two above. For the community app it fits well: every
reader is a signed-in member with a `space:` read scope, so hatk can mint as
any stored session whose DID holds a readable role, with no host change. The
open problem stays the same: hatk must still decide per viewer what to serve,
and the authoritative way to decide is a credential mint as that viewer, not a
re-implementation of the host's RBAC.

## What the index actually buys

Worth listing, because the community app needs none of it today:

- Search inside forums and pools.
- Cursor-paged feeds over space rows, and cross-community feeds without reading
  every pool per request.
- Push notifications on space writes, which need the notice receiver anyway.
- Reading by known writer after a community migrates hosts.
- Lower latency for large communities, where `writers × collections` live
  reads stop being community-sized.

If those are the goal, the order is: admission on the host, then identity and
the notice receiver, then ingest and backfill, and per-viewer reads last, with
Path A's credential mint as the authorization oracle throughout.

## What landed (2026-09-17)

The sync engine and the read gate, behind a `spaces` config key that is absent
by default. An instance that does not set it indexes nothing from a space,
serves no space row, and behaves exactly as before.

**Storage.** Every generated record table gains a nullable, indexed `space`
column (`database/schema.ts`), added to existing tables by `migrateSchema`. It
is filled by reading the record's own URI inside `buildInsertOp` and
`bulkInsertRecords`, so no write path can land a space row with the column left
NULL. `Row.space` appears on the wire only when it means something.

**URIs.** `spaces/uri.ts` is the one place the five-segment and seven-segment
forms are reconciled. `collectionFromUri` and `reshapeRow` both read the
collection through it; before, a space URI reported its collection as the
literal `space`, which matched no schema and would have left every space
record snake_cased with its JSON columns unparsed.

**The read gate** (`spaces/visibility.ts`). An `AsyncLocalStorage` scope of
readable spaces, defaulting to empty, and a SQL predicate applied by every
content read in `database/db.ts`. Outside a scope the predicate is
`space IS NULL` and binds no parameters, so the common request pays one test on
an indexed column. A read path nobody remembered to scope shows a member
nothing rather than showing a stranger everything.

**Credentials** (`spaces/credential.ts`). hatk is admitted to no space and does
not ask to be. It borrows a signed-in member's delegation — `getDelegationToken`
on their PDS through the existing proxy, exchanged at the authority for a
DPoP-bound credential on a per-process key. Candidates are the stored OAuth
sessions, the last one that worked first. A refusal about the reader moves to
the next; a refusal about the space stops the walk.

**The engine** (`spaces/engine.ts`). `listRepos` at the authority for the writer
set, `listRepoOps since=rev` per writer, falling back to `getLatestCommit` plus
`listRecords` when there is no rev or the op log has been compacted past it.
Ops carry no action, so create/update/delete is inferred from `cid` and `prev`,
last-op-wins per rkey within a page, and an op whose value was superseded is
fetched rather than guessed. Writers the authority stops naming have their rows
dropped, which is what ejection looks like from here. Failures are recorded per
space so one unreachable host does not stop the sweep.

**Per-viewer reads** (`spaces/viewer.ts`). The scope is established once per
request, right after the viewer is resolved, and every query below it reads
that scope. The answer to "may this viewer see this space" is not re-derived
from indexed access and membership records — that would be a second
implementation of somebody else's authorization, drifting from it in exactly
the cases that matter. It is the real check: mint a credential as that viewer
and take the answer, which is the same call their own browser would make. The
answer is cached for five minutes, so revocation lags by that much; the space
host already lets a minted credential outlive a revocation by up to two hours.

**Blobs** (`spaces/blob.ts`, `GET /space-blob`). A space blob has no public URL
by design, so it is fetched from the repo that holds it with the viewer's own
credential and served with a content-type allowlist. A viewer who may not read
the space gets the same 404 as a missing blob.

Both caches under that route sit behind the credential check, never in front of
it. The response is `private, max-age=60, must-revalidate` with the blob's CID
as its ETag — a CID is a hash of the bytes it names, so the validator is free
and exact — which lets the viewer's own browser keep what it was shown and no
shared cache keep anything; `vary: cookie, authorization` keeps two people
signing in on one browser apart. Behind that, bytes are held in a bounded
in-memory LRU keyed by space _and_ CID. The space has to be in the key: the
check that a blob is actually referenced from the space being named lives
upstream in `com.atproto.space.getBlob`, so a cache that hit on CID alone would
let a viewer who may read one space name any CID they had heard of and be
served it without that check running. Blobs past a per-entry limit are streamed
rather than held.

A `preset` names the size to serve, from the same list and the same numbers
hatk's public path gives imgproxy — `avatar`, `avatar_thumbnail`,
`feed_thumbnail`, `feed_fullsize`, `banner` — so an app says a size once and
means it either side of the line between a public blob and a permissioned one.
What differs is who resizes: a space blob may not pass through an image CDN, so
it happens on the cache fill, where the bytes are already in hand. Only a name
from that list is accepted; free-form dimensions would let anyone mint
unlimited cache keys and put the cost of an arbitrary resize behind a URL. The
resizer is sharp, an _optional_ peer dependency — most of what installs hatk
never serves a space — and everything it cannot do (sharp absent, an animation,
an image it cannot read, a derivative that came out no smaller) falls back to
the original rather than to an error. Format is preserved rather than
normalised to JPEG, which would flatten a PNG's transparency; EXIF orientation
is applied and the rest of the metadata dropped, so a ride photo's GPS stops
being served with it.

**Write notices** (`spaces/notify.ts`, `spaces/verify.ts`). Registration happens
inside reconcile, where a credential is already in hand — `registerNotify` is
authenticated with one, so only somebody the authority already admits can
subscribe — and renews an hour before its 24-hour expiry. Two inbound routes
receive the forwarded notices, ahead of the XRPC catch-all that would otherwise
answer for those NSIDs first. A notice carries no records: it says look again,
and the read that follows uses hatk's own borrowed credential. It is answered
before the sync runs, and syncs are debounced per repo, because one member
writing a gallery sends a notice per record.

The forwarded notice needed its own verifier. At origin a writer's host signs
with `iss` = the writer and `aud` = the bare authority DID; forwarded onward the
authority re-signs with `iss` = itself and `aud` = the service identifier
including its fragment. The reference PDS's own handler rejects exactly that
shape, so there was nothing to borrow. Verification also meant handling
secp256k1, which most `did:plc` accounts sign with and WebCrypto does not
implement at all — `@noble/curves` is the one dependency this added, and
`spaces/verify.ts` is base58btc plus multicodec prefix parsing on top of it.

hatk publishes a `did:web` document at `/.well-known/did.json` naming where to
deliver. It carries a service entry and no verification method: a syncer signs
nothing, so there is no key to publish or to steal.

### Known gaps, in the order they matter

- **Viewer resolution costs a round trip per followed space** on a cache miss,
  so an instance following many communities pays for all of them per viewer.
  Fine for a handful; a narrowing hook is the answer if it stops being.
- **Raw SQL is opt-in.** A feed or query handler writing its own SQL must apply
  `ctx.spaceFilter`; nothing can inject a predicate into a string somebody else
  wrote. Only matters once `spaces` is configured.
- **No verification.** The alpha signs a commit over the repo's LtHash state and
  a syncer can check it. hatk does not check the equivalent on the firehose path
  either, so checking here alone would claim a guarantee the rest of the index
  does not make. Worth adding to both paths at once, via `@atproto/space`.
- **Search pagination is approximate** over space rows: FTS ranks before the
  gate filters, so a page can come back short. No leak, and it costs nothing
  until spaces are configured.
- **Space blob resizing needs sharp installed.** It is an optional peer
  dependency, so a deployment that never adds it serves originals and logs
  `resize_unavailable` once. Nothing fails; images are just as large as they
  were.

## The community app port (2026-09-17)

`~/code/opensocial`, branch `community-hatk`. The React frontend stays; the data
layer moved. Each `lib/*.ts` hook now makes one call to a `fyi.opensocial.site.*`
endpoint served by a hatk appview inside `apps/community` (config, lexicons,
`server/xrpc`, an on-login hook that follows the community's spaces from the
first member's sign-in), and sign-in is hatk's server-side OAuth. Writes go
through the appview with the session it holds, including acting as the
community, for which hatk now exposes `serverDpopProof`.

Two hatk changes fell out of doing it for real: a record property named like
an envelope column (`fyi.opensocial.space` has a `uri`) is stored under a
`record_` prefix instead of failing CREATE TABLE, and space-type and
permission-set lexicons are kept without being handed to a validator that
rejects them as unknown.

Not yet verified against a live stack: the one running while this was built
was six days stale from another worktree and answered "Repo not found" for
every repo it listed. The appview booted against it, indexed the community
handles it still exposed, served OAuth metadata through the Vite proxy, and
refused nothing it should have served — but the pages have not been seen with
real space data behind them.

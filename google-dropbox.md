# OnePlay beyond OneDrive: Dropbox and Google Drive

**Technical decision report — 24 November 2026**  
**Scope:** OnePlay only: the browser-based application that indexes a user's existing cloud-hosted music/video collection and plays media from its saved index. GeoPic, podcast ingestion, public sharing and media-proxy services are deliberately excluded.

## Executive summary

**Both Dropbox and Google Drive are plausible providers for OnePlay, but neither reproduces OneDrive's most useful feature for an occasionally opened, enormous media library: a cheap, current-state fingerprint of an entire directory subtree.** The current OneDrive strategy reads an aggregate folder size and descends only into branches whose sizes have changed. That avoids repeating a scan that can take two hours, even when the app has not run for years. It is a design advantage worth preserving.

- **Dropbox is the easier first integration for authorization and browsing.** Its OAuth code flow with PKCE works for static browser applications, and *Full Dropbox* access with read-only scopes reaches the user's pre-existing library. `files/list_folder` can enumerate a tree recursively, and a folder-scoped cursor can subsequently report changes. However, Dropbox does not expose recursive folder sizes, and cursors can become invalid; recovery may require a full enumeration. Its temporary file links also have a specific browser-playback caveat that must be tested.
- **Google Drive is viable but requires more publication work.** Arbitrary existing-file access calls for `drive.readonly`, a **restricted** scope subject to Google verification. Initial directory discovery requires walking folders individually. Google explicitly documents its Drive change tokens as **non-expiring**, which could make the service particularly suitable for an index reopened after a long absence. But the change log is Drive-wide, not scoped to a folder tree, and private-media playback from an unprivileged HTML media element needs a proof of concept.
- **Do not equate API download support with streaming playback support.** `<audio>` and `<video>` elements cannot simply attach an OAuth `Authorization` header. OneDrive already has an established solution in OnePlay; neither Dropbox nor Google should be declared supported until its own private, seekable, browser-only playback path is proven, without making the media publicly shared or proxying it through the app author's server.

**Recommended sequence:** prototype private playback first, then build a Dropbox adapter, and then tackle Google Drive plus restricted-scope verification. Keep provider-specific index freshness strategies rather than imposing a fictional universal folder-version property.

## 1. OnePlay's non-negotiable design

OnePlay is a **static client-side application**, not a cloud-hosted media service. A user chooses a normal consumer cloud-storage account, keeps full ownership of their files, and grants OnePlay permission to enumerate and play an existing library. The application's server must not hold the user's media, OAuth credentials, or a hosted copy of the index.

A representative collection contains approximately **1 TB of music and/or video**, with a hierarchical folder structure. Building an index may take **two hours**. The archive is mostly stable, with additions or changes separated by months or years. The dominant objective is therefore not minimum latency for processing frequent updates; it is **recognizing that a large subtree has not changed, at negligible cost and regardless of elapsed time**.

The index should remain on the user's device (for example, IndexedDB), keyed by provider account and selected root. Provider metadata, application-extracted media tags, and change-detection state should be kept distinct. Nothing should require other users to reorganize their directories or publish their media.

## 2. File locations: no portable `Music` directory

People store ordinary MP3, FLAC, M4A, MP4 and other media files in both Dropbox and Google Drive. Neither has a universal default `Music/` or `Videos/` directory with the status of a special folder that OnePlay can assume exists. Google Drive's ordinary files also should not be conflated with Google Photos or Google's former music products.

**Use a user-selected root folder.** Optionally offer name-based suggestions (`Music`, `Videos`, `Media`, etc.) when found, without treating the names as a guarantee. Remember the selected folder using its stable provider ID, not its displayed path. Files and folders may be renamed or moved; in Google Drive duplicate names are possible.

## 3. Side-by-side assessment

| OnePlay requirement | Dropbox | Google Drive |
|---|---|---|
| Normal consumer accounts with user-owned media | Yes | Yes |
| OAuth directly from static HTML/JavaScript | Authorization code + PKCE | Browser OAuth flow |
| Read all **existing** files under a chosen root | *Full Dropbox* permission; `files.metadata.read`, `files.content.read` | `drive.readonly` (restricted scope) |
| Narrow app-folder/file-only permission sufficient? | No, not for arbitrary existing folders | No, `drive.file` does not grant recursive access merely by selecting a parent folder |
| Initial recursive scan | `files/list_folder`, `recursive: true`, paginated | Repeated `files.list` queries for each folder's immediate children |
| Current recursive byte-size fingerprint | No | No |
| Change detection | Folder-specific cursor, possibly invalidated | Drive-wide changes API, documented non-expiring tokens |
| Survives years without re-indexing by contract? | Not guaranteed | Stronger documented token semantics; correctness still needs testing |
| OAuth app publication burden | Comparatively modest | Restricted-scope verification |
| Private direct HTML media-element URL | Temporary content links exist, but not guaranteed for direct browser display | No straightforward API-issued signed media URL documented; investigate authenticated streaming mechanism |
| Browser-only, no server file proxy | Architecturally possible; playback needs testing | Architecturally possible; playback needs testing |

The table's most important two rows are **subtree freshness** and **private playback**. Straightforward folder enumeration by itself is not enough to make a suitable OnePlay provider.

## 4. Dropbox

### Authorization

Register a *Scoped access* Dropbox application with **Full Dropbox** access rather than *App folder*, because OnePlay must browse the user's existing files anywhere in the account. Request only:

- `files.metadata.read` for directory traversal and file information;
- `files.content.read` for media content and temporary file links.

The documented client-side pattern is **OAuth authorization code + PKCE**, using short-lived access tokens. There is no reason to put a Dropbox client secret into static HTML, or to give the app write or sharing scopes. Use the official JavaScript SDK or equivalent direct REST calls. Consider reauthorization and token expiration as normal client operations.

### Initial scan

Start with `POST /2/files/list_folder` using the selected directory ID/path and `recursive: true`. Consume every page with `/2/files/list_folder/continue` until complete. Preserve file IDs, normalized paths, content hashes/revisions where available, sizes, and media-related metadata. Dropbox cautions that **recursive listing can have performance problems or errors on extremely large trees**; a fallback is explicit traversal one folder at a time.

### Subsequent launches: an imperfect but useful cursor

The listing produces a cursor. Later, `/2/files/list_folder/continue` can return only modified, created and deleted entries in the selected tree. If the user has added a single album since the last scan, this is a good result.

The limitation is not that the cursor necessarily expires on a short timer. Dropbox describes cursors as long-lived, but acknowledges possible invalidation (including a `reset` error), with no guarantee that they survive arbitrarily long dormancy or account operations. In that case **the API offers no recursive folder byte size or subtree generation number with which to cheaply verify that the archive is unchanged**. You may have to re-enumerate a huge collection merely to rebuild a cursor.

Possible policy: use the cursor whenever valid; after a reset, explain the cost and offer a deliberate rebuild rather than silently initiating another two-hour scan. Optional periodic cursor refreshes would change OnePlay's operational model and still would not eliminate every invalidation case.

### Private media playback: test before porting the indexer

Dropbox offers `/2/files/get_temporary_link`, returning a **four-hour** link to file content without a user OAuth header on subsequent retrieval. This is attractive because a normal HTML media element cannot provide custom `Authorization` headers. However, the official endpoint documentation says the temporary URL **should not be used to display content directly in the browser**. Do not assume that playing long tracks or seeking in large videos through such links is a supported, robust design.

First test a private MP3 and a large MP4 in desktop Safari/Chrome and iPhone Safari, including playback start time, seeking, pause/resume, byte ranges, link expiration and refresh, and behavior when switching tracks. If temporary-link playback proves unreliable, test authenticated `fetch` plus appropriate browser-side media handling; do not silently switch to public file shares or a server proxy. `fetch`ing an entire large file as a Blob is a weak fallback for video and long audio, and Media Source Extensions or a service worker have their own browser compatibility and HTTP-range requirements.

## 5. Google Drive

### Authorization and Google verification

To scan a user's **pre-existing arbitrary media collection**, OnePlay ordinarily needs `https://www.googleapis.com/auth/drive.readonly`, classified by Google as **restricted**. The non-sensitive `drive.file` scope does not grant recursive access to all descendants of a folder merely because the user selected its parent in Google Picker.

Google permits restricted Drive scopes for qualifying categories, including certain productivity applications that interact with files or their metadata. An independently published free browser app is not automatically disqualified, but its use case must be accepted and its OAuth consent screen verified. A privacy policy, domain verification, scope justification and demonstration are likely needed. Google says a separate security assessment is required when restricted-scope data is transmitted through or stored on third-party servers; OnePlay's **pure client-side** model appears to avoid that specific trigger, subject to Google's review. Avoid sending file names, file content or OAuth tokens to an application backend.

### Initial scan

The Drive API's `files.list` with a query such as `'FOLDER_ID' in parents and trashed = false` returns **immediate children only**. To enumerate a tree, visit each folder in turn, following all `nextPageToken`s and explicitly requesting the needed metadata fields (`id`, `name`, `mimeType`, `parents`, `size`, `modifiedTime`, `md5Checksum` where applicable, etc.). There is no built-in recursive descendant query. A large directory tree may therefore require many API round trips.

Use provider IDs as identities and model parent links explicitly. Folder metadata has **no aggregate recursive size**. File sizes, modification times and checksums are useful for individual files, but not current-state fingerprints for a whole subtree.

### Change tokens: a meaningful difference from Dropbox

At the beginning of indexing, obtain a `changes.getStartPageToken` token. Walk the selected library, then replay changes from that token to catch mutations that occurred during the lengthy scan; commit the resulting index and newest token together. On later launches, call `changes.list` with the saved token, follow all change pages, and save `newStartPageToken` only after applying the results successfully.

**Google explicitly states that its start and continuation change tokens do not expire.** This is unusually promising for an application unused for years, although the documentation is not a separate end-to-end guarantee that every conceivable old account state can always be replayed. Test realistic long-gap and high-churn cases.

The change feed is **Drive-wide**, not limited to OnePlay's selected folder. Irrelevant changes must be filtered. Changes to parent membership, permission/access removal, renames and moved folders complicate subtree membership: a folder may move into or out of the selected tree without an individual change event for every descendant. Design the index as a parent-ID graph and validate these cases. If an entire subtree must be re-enumerated after a move, that should be explicit rather than accidental.

### Private browser playback: the larger unanswered question

Google documents authenticated blob downloads through `files.get?alt=media`, with `Authorization: Bearer <token>`, and browser-oriented `webContentLink` download URLs. But `webContentLink` is not the same as an API-issued signed streaming URL for an arbitrary *private* file: the browser-facing link may depend on Google login cookies and a download-oriented interface. It should not be assumed usable as `<audio src>` or `<video src>`.

Likewise, attaching the bearer token to `fetch` is not equivalent to giving a normal HTML media element that token. For substantial MP4 files, seekable playback requires handling `Range` requests, partial responses, redirects, and CORS without loading the entire file first. A browser-side service worker or streaming approach may be possible, but must be prototyped with Google Drive before committing to a full OnePlay port. **Do not make users publicly share their library as a workaround.**

## 6. Recommended adapter boundaries

A small common layer should describe what OnePlay needs, without pretending the backends are identical:

```ts
interface MediaProvider {
  authenticate(): Promise<void>;
  chooseRoot(): Promise<{ id: string; displayName: string }>;
  listChildren(folderId: string, pageToken?: string): Promise<Page<MediaEntry>>;
  getFileMetadata(fileId: string): Promise<MediaEntry>;
  openPlayableMedia(fileId: string): Promise<PlaybackSource>;
  initializeChangeTracking(rootId: string): Promise<ChangeState>;
  getChanges(state: ChangeState): Promise<ChangeResult>;
}
```

`openPlayableMedia` is deliberately **not** defined as `getDownloadUrl(): string`. Some providers may supply a temporary bearer-free URL; others may require client-managed byte retrieval. Likewise, `getChanges` must expose an explicit `cursorInvalid`/`rebuildNeeded` result, and should not claim it provides a current recursive subtree fingerprint when it does not.

Keep media metadata parsing separate from the storage adapter: filenames, file sizes, timestamps and MIME types are cloud metadata; ID3/MP4 tags and embedded cover art may require fetching file ranges. A saved index should record its completeness and schema version so that an interrupted or stale scan is never mistaken for a complete one.

## 7. Proof-of-concept and acceptance plan

**Phase 1 — Private playback feasibility (do this before a two-hour library scan).** For each provider, authenticate in a static web page; choose an existing private MP3 and MP4; play them without public sharing or a server-side proxy. Test iPhone Safari as well as desktop, seeking to a distant point, resuming after an idle interval, media lengths from a few MB to several GB, token/link renewal, and ordinary codec/browser limitations. Record whether media can be delivered incrementally or requires a complete Blob.

**Phase 2 — Initial discovery.** Enumerate a representative deep tree with thousands of directories and a large total item count; benchmark elapsed time, HTTP operations, API throttling, token handling and interruption/restart. Validate that cached paths and stable IDs survive renames. On Google, test pagination and nested duplicate names; on Dropbox, test both recursive and per-folder enumeration.

**Phase 3 — Dormancy and small changes.** Persist an index and resume it after weeks/months; simulate one deep addition, removal, in-place rewrite to the *same byte count*, ancestor folder move, and access revocation. For Dropbox deliberately test `reset` and its user experience. For Google test Drive-wide unrelated churn, long tokens, and ancestor moves. A successful experiment must avoid a complete re-index of an unchanged collection whenever the provider's documented state allows that.

**Phase 4 — OAuth/publication.** Test all auth states and account switching; publish the Dropbox read-only app, then prepare Google's restricted-scope review only after its playback and indexing prototypes pass. Google review is not merely a code problem, so treat approval as an explicit release dependency.

## 8. Decision and unresolved risks

**Proceed with Dropbox first, subject to a private-browser-playback spike.** It has straightforward user authorization, read-only full-account API access and convenient tree enumeration. The principal unavoidable drawback is the possible cost of recovery after an invalid cursor; the principal new technical question is whether its temporary links are suitable for robust audio/video playback in OnePlay.

**Pursue Google Drive second, once playback feasibility is established.** Its non-expiring change-token contract is compelling for a rarely opened archive, despite the complexity of filtering a Drive-wide change stream. Its restricted-scope verification and authenticated streaming path are more significant obstacles than basic directory enumeration.

**Keep OneDrive as a first-class provider** and retain its existing recursive-size heuristic. For this application's workload, a cheap *current-state* subtree summary has advantages that historical change logs do not automatically replace. No provider should be ranked as fully supported until it satisfies both the index-freshness and private-media-playback tests.

## Primary sources (checked 24 November 2026)

**Dropbox**
- [OAuth: browser PKCE and app access models](https://docs.dropboxapi.com/dropbox-api/docs/oauth)
- [App setup, Full Dropbox and read scopes](https://docs.dropboxapi.com/dropbox-api/docs/get-started/quick-start)
- [Recursive listing and limitations](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/list-folder)
- [Change detection and cursor handling](https://docs.dropboxapi.com/dropbox-api/docs/detecting-changes)
- [Temporary content links: four hours and browser-display warning](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/get-temporary-link)

**Google Drive**
- [OAuth scopes, restricted-scope rules and assessment trigger](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
- [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- [Recursive search requires client traversal](https://developers.google.com/workspace/drive/api/guides/search-files)
- [Drive file metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)
- [Start page token: explicitly non-expiring](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/getStartPageToken)
- [Change-feed semantics](https://developers.google.com/workspace/drive/api/guides/manage-changes)
- [Change list and non-expiring continuation token](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list)
- [Authenticated downloads and browser download links](https://developers.google.com/workspace/drive/api/guides/manage-downloads)

**Status of evidence:** Provider API facts above are grounded in vendor documentation. Claims about successful playback in iPhone Safari, real-world indexing of a terabyte, and multi-year completeness have **not** been validated experimentally. Those are explicit milestones, not presumed facts.

# OnePlay Music providers and primary storage

**26 November 2026.** Technical design for Music on the hosted PWA and bundled iOS app. Examples show vendor requests and proposed internal APIs. Video, Cast, and interaction design are outside this proposal.

Bind one music root per source. A bound source supplies a catalog and opens its recordings. Sources with a live index also support catalog refresh. The primary cloud connection supplies the music source and a separate document store for app state and eligible catalog files. A secondary connection supplies only a music source. Demo uses a local workspace. The existing OneDrive indexer and cloud cache carry forward.

[Provider API](#proposed-in-app-api) · [Primary cloud storage rules](#what-is-stored-in-the-primary-cloud) · [Share comparison](#demo-and-the-boundary-of-public-shares) · [Worked fit checks](#does-the-api-fit)

## Google Drive v3

### 1. Bind an account and a root

| Identifier or credential | Role |
|---|---|
| Google account | Use the verified OpenID Connect `sub` when identity is available. For a Drive-only web grant, `about.get?fields=user(permissionId,displayName)` supplies the Drive user's ID and a display label. Pick one stable identity for each binding and verify it on reconnect. |
| `files.id` | Opaque file or folder identity. Names can repeat under the same parent. The alias `root` resolves the current user's My Drive root. Store the selected folder's actual ID. |
| `driveId` | Shared drive ID, a corpus selector. Most My Drive items have no `driveId`. A shared drive and a different person's shared folder are distinct cases. |
| `parents`, `name` | Relationship and label. The Drive v3 file model currently allows a single parent. A rename updates the label. A move changes the parent link. |
| `version`, `headRevisionId`, `md5Checksum`, `size` | `version` is a monotonically increasing metadata version expressed as a string. For blobs, the head revision and available checksum identify content more precisely. Size is a byte count encoded as a string. None is a recursive folder fingerprint. |
| `resourceKey` | An additional access capability for some link-shared items. Send it in `X-Goog-Drive-Resource-Keys: fileId/resourceKey` when the API needs it. Keep the key distinct from the ID and access token. |
| Access token, listing page token, changes token | The first is a short-lived bearer for API requests. The other two describe different continuation states and must be used with their original query or change corpus. |

[Google identity claims](https://developers.google.com/identity/openid-connect/openid-connect) · [Drive user metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/about) · [File fields](https://developers.google.com/workspace/drive/api/reference/rest/v3/files) · [Resource keys](https://developers.google.com/workspace/drive/api/guides/resource-keys)

1. Register distinct Web and iOS OAuth clients for the production Google project, and use a separate test project. A private-library grant requests `drive.readonly`. A primary account that syncs app documents also requests `drive.appdata`. A file-by-file playback experiment can use non-sensitive `drive.file` with Picker. Selecting a folder with `drive.file` does not grant read access to its existing descendants. Verify granted scopes and account identity before binding a source.
2. On the PWA, Google's supported no-backend pattern is GIS `initTokenClient` and a user-triggered `requestAccessToken`. It returns a token with `expires_in` and approved scopes. Plan for explicit reauthorization when it expires. The documented web authorization-code model exchanges the code for refresh tokens on a backend. On iOS, Google's SDK supports `restorePreviousSignIn`, `addScopes` and `refreshTokensIfNeeded`. Keep the native token acquisition independent of the WebKit page and test how the SDK behaves with two Google connections before promising concurrent same-provider accounts.
3. Read the account and chosen root with the granted token, then bind the account, optional shared-drive ID and folder ID. Keep credentials in the platform adapter. Use the same token lineage and query parameters when continuing a scan.

[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth) · [Google OAuth client policy](https://developers.google.com/identity/protocols/oauth2/policies) · [Browser token flow](https://developers.google.com/identity/oauth2/web/guides/use-token-model) · [Web code flow](https://developers.google.com/identity/oauth2/web/guides/use-code-model) · [iOS sign-in and restore](https://developers.google.com/identity/sign-in/ios/sign-in) · [iOS scopes and renewal](https://developers.google.com/identity/sign-in/ios/api-access)

A hosted token probe can be as small as this. Trigger it with a user's click after loading GIS and configuring the Web client's origin. The callback receives the grant and calls Drive directly. The example passes the access token only to the provider binding.

```js
const client = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_WEB_CLIENT_ID,
    scope: "https://www.googleapis.com/auth/drive.readonly",
    callback: (grant) => {
        if (grant.error || !grant.access_token) return;
        fetch("https://www.googleapis.com/drive/v3/about?fields=user(permissionId,displayName)", {
            headers: { Authorization: "Bearer " + grant.access_token },
        }).then(async (response) => {
            if (!response.ok) throw new Error("Drive identity HTTP " + response.status);
            const { user } = await response.json();
            // The app binding retains the token. No token or credential URL is logged.
            bindVerifiedGoogleGrant(user.permissionId, grant.access_token, grant.expires_in);
        }).catch(reportGoogleConnectionFailure);
    },
});
document.querySelector("#connect").onclick = () => client.requestAccessToken();
```

### 2. Start a scan, resume it, and follow changes

In these Bash examples, set `GOOGLE_ACCESS_TOKEN` out of band for a private test library, and set `GOOGLE_FOLDER_ID` and `GOOGLE_FILE_ID` to fixture IDs. Tokens and capability URLs should never appear in logs or checked-in fixtures. The first sequence uses a My Drive folder.

```bash
drive_get() {
    curl -fsS -H "Authorization: Bearer $GOOGLE_ACCESS_TOKEN" "$@"
}

DRIVE_API=https://www.googleapis.com/drive/v3
DRIVE_FIELDS='id,name,mimeType,parents,driveId,trashed,size,version,headRevisionId,md5Checksum,resourceKey,capabilities(canDownload),shortcutDetails'

drive_get -G "$DRIVE_API/files/$GOOGLE_FOLDER_ID" \
    --data-urlencode 'fields=id,name,mimeType,driveId,resourceKey,trashed'
drive_get "$DRIVE_API/changes/startPageToken"

drive_get -G "$DRIVE_API/files" \
    --data-urlencode "q='$GOOGLE_FOLDER_ID' in parents and trashed = false" \
    --data-urlencode 'spaces=drive' \
    --data-urlencode 'pageSize=1000' \
    --data-urlencode "fields=nextPageToken,incompleteSearch,files($DRIVE_FIELDS)"
# Follow nextPageToken with the same request plus pageToken.
# Repeat the listing for each discovered folder ID.

drive_get -G "$DRIVE_API/changes" \
    --data-urlencode "pageToken=$GOOGLE_START_OR_NEXT_CHANGE_TOKEN" \
    --data-urlencode 'includeRemoved=true' \
    --data-urlencode 'pageSize=1000' \
    --data-urlencode "fields=nextPageToken,newStartPageToken,changes(fileId,removed,changeType,driveId,file($DRIVE_FIELDS))"
```

1. Get the start token **before** enumerating descendants. Walk a selected root with bounded concurrency. A page can be short or empty with a continuation. Honor `nextPageToken` until absent and treat `incompleteSearch` as incomplete. Record discovered parent links, completed folders, and pending work. If a listing page token is rejected, restart that folder from page one in staging, replacing its partial child list. Ordinary listing tokens typically last hours. The changes tokens are documented as non-expiring.
2. For a shared drive, use `corpora=drive`, its `driveId`, `includeItemsFromAllDrives=true` and `supportsAllDrives=true` for the listings. Obtain and consume a changes token for that same drive ID, with shared-drive support. Use `sharedWithMe = true` to discover directly shared items when appropriate. That query does not mean every descendant of every received share is included.
3. Replay all changes from the captured start token before publishing. Reattach on a move, withdraw catalog membership on trash or confirmed corpus/access removal, and index a newly included folder's descendants even if the change feed contains only its move. A removal event can mean loss of access, and `files.get` returns the same 404 for absent and unreadable files. A plain tombstone or missing child withdraws playback admission while preserving the reference. Explicit trash and verified moves outside the root are useful proof if destructive healing is added later. Recheck root access when necessary. A start token for a user or shared drive is broader than the selected folder. Ignore irrelevant changes only after checking ancestry and current membership.
4. Stage the new parent graph plus the final `newStartPageToken` and publish them in one local transaction. On a later launch, start from the last committed token. Retain the old visible catalog while staging. A crash before commit can safely replay the same changes. Replay by ID is idempotent. Initial rollout can omit Drive shortcuts. Supporting them later uses the shortcut occurrence ID for navigation, its target ID and resource key for I/O, and explicit cycle/scope rules.

[Listing reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list) · [Search syntax](https://developers.google.com/workspace/drive/api/guides/search-files) · [Get start token](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/getStartPageToken) · [List changes](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list) · [User and shared-drive changes](https://developers.google.com/workspace/drive/api/guides/about-changes) · [Shortcuts](https://developers.google.com/workspace/drive/api/guides/shortcuts)

### 3. Play and download a private recording

```bash
drive_get -G "$DRIVE_API/files/$GOOGLE_FILE_ID" \
    --data-urlencode "fields=$DRIVE_FIELDS"

# Native range baseline. Inspect status and Content-Range before using the bytes.
drive_get -D google-range.headers -o google-range.bin \
    -H 'Range: bytes=262144-524287' \
    "$DRIVE_API/files/$GOOGLE_FILE_ID?alt=media"

# Browser candidate. Start the operation and inspect its result.
GOOGLE_OPERATION="$(drive_get -X POST -H 'Content-Length: 0' \
    "$DRIVE_API/files/$GOOGLE_FILE_ID/download")"
# Poll only while pending. Back off between requests and stop at the probe deadline.
if [ "$(jq -r '.done // false' <<<"$GOOGLE_OPERATION")" != true ]; then
    GOOGLE_OPERATION_NAME="$(jq -er '.name' <<<"$GOOGLE_OPERATION")"
    GOOGLE_OPERATION="$(drive_get "$DRIVE_API/operations/$GOOGLE_OPERATION_NAME")"
fi
# Inspect .error or .response.partialDownloadAllowed without logging the URI.
```

Check `capabilities.canDownload`. A range reader expects `206` and the requested bounds and total length. A whole-object downloader expects a complete file. Establish that a series of ranges belongs to the admitted representation. Test whether the media response provides a usable validator for the current head. If it doesn't, test `files.download?revisionId=<headRevisionId>` where the endpoint supports it, or verify and play a complete local download. By contrast, the `revisions.get` blob download guide calls for a revision already marked Keep Forever. OnePlay must not change users' files or retention settings to make playback work.

The `files.download` method accepts `drive.file`, `drive.readonly` and `drive`. It can return a pending operation. A blob response can advertise partial downloads. The documented operation lifetime says nothing about whether a private returned URI authorizes a bare HTML media request, whether it redirects, or how long it remains usable. For shared files supply any required resource-key header on the start, poll, and final URI request. Try a clean-cookie session and an installed iPhone PWA. Capture startup time, HTTP status and headers for a distant seek, behavior while locked, token/URI renewal, and successor startup. If a URI fails, test an authenticated same-origin range route in the service worker before declaring the PWA provider usable. Keep bearer tokens out of the URL and the DOM. The native baseline remains independently testable.

[Download ordinary blobs and revisions](https://developers.google.com/workspace/drive/api/guides/manage-downloads) · [Download method scopes](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/download) · [Operation response and polling](https://developers.google.com/workspace/drive/api/guides/long-running-operations) · [Poll endpoint](https://developers.google.com/workspace/drive/api/reference/rest/v3/operations/get) · [Drive error reasons](https://developers.google.com/workspace/drive/api/guides/handle-errors)

### 4. Use Google as primary document storage

`drive.appdata` grants app configuration access to the hidden `appDataFolder` for this app and user. It is independent of music permissions. Use `files.list` with `spaces=appDataFolder` and an exact logical name, download by the returned ID, and update by ID. A first write can create a JSON blob using multipart metadata and content. Files in this space cannot be shared, moved out or trashed. Use `files.delete` for a confirmed delete. Verify that the real Web and iOS client registrations see the same app data in a cross-device test.

```bash
drive_get -G "$DRIVE_API/files" \
    --data-urlencode 'spaces=appDataFolder' \
    --data-urlencode "q=name = 'favorites.json'" \
    --data-urlencode 'fields=nextPageToken,files(id,name,modifiedTime)'

drive_get "$DRIVE_API/files/$GOOGLE_DOCUMENT_ID?alt=media"

drive_get -X PATCH -H 'Content-Type: application/json' \
    --data-binary @favorites.json \
    "https://www.googleapis.com/upload/drive/v3/files/$GOOGLE_DOCUMENT_ID?uploadType=media"
```

For the creation request, use `POST /upload/drive/v3/files?uploadType=multipart` with a `multipart/related` body. Place `{"name":"favorites.json","parents":["appDataFolder"],"mimeType":"application/json"}` in the first part and the document in the second. Obtain a file ID with `GET /drive/v3/files/generateIds?count=1&space=appDataFolder` and persist it with the staged create before dispatch. Reuse that ID on an uncertain retry. It prevents duplicate files from retries of that create. Two new devices can still create different files for the same logical name. List all matching IDs and resolve duplicate app documents by the existing document revision rule with a deterministic ID tie-break. Update the selected ID after reconciliation. Read the body of every candidate only when a duplicate exists. Do not claim cross-device compare-and-swap on name. Before using Google as primary, confirm that the intended configuration and derived catalog data fit Google's policy. Google documents app configuration storage and separately prohibits generic backup of a developer app's user content.

[Application data folder](https://developers.google.com/workspace/drive/api/guides/appdata) · [Multipart uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads#multipart) · [Generated IDs and retry](https://developers.google.com/workspace/drive/api/guides/create-file#use_a_pre-generated_id_to_upload_files) · [Drive policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy#appropriate-access-to-and-use-of-google-drive-scopes)

### 5. Read a Google folder share

A named-user share can be mounted through the recipient's Google OAuth connection, with their actual access and the selected folder ID. For an anyone-with-link or public folder, Google explicitly documents listing by folder ID using a project **API key**, without user OAuth. A key identifies the consuming project and its quota. It cannot grant private access. A resource key from the link may also be needed. Discover nested folders with the same parent query and each child's resource key. An API-key scan has no account change feed. Verify the root independently under the bound key before publishing a complete listing. An empty child query alone does not establish root availability. Include API-key root metadata and revocation in the share spike. Compare complete listings on refresh and stage until complete.

```bash
# Use your restricted API key for an owned test fixture. This request has no bearer.
curl -fsS -G "$DRIVE_API/files" \
    -H "X-Goog-Drive-Resource-Keys: $GOOGLE_PUBLIC_FOLDER_ID/$GOOGLE_PUBLIC_FOLDER_KEY" \
    --data-urlencode "key=$GOOGLE_PUBLIC_API_KEY" \
    --data-urlencode "q='$GOOGLE_PUBLIC_FOLDER_ID' in parents and trashed = false" \
    --data-urlencode 'fields=nextPageToken,files(id,name,mimeType,resourceKey,size,capabilities(canDownload))'

# Separate media spike. Check the actual status, bytes and Content-Range.
curl -fsS -D google-public-range.headers -o google-public-range.bin -G \
    -H "X-Goog-Drive-Resource-Keys: $GOOGLE_PUBLIC_FILE_ID/$GOOGLE_PUBLIC_FILE_KEY" \
    -H 'Range: bytes=0-1023' \
    --data-urlencode "key=$GOOGLE_PUBLIC_API_KEY" \
    --data-urlencode 'alt=media' \
    "$DRIVE_API/files/$GOOGLE_PUBLIC_FILE_ID"
```

Omit the resource-key header when the fixture has no key. Add shared-drive flags if applicable. Verify public blob access, range behavior, CORS, and link revocation with no Google cookies or bearer. The vendor explicitly documents anonymous-key listing. The end-to-end media route above is a test candidate, particularly when the resource header prevents assigning the URL directly to `<audio>`. Keep public links optional. Private roots use their existing grants.

[Public folder listings](https://developers.google.com/workspace/drive/api/guides/search-files#list_files_in_a_public_folder) · [Google API key credentials](https://developers.google.com/workspace/guides/create-credentials#api-key) · [Resource-key header](https://developers.google.com/workspace/drive/api/guides/resource-keys)

### 6. Publication and cost implications

The bulk-library verification gate is restricted `drive.readonly`, even if playback uses ordinary `files.get`. Local sync fits a published category. Google still evaluates the actual scope use and app behavior. Prepare evidence of the consent path, initial scan, actual pin/download behavior, and local storage. Separate test and production projects. External Testing authorizations for these scopes generally expire in seven days. The unverified 100-user limit is cumulative for the project, and is separate from a Testing allowlist. Google publishes quotas and tiers for lists, changes and downloads, so record actual request count, throttling, and bytes at representative scale before choosing the rollout. Google calls for an assessment when restricted data can be accessed from or through a third-party server. Treat sending metadata to another provider, proxying requests, or managing refresh credentials on a server as changes to this assessment and ask Google before enabling them.

[Permitted uses](https://developers.google.com/workspace/workspace-api-user-data-developer-policy#appropriate-access-to-and-use-of-google-drive-scopes) · [Verification and assessment](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification) · [Testing audience](https://support.google.com/cloud/answer/15549945?hl=en-MC) · [Lifetime cap](https://support.google.com/cloud/answer/13463817?hl=en) · [Drive quotas](https://developers.google.com/workspace/drive/api/guides/quotas)

## Dropbox API v2

### 1. Bind an account and a root

| Identifier or credential | Role |
|---|---|
| `account_id` | Durable account identity. Obtain it from the token response where present or `/2/users/get_current_account` with `account_info.read`. Use a display name only for display. |
| `id:...` | File or folder ID. A rename or move can retain the ID. A replacement created at the same path gets another ID. Treat the colon as part of the opaque ID. |
| `path_lower`, `path_display`, `name` | Lookup and presentation values. Account listing updates and tombstones are applied by normalized path. Some metadata omits paths, so retain parent context while traversing. Dropbox's API root path is the empty string. |
| `rev`, `content_hash`, `size` | Revision, optional Dropbox content hash, and byte length. Hashing uses SHA-256 over the concatenation of SHA-256 digests of 4 MiB blocks. `client_modified` is supplied by the client and is unsuitable as a version key. |
| Namespace ID | Scopes paths for mounts or team spaces through `Dropbox-API-Path-Root`. Treat path root as part of the binding and keep it stable across calls, including continuation. A team/root change can invalidate it. |
| Cursor | Opaque continuation of the original listing, including its scope and options. Pages and later updates use the same endpoint and advancing cursor. |

[Dropbox identity](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/users/get-current-account) · [File IDs, paths and revisions](https://docs.dropboxapi.com/dropbox-api/docs/file-access) · [Dropbox content hash](https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/content-hash) · [Path-root reference](https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/path-root-header-modes)

1. Register a scoped **Full Dropbox** app for existing user files. Request `files.metadata.read` and `files.content.read`. Include `account_info.read` if using the account endpoint and `sharing.read` when using link-content routes. Full Dropbox describes where an authorized operation can reach. OAuth scopes describe which operations it can perform.
2. Generate an independent PKCE verifier and `state` per attempt. Redirect to Dropbox with `response_type=code`, `code_challenge_method=S256`, your app key, registered callback, and `token_access_type=offline`. The challenge is the unpadded Base64URL of SHA-256 over the ASCII verifier. Verify the callback state and exchange the code with the same verifier. On the PWA use a registered HTTPS callback, and on iOS keep the resulting refresh credential in the native credential store.
3. Verify the account, enumerate candidate folders, then bind the chosen folder ID and any path root. Read the account again if reconnecting with a different token and require the same account to reopen the binding. Serialize token refresh per account. A cancelled listing or read can stop waiting even when the underlying refresh is shared.

```bash
# At callback, after verifying the saved state. Capture the secret response.
DROPBOX_GRANT="$(curl -fsS https://api.dropboxapi.com/oauth2/token \
    --data-urlencode 'grant_type=authorization_code' \
    --data-urlencode "client_id=$DROPBOX_APP_KEY" \
    --data-urlencode "code=$DROPBOX_CODE" \
    --data-urlencode "code_verifier=$DROPBOX_PKCE_VERIFIER" \
    --data-urlencode "redirect_uri=$DROPBOX_REDIRECT_URI")"

# Later, refresh without an app secret. Retain the original refresh token.
DROPBOX_REFRESH_RESULT="$(curl -fsS https://api.dropboxapi.com/oauth2/token \
    --data-urlencode 'grant_type=refresh_token' \
    --data-urlencode "client_id=$DROPBOX_APP_KEY" \
    --data-urlencode "refresh_token=$DROPBOX_REFRESH_TOKEN")"
```

The grant responses above contain secrets. Keep them in memory or a protected credential store. A refresh response issues a new access token and no replacement refresh token. Dropbox production approval is separate from scopes. Development starts with the owner and allows additional users when enabled. Its documented allowance reaches 500 linked users, with a two-week approval window after 50 before further account links can freeze.

[Authorization endpoint and token fields](https://docs.dropboxapi.com/dropbox-api/docs/get-started/authorization) · [Dropbox OAuth and offline access](https://docs.dropboxapi.com/dropbox-api/docs/oauth) · [Production status](https://docs.dropboxapi.com/dropbox-api/docs/developer-resources/developer-guide#production-approval)

### 2. Scan an account folder and handle cursor reset

These examples use `jq` to JSON-escape a fixture folder ID or path and `DROPBOX_ACCESS_TOKEN` obtained privately. A named account folder can be listed by `id:...` or by path. Keep the selected ID as identity.

```bash
dropbox_rpc() {
    local route=$1
    local body=$2
    curl -fsS "https://api.dropboxapi.com/2/$route" \
        -H "Authorization: Bearer $DROPBOX_ACCESS_TOKEN" \
        -H 'Content-Type: application/json' \
        --data-binary "$body"
}

dropbox_rpc files/list_folder "$(jq -cn --arg p "$DROPBOX_FOLDER_ID" \
    '{path:$p, recursive:true, include_deleted:false, include_non_downloadable_files:false}')"

dropbox_rpc files/list_folder/continue "$(jq -cn --arg c "$DROPBOX_CURSOR" '{cursor:$c}')"
```

1. Stage a recursive listing and follow each page in order until `has_more=false`. Save the final cursor with that catalog in one transaction. Work through a wide folder in pages. Dropbox warns a recursive request can fail on very large trees. The fallback is bounded per-folder traversal, with a fresh complete crawl on refresh if a safe incremental continuation for that layout has not been designed.
2. For later refreshes, continue from the committed cursor. Process entries in delivery order. File metadata replaces its path and any old subtree at that path. Folder metadata replaces the folder metadata and may retain its children according to Dropbox's listing rules. A deleted entry removes the path and descendants, even though it has no item ID. Apply path changes in staging, then resolve durable references by ID after the completed update. If the cursor advances on an empty poll, commit the new cursor as well.
3. A `409 reset` means obtain a new complete list. Keep the cached tree while rebuilding. A `409 path` from continuation is a different condition. Verify the bound folder by ID to distinguish removal, loss of access, or a moved root. A new latest cursor without listing would miss historical changes. Use error tags rather than English messages. Retry throttling with the appropriate backoff and serialize requests for the same cursor.

[List folder request and ordered update rules](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/list-folder) · [Cursor expiry and reset](https://docs.dropboxapi.com/dropbox-api/docs/detecting-changes) · [Dropbox error handling](https://docs.dropboxapi.com/dropbox-api/docs/error-handling)

### 3. Open private media by file ID or revision

The content service is `content.dropboxapi.com`. Content arguments go in `Dropbox-API-Arg` as ASCII-safe JSON. The response carries file metadata in `Dropbox-API-Result` and the media in its body. The example uses `jq -a` to escape Unicode in the header. Dropbox documents GET and single ranges for content-download endpoints.

```bash
DROPBOX_MEDIA_ARG="$(jq -can --arg r "$DROPBOX_REV" '{path:("rev:" + $r)}')"
curl -fsS -D dropbox-range.headers -o dropbox-range.bin \
    -H "Authorization: Bearer $DROPBOX_ACCESS_TOKEN" \
    -H "Dropbox-API-Arg: $DROPBOX_MEDIA_ARG" \
    -H 'Range: bytes=262144-524287' \
    https://content.dropboxapi.com/2/files/download

dropbox_rpc files/get_temporary_link "$(jq -cn --arg id "$DROPBOX_FILE_ID" '{path:$id}')"
```

For streaming, resolve current metadata with `files/get_metadata`, check `is_downloadable` and obtain the revision. Read `rev:...` while that version remains available, and check metadata and range headers before mixing bytes. Omit `Range` for a whole download. Check request headers and media response exposure through CORS if browser JavaScript will use them. A temporary link returns content without the bearer header, expires after four hours, and carries Dropbox's caution about direct browser display. Verify whether it works on iPhone before relying on it. The fallback test is a client-side authenticated range route.

[Download by ID or revision](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/download) · [Dropbox content request format](https://docs.dropboxapi.com/dropbox-api/docs/technical-reference/request-response-formats#content-download-endpoints) · [Temporary link constraints](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/get-temporary-link)

### 4. Use Dropbox as primary document storage

Two choices are technically possible. A Full Dropbox grant with `files.content.write` can write app documents in a reserved folder, but the scope applies throughout its authorized Dropbox. A dedicated App Folder app key with read/write scopes confines app documents to its own folder. It requires a separate grant from the Full Dropbox music grant. Before binding both to one primary workspace, verify both resolve to the intended same account. Existing-file browsing cannot be implemented with the App Folder grant alone.

The scoped storage grant owns a designated path such as `/favorites.json` relative to its app root. Read with `files/download` and `Dropbox-API-Arg: {"path":"/favorites.json"}`. Write the content bytes, with a JSON header identifying the logical file. The example assumes the App Folder grant and a local `favorites.json`.

```bash
curl -fsS https://content.dropboxapi.com/2/files/upload \
    -H "Authorization: Bearer $DROPBOX_STORAGE_TOKEN" \
    -H 'Content-Type: application/octet-stream' \
    -H 'Dropbox-API-Arg: {"path":"/favorites.json","mode":"overwrite","autorename":false}' \
    --data-binary @favorites.json
```

Dropbox also supports conditional update with the observed revision, expressed as `"mode":{".tag":"update","update":"REV"}`. The first version can keep OnePlay's existing whole-document reconciliation. Use `files/delete_v2` for removal, treating documented path-not-found as already absent. Upload results contain the committed revision. Use the dedicated App Folder grant for a Dropbox primary so its write authority is confined to app data. The two grants are private to binding. A Dropbox secondary uses the Full Dropbox read grant only.

[Content-access models](https://docs.dropboxapi.com/dropbox-api/docs/oauth#content-access) · [Upload and write scope](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/upload) · [Wire schema for write modes](https://github.com/dropbox/dropbox-api-spec/blob/main/files.stone) · [Delete](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/delete-v-2)

### 5. Read a Dropbox folder share

A shared folder mounted in the recipient's Dropbox can be listed as a normal account folder. The separate link flow does not require mounting that folder.

- Resolve the link with `sharing/get_shared_link_metadata` and establish that it denotes a folder. Call `files/list_folder` with `shared_link:{url,password}`, `path:""` for the root, and `recursive:false`. For each child folder call it again using a path relative to the link root. Continue paginated lists using the returned cursor. Design the first link version as a complete crawl. Verify incremental behavior by folder before relying on link cursors across independent refreshes.
- To open a nested file, call `sharing/get_shared_link_file` with the original link, link-relative path, and `link_password` if applicable. The account file ID itself does not confer link access. Keep the adapter's current item-ID-to-relative-path mapping and compare returned identity or revision on media admission where returned. Re-resolve a renamed path on a completed refresh. Store the link and password as capabilities.
- These endpoints document app and user authentication. App-level client-credentials authentication would require protecting an app secret outside a distributed client. For OnePlay's client-only link adapter, use the recipient's Dropbox OAuth token with the scopes for listing and sharing. Public link web parameters such as `raw=1` address a particular file link. They supply no documented way to enumerate a folder or to derive arbitrary nested file URLs. A link share therefore works as a secondary adapter in principle, with account authorization and an authenticated media route. The wire spec describes a private-link error for some uses of `path` or `link_password`. Verify supported link classes with a second account, no mount, nested Unicode names, a password and a vendor-side access change. A named private folder can use an ordinary recipient mount when available.

```bash
dropbox_rpc sharing/get_shared_link_metadata "$(jq -cn --arg url "$DROPBOX_SHARE_URL" \
    '{url:$url}')"

dropbox_rpc files/list_folder "$(jq -cn --arg url "$DROPBOX_SHARE_URL" \
    '{path:"/Albums",recursive:false,shared_link:{url:$url}}')"

DROPBOX_LINK_ARG="$(jq -can --arg url "$DROPBOX_SHARE_URL" \
    '{url:$url,path:"/Albums/Example Track.mp3"}')"
curl -fsS -D dropbox-share-range.headers -o dropbox-share-range.bin \
    -H "Authorization: Bearer $DROPBOX_ACCESS_TOKEN" \
    -H "Dropbox-API-Arg: $DROPBOX_LINK_ARG" \
    -H 'Range: bytes=0-1023' \
    https://content.dropboxapi.com/2/sharing/get_shared_link_file
```

The Dropbox docs describe shared-link passwords as `password` inside the listing's `shared_link` object and `link_password` in the two sharing requests. Check `206`, `Content-Range`, and metadata on the actual shared content response before admitting it for range playback.

[Folders and link grants](https://docs.dropboxapi.com/dropbox-api/docs/sharing) · [List with shared_link](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/files/list-folder) · [Link metadata](https://docs.dropboxapi.com/dropbox-api/api-reference/user-endpoints/sharing/get-shared-link-metadata) · [Link media and private-link errors](https://github.com/dropbox/dropbox-api-spec/blob/main/sharing.stone#L358-L401) · [Direct-link parameters](https://help.dropbox.com/share/force-download)

## OneDrive and Demo

### Existing OneDrive account and share

The primary OneDrive binding uses the verified Microsoft consumer account and Graph drive ID. The actual root is the Music special folder. The indexer reads one `$top=10000` children page per folder, uses schema and recursive size for cache reuse, and stages its Graph batches. The same primary token currently authorizes both the library reads and `/me/drive/special/approot` cache operations. The drive ID and item ID remain Graph locators. Resolve download metadata with these IDs and pass the returned short-lived `@microsoft.graph.downloadUrl` to the existing range transport, without the Graph bearer.

For an existing OneDrive link, base64url-encode the full UTF-8 link without padding and prepend `u!`. With the recipient token, query `/shares/{encodedLink}/driveItem` and recover the root's drive and item IDs. Current code uses `Prefer: redeemSharingLink` and then accesses the drive/item routes. Microsoft lists a bearer requirement for Graph `/shares`, with `Files.ReadWrite` as the documented delegated minimum even for Personal accounts. The repo requests `Files.Read` plus app-folder write access. Preserve the working route and treat reachability with a new read-only grant or account type as a live test. A view-only shared source is a OnePlay capability even if the provider's grant for redeeming a link includes broader permission. If the read-only grant cannot redeem a link, test accepting it in the vendor flow and then mounting the resolved folder using the recipient's read grant. Current availability probes verify account access to the resolved item. Revoking one link can leave account access in place through a second link or direct share. Claim link-specific denial only after testing a bound-link probe that does not silently redeem again. Explicit local detach always retires its own route.

If OneDrive is secondary to Google, Dropbox, or Demo, the secondary has no writable Graph app folder. It also cannot use another OneDrive account's `/me` cache with its bearer. The existing Graph batch path stays when the primary grant can authorize both endpoints. Keep an independent secondary's per-folder cache in local storage using the same schema/size checks. A remote mirror to the authorized primary can be a separate operation if permitted. The OneDrive adapter owns which cache path it uses and preserves its existing persisted schema and behavior. These independent grants make it unsafe to pass a workspace-wide authenticated fetch into a source.

[Current scopes and auth](music/src/auth.ts) · [Graph batch and schema 1](music/src/indexer.ts) · [Current shares](music/src/shares.ts) · [Microsoft app-folder API](https://learn.microsoft.com/en-us/graph/onedrive-sharepoint-appfolder) · [Share redemption](https://learn.microsoft.com/en-us/graph/api/shares-get?view=graph-rest-1.0) · [Graph media](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content?view=graph-rest-1.0)

### Demo and the boundary of public shares

| Source | Catalog with no end-user login | Seekable media with no end-user login | First-release decision |
|---|---|---|---|
| OneDrive public or anyone-with-link folder | Its public web share can be opened subject to policy. The documented Graph shares route requires a bearer. | A short-lived Graph content URL works once acquired. The application needs a way to obtain and renew it. A folder link alone does not establish that route. | Keep signed-in OneDrive share support. The demo's OneDrive folder can supply a pregenerated fixture. |
| Google public or anyone-with-link folder | Google documents API-key listing. Some children need resource-key headers. | Public `alt=media` with key and any required resource header is a concrete spike. Confirm media access, `206` and installed-PWA behavior. | Valid candidate for a public secondary provider. Ship only after the no-cookie and revocation tests. |
| Dropbox public folder link | The dedicated API accepts a user or app bearer. Each folder is a separate listing. | Link-relative content download uses one of those bearers. Client credentials would require a server-side secret. | Signed-in Dropbox link is a secondary candidate. A login-free Dropbox folder adapter has no established client-only API route. |
| OnePlay Demo fixture | Immutable manifest bundled with the app. | Bundled files through Swift's local decoder, plus public static HTTPS files to exercise range reads and downloads. | Use for App Review first. |

Demo's local workspace uses a separate persistent WebKit store and native playback/pin store. Commit a complete catalog and favorites membership on first use, and restore that binding before adopting background download tasks. Give the static sample host its own connectivity evidence. Reviewers can play locally from a fresh installation, then exercise actual pin transfer, offline launch, and playback after download. Choose recordings with verified redistribution rights. Seek Apple approval for an integrated demo under guideline 2.1(a) before relying on it in place of review credentials.

[Current native store and task ownership](music/ios/App/LibraryController.swift) · [Apple App Review §§2.1 and 5.2](https://developer.apple.com/app-store/review/guidelines/)

## Proposed in-app API

The workspace owns local data and has one optional remote document store. The primary account normally supplies both that store and the first music source. A secondary connection supplies a music source only. A connection can bind several roots using the same grant. The existing root key identifies a durable mount and the item ID identifies a recording or folder within it. Reauthorization keeps the mount key. Local callbacks capture the attachment that admitted them, so a late reply cannot publish to a replacement binding. The primary storage binding is verified independently of every secondary grant.

### TypeScript

```ts
type MediaRef = Readonly<{ sourceRootKey: string; itemId: string }>;

interface MusicSource {
    refreshCatalog?(signal: AbortSignal): Promise<MusicFolder>;
    playbackUrl(itemId: string, signal: AbortSignal): Promise<
        Readonly<{ url: string; expiresAt?: number }>
    >;
    download(itemId: string, signal: AbortSignal): Promise<Blob>;
}

interface PrimaryStore {
    read(name: string, signal: AbortSignal): Promise<string | null>;
    write(name: string, text: string, signal: AbortSignal): Promise<void>;
}
```

**Catalog.** The existing `MusicFolder` and `MusicFile` tree is the view contract. A child key is its navigation segment. A new source can set an optional display `name` on a node. OneDrive schema 1 uses names as keys and continues using its current index directly. Google uses its IDs as keys and supplies names, so two siblings named `Track.mp3` are separate children. Display and sort use the name when present, then break ties by key. Keep key lookup direct, traversal time-sliced, and the OneDrive on-disk format and path healing behavior intact. Resolve labels from the nodes in breadcrumbs, search, favorites and track titles. An ID-keyed source follows existing item IDs after moves or renames and uses paths as navigation hints.

**Restore and refresh.** Source binding creation verifies its own account and folder or link. Local restore hydrates a binding and its last complete catalog together before any network I/O. Demo loads a pregenerated tree from the bundle. The coordinator schedules refresh only for sources that provide `refreshCatalog`. In the bundled app, live refresh uses the native provider transport behind the bridge. Native playback and pins use the Swift lookup below, independently of WebKit. A refresh resolves to a complete usable tree, or returns the same folder for a confirmed no-change check. A disappeared item leaves the usable tree and loses admission even if its reference remains. For new providers, keep unresolved favorites and pin intent until the item returns or the user removes the intent or disconnects the source. This is an explicit launch policy. Google can omit a child because permissions changed. Automatically pruning proven deletions would require carrying durable removal evidence through a crash between the checkpoint commit and the favorites commit. Leave that behavior out of the new provider contract. The legacy OneDrive adapter retains its existing complete-index, path-first healing. The source stages partial scans privately and commits any adapter checkpoint with its complete catalog. The coordinator owns scheduling, publication, progress wiring through the existing indexing callback, and healing. It publishes only if the attachment still owns the result. A failed refresh preserves the previous tree and cannot establish deletions.

**Browser media.** The bound adapter returns an HTMLAudioElement-compatible URL and its conservative expiry in Unix milliseconds. A stable bundled or same-origin route can omit expiry. The existing URL engine caches ready next URLs synchronously, and the OneDrive adapter owns its Graph expiry interpretation. The offline engine requests a complete `Blob` via `download` and commits it under the active attachment. The adapter owns the HTTP response, validates whole-object admission, and handles body failures before returning the Blob. Some audio URLs are playable across origins without being readable as bytes by JavaScript. Keeping separate playback and download calls meets both needs without pushing CORS or OAuth into callers. For browser requests carrying OAuth or vendor capability headers, default to `redirect: "error"` on the verified API origin. A direct media route requires a separately acquired safe URL or a verified provider transport. Browser manual redirects are opaque, and cross-origin stripping of `Authorization` alone does not protect custom headers. [Fetch redirect rules](https://fetch.spec.whatwg.org/#http-redirect-fetch) Use the existing browser Blob lifetime rules for offline playback.

**Primary documents.** Names are app-owned logical keys. A `read` resolves to null only on confirmed absence. A `write` resolves after provider acknowledgment of a complete replacement. Keep local-first transactions, coalescing, and the current whole-document conflict policy. Adapter-specific cache cleanup, such as deleting an existing OneDrive share index directory, stays in the owning adapter. Demo has no remote store. The workspace calls only its bound primary store. Secondary adapters may manage their private local state.

### Swift

Carry the same `MediaRef` over the existing queue and offline-pin bridge. Replace the positional drive and item arguments to the native lookup. Keep its existing admission hints and return type.

```swift
struct MediaRef: Codable, Hashable, Sendable {
    let sourceRootKey: String
    let itemId: String
}

typealias Lookup = @Sendable (
    _ item: MediaRef, _ hint: MediaLookup, _ wifiOnly: Bool
) async throws -> MediaLocation
```

Extend the existing `MediaLocation` with a GET request template in place of its bare URL. A OneDrive CDN request has no authorization headers. A Dropbox range request can carry bearer and `Dropbox-API-Arg`. A Google range request can carry bearer and a resource key. Keep size, admitted version, resource validation and rejection state. Existing `.reuse(admitted)`, `.replace(rejected)`, and `.fresh` behavior preserves demand, successors and renewal. Renew the location on a rejected credential using the existing bounded retry. The range engine adds its range and path policy, and the background downloader submits the whole-object request. In-process transfers enforce provider-origin and redirect policy before sending credentials. Rebuild redirects with only the headers valid for the destination. Vendor-specific headers and query capabilities are private. iOS background sessions follow redirects without calling the redirect delegate. Submit only vetted background-safe requests, such as current Graph CDN or Demo requests without authorization headers. For header-bearing requests without a verified final endpoint and redirect contract, use an in-process pin transfer that can enforce policy, or leave the background capability gated. A daemon failure may requeue with a fresh approved request. Before publishing a pin, check length, representation and the binding that admitted it. [Apple background-session restrictions](https://developer.apple.com/documentation/foundation/downloading-files-in-the-background)

The trusted Demo manifest maps IDs to bundled file URLs for the existing local decoder route. Admission checks the active Demo binding. Bundled recordings count as locally playable alongside cached pins. Only the sample-host recordings exercise the background transfer. This keeps the native remote lookup contract about remote media and avoids a separate local/remote media type.

### Access and lifetime invariants

- Keep the existing queue occurrence key. The durable media reference is the encoded pair `[sourceRootKey,itemId]`. The native range pool and pinned inventory also bind the version to the verified recording. Never parse raw IDs at a colon. Keep existing OneDrive cache keys readable within their legacy workspace, and scope new cached bytes to their own source. Use the last positive local admission to play cached bytes through offline or token-expired periods, subject to source policy. Require both root and item admission for browser URL cache hits, native prefetch reuse and final pin commits. A later item denial or confirmed departure from the bound root withdraws admission even when the same mount is still connected. Preserve unresolved intent on ambiguous absence. Queue-only edits do not withdraw physical media access. A synced descriptor or remote catalog by itself proves no access on a fresh device. An explicit share expiry withdraws access at the recorded time, including offline. OAuth and media URL expiry are different clocks and by themselves do not revoke locally admitted bytes.
- Classify failures as transient, reauthorization needed, confirmed root denial, or item absent. A CDN rejection or an item-level 404 does not prove root revocation. Classify raw 403 and 404 by endpoint and vendor reason, including Google quota and permission errors. A temporarily inaccessible source keeps its last complete tree and durable references. Confirmed access loss fences the root using the existing access policy. The coordinator and pin pumps admit work per source or shared grant, so losing one secondary token cannot stop the primary state writer or another source's downloads. A dependent OneDrive share may pause with its grant. Network reachability can still be shared.
- Persist source descriptors before referencing them from cloud documents, or admit unresolved descriptors locally until dependencies arrive. When attaching an unresolved descriptor from another device, verify the provider account and actual root before reusing its key. For a link, verify the provider's link identity or the saved capability fingerprint and any root ID it can prove. Dropbox can omit the link metadata ID. In that case require the same verified capability under the expected grant, or keep the descriptor unresolved. Different links may point to the same provider folder. A user-initiated detach retires the mount key for new sources. Readding allocates a fresh key. Preserve the synced connection UUID used to invalidate old OneDrive share pins. Resolve legacy Graph share-key aliases inside the migration adapter because the old fallback can embed the encoded share URL. Tokens, passwords, bearer-capable links and signed URLs are never included in a new generic document or queue. Preserve existing OneDrive share storage as an adapter-specific compatibility path. Local in-flight work must recheck the attachment before committing. For a late native background completion, the persisted transfer ticket must still match the admitted workspace, mount and item before the manifest acknowledges its file.

### What is stored in the primary cloud

| Data | Location and authority |
|---|---|
| Favorites, playlist order, pin intent and durable source references | The workspace commits locally, then syncs app documents through its primary store when it has one. Connection secrets stay in their platform credential store. A second device must reconnect a credentialed source before it can browse or play it. |
| Existing OneDrive catalog and share caches | Keep Graph app-folder paths, schema 1 and reuse rules in the OneDrive adapter. They use the existing primary write grant. |
| New provider catalogs | Keep a complete local catalog and adapter checkpoint per source. A cloud primary release includes mirroring each eligible source's complete view to that primary's app storage. |
| Offline media and transport state | Device storage. Tokens, signed URLs, content request headers, and temporary download grants stay in their adapter or platform transport. |

A mirror uses the existing `read` and `write` methods under a logical name such as `catalog.<opaque-mount-key>.json`. Its body contains the catalog schema version, mount key and complete visible tree. The coordinator schedules the write after publishing a complete local catalog, only when the primary policy allows that source's metadata. The receiving device verifies the intended source grant and root before using the mirror. Keep it in staging until the source's metadata policy permits provisional browsing. A current root check does not establish that each mirrored item is still inside that root or readable. Playing, prefetching or pinning a mirrored item on a fresh device requires a verified refresh or an equivalent item-in-root check inside the adapter. Keep provider checkpoints and capability fields local in the first version. A fresh device may perform a complete scan to establish its own checkpoint. A verified local catalog always takes precedence over a cloud mirror. Store complete local catalog and checkpoint together for subsequent incremental refreshes on that device.

The Demo refactor requires local catalog storage and preserves the existing OneDrive cloud layout. Google and Dropbox primary integrations include their approved cloud catalog mirrors as part of their release. A newly added secondary stores its catalog on the primary only after that source-to-primary transfer is approved. The default for an unapproved combination is device-only. The entire catalog is a single logical document. Choose the provider's large-upload route when required rather than exposing chunks at the app boundary.

Google applies Limited Use to derived data, including IDs and paths, and constrains transfers to others. Hold Google-as-secondary under a different cloud-synced primary until the catalog and mixed favorites transfer is authorized and its assessment impact is resolved. A local-only workspace can retain intact mixed favorites. Filtering them under today's whole-document conflict rule could lose edits. For Google as primary, verify the expected app configuration and catalog uses with Google. Existing OneDrive-to-OneDrive share mirroring is current behavior. [Google Limited Use policy](https://developers.google.com/terms/api-services-user-data-policy#additional-requirements-for-specific-api-scopes) · [Restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)

### Integration points

| Existing code | Smallest extraction |
|---|---|
| `index.ts`, `index-startup.ts`, `index-sync.ts` | Bind and restore the workspace and its source registry, load cached roots, and call their refresh operations. Keep Graph probes, share redemption and batched per-folder cache work together in the OneDrive implementation. |
| `favorites.ts`, `shares.ts` | Keep local edit serialization and cloud reconciliation. Inject the primary store at existing Graph document reads/writes. The connection code supplies source bindings and keeps credentials. |
| `roots.ts`, `tracks.ts`, `playback-engine.ts`, `downloads.ts` | Carry the source-qualified reference from catalog to media. Keep playlist occurrences independent of byte identity. Route each offline job through its own source rather than the primary grant. |
| `LibraryController.swift`, `NativeAccount.swift`, `NativePlayback.swift`, `OfflinePins.swift` | Keep the native account/session and browser document lifetimes. Wire source-qualified media lookup at the existing injection points. The native controller admits Demo locally and owns the binding before background URLSession adoption. Use explicit root admission for new mounts. The existing native `share:` key prefix rule only covers legacy shares. The persisted local-only stores need migration that preserves user data across DB upgrades. The current IndexedDB upgrade deletes stores assuming they can be rebuilt from OneDrive. |

[Startup and indexing contracts](music/ai/ARCHITECTURE.md) · [IndexedDB upgrade behavior](music/src/db.ts) · [Original OneDrive index tradeoffs](music/ai/PLAN-M3.md#learnings-from-example-code) · [Browser favorites I/O](music/src/favorites.ts) · [Native lookup and pins wiring](music/ios/App/LibraryController.swift)

## Does the API fit?

### Worked call sequences

**OneDrive primary with a Dropbox secondary.** Restore the OneDrive workspace and its writable Graph app folder, plus the cached tree for each source. The Dropbox mount uses its own account and selected root. A favorite points to `{sourceRootKey:"dropbox-root",itemId:"id:album-track"}`. Saving it commits locally before the workspace calls `primaryStore.write("favorites.json", document, signal)` with the OneDrive grant. Playing it routes to the Dropbox adapter. Native media lookup uses that file's revision and the Dropbox transport. Browser pinning calls Dropbox `download`. The Dropbox token has no music write scope. If its grant expires, the OneDrive writer and other admitted pin jobs continue. If Dropbox returns a cursor reset, retain the last complete Dropbox tree and relist.

**Google primary with a OneDrive secondary.** The Google grant binds a real folder ID for music and authorizes app configuration with `drive.appdata`. The OneDrive secondary lists using its own bearer. Its OneDrive indexer cannot batch cache calls addressed to the Google primary. Store its per-folder cache locally so subtree reuse still works. For production cloud storage, mirror the complete catalog to the Google app-data folder once this cross-provider metadata use is approved. The primary's storage grant never authorizes the OneDrive source. Reopening the saved queue resolves the OneDrive reference through its old grant and cache metadata, while the primary storage continues to use Google credentials. The source-private batch strategy and cache format remain intact.

**Nested Dropbox folder link under a OneDrive workspace.** The share bind verifies the URL with Dropbox. Mount identity identifies that link, and the Dropbox grant is attached to it. Refresh descends through link-relative paths and publishes a complete tree. The saved media reference uses the listed Dropbox ID. Opening it resolves the latest relative path in the link catalog and uses `sharing/get_shared_link_file` with the same link grant. A rename changes that private mapping. A removed file produces an item failure. A failed root link probe can deny the whole mount. An App Folder or signed-in owner account is irrelevant to the source's authority.

**Demo and a future Google public link.** Demo loads its immutable catalog at startup. Bundled recordings play locally. The hosted sample album uses the normal remote and pin paths, with the Demo binding and static host as evidence. A Google public source, if proven, would bind its folder ID and resource keys with a project API key, refresh by complete enumeration, and resolve its own locators. Neither source needs a primary store or an OAuth account to satisfy the catalog interface.

The pin caller routes by the saved reference and rechecks admission after the body is read.

```ts
const before = mounts.get(ref.sourceRootKey);
if (!before) throw new Error("Source is disconnected");
const blob = await before.source.download(ref.itemId, signal);
// On commit, verify the captured mount and that this item is still admitted.
// Publish neither a stale attachment result nor a late result for a denied item.
await commitAudioIfCurrent(ref, before, blob, signal);
```

The native bridge does the same routing with `Lookup(ref, hint, wifiOnly)`. Pin records still identify the local binding that admitted their work. When that binding is retired, an outstanding transfer cannot write to the next workspace. A public share, authenticated account and primary app store all use different capabilities even if two point at the same physical bytes.

### Provider coverage

| Binding | Catalog source | Primary document storage | Secondary authority |
|---|---|---|---|
| OneDrive account | Existing Graph batches and size heuristic. | Existing Graph app folder and optimized indexes. | The secondary account's own read grant. Its cache is local. Approved portable copies can go to the primary. |
| OneDrive folder link | Existing redeemed root and same-grant scan. | Inherits the workspace primary store only for permitted cache writes. | Recipient Graph grant and its resolved root. Test link redemption under read-only grants. |
| Google account or named share | ID-based scan with a user or shared-drive changes feed. | Google account with separate `drive.appdata` scope. | Recipient's read grant. Google-derived cloud transfers have the policy gate above. |
| Google public link | API-key folder listing and resource keys where needed. | Uses its workspace's primary if the mirror is permitted. | Public file access under that link. Anonymous media and PWA support are live gates. |
| Dropbox account or mounted recipient folder | Recursive folder cursor or staged per-folder fallback. | Dedicated App Folder write grant, paired with the account's Full Dropbox read grant. | Read scopes on the independently verified receiving account. |
| Dropbox folder link | Nonrecursive link listing with per-folder traversal. | Uses its workspace's primary if the mirror is permitted. | Account OAuth plus link scope and any required link password. Verify compatible link classes. |
| Demo | Bundled catalog and static sample media. | Persistent local workspace. | Local manifest and approved static origins. |

### Evidence and release gates

| Case | What the proposed API must produce | Evidence or acceptance test |
|---|---|---|
| OneDrive primary upgrade | The same cache files and reuse behavior, same playlist healing, and usable existing offline/pinned tracks. | Compare legacy and refactored output using a real schema-1 PWA and iOS cache. Idle/offline launch, cached playback, Graph redirect, a successor prefetch, and a share reconnect repeat the current behavior. Probe a second OneDrive grant with no app-folder write permission. |
| Google account, duplicate names and scan restart | Two same-named files get distinct media references. An interrupted scan preserves its last complete index, and the next refresh replays from the correct token. | Create same-name tracks and sibling subfolders, churn the tree during the scan, and move a folder containing existing recordings into and then out of the root. Interrupt after a page, force a rejected listing token, and compare the final tree to a fresh listing. Also test corpus access removal and same-size rewrites. |
| Dropbox account, dormant or very large | A valid cursor gets small changes. An invalid one triggers safe rebuild. An ID reference follows a rename. A path deletion removes only the affected tree. | Force a cursor reset in a fixture and verify last catalog retention, then resume with a staged complete list. Test the documented per-folder fallback at scale. Exercise an unchanged poll that still advances its cursor. |
| Primary document storage | Only the primary store sees writes. A secondary is independently reconnectable. Missing documents are distinguished from failures. | On a second installation, load the same workspace documents and reconnect a source. Try a mirrored item that moved outside the root but remains readable by ID. Test wrong account, two first Google app-data writes with the same name, save while offline, interrupted cloud replacement, and Dropbox App Folder plus Full Dropbox grants. Confirm cross-provider storage authorization where applicable. |
| Multiple sources and a grant failure | One secondary can pause without blocking others. An explicit detach fences its pending work and old queue. | Expire A while playing or pinning B and saving primary favorites. Replace A's grant during a download. Then withdraw just one item while a URL is prefetched and a pin is completing. Disable a shared link with the same recording still admitted through another source and verify only the revoked route stops. Distinguish item-level missing from a confirmed root denial. |
| Native authenticated media | Range reads, whole transfers and byte identity remain correct through renewal and source changes. | On iPhone, compare start and distant seek, same-length content replacement mid-stream, access revocation, locked advancement, and completed offline reads. Exercise a credentialed redirect and a delayed background transfer. Record the headers actually sent and the final response origin. |
| Installed PWA with private or public media | The HTML player has a seekable URL, and the offline engine can read the complete content. | Check Google LRO URI and Dropbox temporary URI in a clean browser and installed iPhone PWA. Verify ranges with no cookies, PWA renewal at expiry, and lock-screen transition. Exercise public Google key plus resource key and authenticated Dropbox link content, including no mount, non-ASCII names, password and revocation. |
| Demo on a clean install | Complete first catalog, working local media, real remote pin transfer, and isolated local state. | Fresh install on LuPhone13. Begin offline, play a bundled recording, go online and pin the sample album, then relaunch offline and play it. Verify seek, locked advancement and persistence. Confirm the built-in review path with Apple before submission. |

The common API exercises a published capability for private Google and Dropbox catalog enumeration, app-document reads and writes, and authenticated native content reads. Its share coverage includes OneDrive's existing route, Google public catalog enumeration, Google named-user shares, and Dropbox's OAuth link routes. Direct PWA playback, no-login public Google media, concurrent SDK sessions on native iOS, and credentialed background transfers still require the tests above. Each has a bounded fallback or an unreleased combination.

### KISS decisions

- Reuse the existing view tree, with optional labels for sources that key children by ID. Leave `MusicData` and the original OneDrive cache behind the adapter. This avoids a second projected tree for every refresh.
- Keep two browser media calls because HTML playback and an offline Blob have different requirements. Keep HTTP responses inside adapters. Native needs one request lookup because it controls both consumers. Reuse its grant-renewal modes instead of adding a new lease protocol.
- Keep the primary store to two document operations. The current favorites and share writers save whole documents, including an empty collection. Only existing adapter-private cache cleanup deletes files.
- Return the existing tree from refresh. Retaining unresolved intent for new sources avoids a new deletion-proof payload and crash-recovery protocol. Derive availability from bound source operations and the existing evidence scheduler. Expose neither a vendor-neutral OAuth API nor a paginated list or change-event interface. OneDrive size checks, Google changes and Dropbox cursors are each private implementation details.
- Defer provider-wide deduplication and index migration. Preserve current OneDrive alias reuse where its access proof and byte identity are already known. New sources can use isolated bytes scoped to their mount and recording identity.

### Independent KISS review and verification

Four fresh GPT-6.2 Sol High reviewers evaluated successive revisions against the repository and vendor documentation.

| Round | Finding incorporated |
|---|---|
| 1 | Reused the existing tree and Swift lookup. Removed generic store deletion and a new local-media result type. Kept source-specific browser URL expiry. Separated OneDrive's same-grant Graph batch from independent secondary cache storage. |
| 2 | Added independent grant admission, stable reconnect and detach identity, and explicit cloud transfer policy. Caught Apple's background redirect behavior and the distinction between a missing item and an inaccessible item. |
| 3 | Reduced browser offline downloads to Blob and removed the proposed deletion-proof result. Retained unresolved references for new sources. Required item-level admission, backed cloud catalog storage with the same two document operations, and tightened public and private share tests. |
| 4 | Confirmed the five TypeScript operations and existing Swift lookup. Clarified that a verified root does not grant access to every entry in a stale mirror. Added a two-device test where a Google item remains readable by ID after moving outside the selected root. |

The TypeScript and Swift declarations compiled using the referenced shapes or minimal stubs. The shell and JavaScript examples parsed. A mocked Dropbox link request and six local contract cases passed, covering duplicate labels, legacy child keys, opaque IDs, independent primary storage, retired mounts, and item withdrawal during a download. Live provider requests and physical-iPhone playback remain release tests. The verified evidence here is the vendor contract, existing code, and local behavior of the proposed boundary.

# OnePlay TODO

## Google Drive support for Music

**Decision pending.** Defer implementation until we have guidance on whether Google would approve public use of `drive.readonly` for OnePlay. The feature would let a listener choose an existing Drive folder, play its music, and pin folders or playlists for offline listening. The narrower `drive.file` scope does not grant recursive access to existing tracks when the user selects their parent folder. Google lists local file sync as an eligible use for restricted scopes. The uncertainty is whether optional offline sync qualifies when music playback is the app’s primary purpose. [Drive scope policy](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)

**Next action.** Ask in the official Drive developer forum or, if available, through Google Workspace developer support. Formal verification requires a working OAuth flow and a demo of how the app uses the scope. An answer now would help us decide whether to invest in that work. [Developer support channels](https://developers.google.com/workspace/drive/api/support) · [Verification requirements](https://support.google.com/cloud/answer/13461325?hl=en)

> OnePlay is a browser-based music player that currently supports OneDrive. For Google Drive, a listener would choose a folder containing their own music. The browser would index its existing tracks, discover later additions, play tracks directly from Drive, and synchronize user-pinned music to the device for offline playback. The app’s server would receive no filenames, audio, or OAuth credentials.
>
> Would this use qualify for `drive.readonly` under the local-sync category when playback is the primary purpose and pinning is optional? Is there a narrower scope that supports this existing-folder workflow?

**If the guidance is encouraging**, prototype two private tracks on an installed iPhone PWA. Try Drive’s `files.download` URI and test seeking, locked-screen advance, and access-token expiry. If playback passes, address duplicate filenames with ID-based navigation, isolate account storage, and build a resumable folder scan with a Drive changes token committed alongside the local index. If eligibility remains unresolved, keep public Google Drive support on hold. [Provider evaluation and technical background](google-dropbox.md) · [Drive download operations](https://developers.google.com/workspace/drive/api/guides/long-running-operations)

## Native iOS playback and OneDrive sign-in for Music

**Recommendation.** Prototype a Swift app that bundles the existing HTML and JavaScript in a `WKWebView`. Today, even when OnePlay has prefetched the next track, JavaScript must receive the audio element’s `ended` event and start playback. The design goal is that a listener can press Play, lock the phone, and reach the tenth track without the web view running again. Native sign-in also lets the listener reconnect to OneDrive without losing their place in the library. [Current track transition](music/src/playback.ts) · [Apple’s background playback guide](https://developer.apple.com/documentation/avfoundation/configuring-your-app-for-media-playback)

**Queue and playback.** TypeScript keeps the library, favorites, search, indexing, and foreground sync. When the listener chooses music, it sends Swift the ordered queue, starting position, and mode. Each entry carries its logical playlist path and its OneDrive drive and item IDs, so two appearances of the same recording can share a file and still have distinct places in the queue. Swift owns the live queue, shuffle and repeat, sleep timer, per-favorite resume position, and lock-screen controls. On return, the web UI reads the current track and position from Swift.

**Audio files.** Use an `AVQueuePlayer` with a playback audio session and the background audio capability. TypeScript decides which favorites are pinned. Swift stores one local file per recording so the player can open it while locked. For streaming, Swift resolves a fresh OneDrive URL shortly before a track plays. Only the next few items need preparing, even for a queue of 30,000 tracks. [AVQueuePlayer](https://developer.apple.com/documentation/avfoundation/avqueueplayer) · [Graph download URL lifetime](https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0#instance-attributes)

**OneDrive sign-in.** The current browser flow uses a refresh token with a fixed 24-hour lifetime. Add the iOS/macOS platform to OnePlay’s existing Entra registration so the app keeps access to the same OneDrive app folder for favorites, shares, and indexes. Use MSAL for iOS as the single sign-in for playback and library requests. It can renew access silently and present a system sign-in sheet when Microsoft requires interaction. [Refresh-token lifetimes](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens) · [MSAL for iOS](https://learn.microsoft.com/en-us/entra/msal/objc/acquire-tokens)

**Next action.** Try one playlist on a physical iPhone before porting the download manager. Proceed if all three checks pass:

1. Lock the phone and skip past the prepared tracks. A streamed track must start using a URL Swift obtains while locked.
2. In airplane mode, play consecutive downloaded tracks, then interrupt playback with a call or headphone disconnect. Reopen OnePlay and check that the footer and the favorite’s saved position match what played.
3. More than 24 hours after initial sign-in, open the library and refresh it. Sync must succeed with the library still on screen.

The main ongoing cost is keeping playback behavior consistent between Swift and the PWA’s TypeScript player, especially shuffle order, timer expiry, and “remember my spot.”

## OnePlay Video

**Start with the workout.** Pick *Pumpin’*, a playlist drawn from a OneDrive folder of ’80s and ’90s music videos, tap Shuffle, and cast it to the living-room Chromecast. The appeal is the surprise of what comes on next, like watching MTV. Someone who has arranged *My treadmill workout* to match a warm-up, a run, and a cooldown can press All to play it in order. Music’s five playback modes cover both uses (All, Repeat, Shuffle, One, and Timer).

**Keep the familiar library.** Reuse Music’s folder view, selection, playlists, favorites, and shortcuts. A workout starts each clip at the beginning. For a DVD-ripped film or BBC episode, offer “Resume at 48:12” using a position saved against the file. That lets someone stop an episode on the TV and pick it up on the phone the next night, even if they open it through a different shortcut. A series favorite can remember the current episode, much as an audiobook favorite remembers its chapter.

**Put the player where the picture is.** On the phone, give the video the main viewing area, with a conventional seek bar, fullscreen, and captions. While casting, show what’s playing on the TV, the playback controls, and the upcoming queue. Browsing for another clip should leave the TV playing.

**Casting must survive a switch to Messages.** Use the native iOS Cast sender SDK in the proposed Swift host. Give the Chromecast the ordered or shuffled queue so it can fetch and advance through clips while the iPhone is busy or locked. On return, the phone reads the receiver’s current clip and position. Timer must also stop the TV at its deadline while OnePlay is backgrounded. Start with Google’s default receiver and verify how long a OneDrive queue stays playable given its short-lived download URLs. [iOS Cast SDK](https://developers.google.com/cast/docs/ios_sender/integrate) · [Cast queue behavior](https://developers.google.com/cast/docs/ios_sender/queueing) · [OneDrive download URLs](https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0#instance-attributes)

**First prototype.** Use an iPhone, the living-room Chromecast, and files from the actual collection.

1. Cast four clips. Open Messages before the first ends, stay there through two transitions, then return and press Next. The phone should show and control the clip actually on TV. Repeat with a full workout to exercise older URLs, and with a short timer to verify the TV stops on time.
2. Cast a BBC episode, try its subtitles, and seek halfway through. Stop casting, then resume on the phone the following night. This tests the bookmark and whether the actual rip’s video, audio, and subtitles work on both screens. [Cast media support](https://developers.google.com/cast/docs/media)

**Later options.** For offline viewing, consider downloading a selected episode or playlist with its size shown up front. For a home NAS, establish how the Chromecast would fetch the video as well as how OnePlay would browse the share. A media server such as Jellyfin is worth exploring if the collection needs format conversion. [Jellyfin playback options](https://jellyfin.org/docs/general/post-install/transcoding/)

## Attach behaviors to existing folders

The only way we have to set "remember my spot" or "available offline" is through making something a shortcut or a playlist.

Also I don't actually even know where "one/shuffle/all/repeat/timer" is stored. I tried setting it to One while playing a track from OneDrive, then I played a song from a favorite folder (which changed it to Shuffle), then I went back to another folder in OneDrive and played a songe there and it got reset to All.

My only user so far has asked if the affordance can be made not only to shortcuts/playlists, but also to folders within their OneDrive directly.

I'm not quite sure how that would work.
- Would we allow "make available offline" on per-track basis within OneDrive, or only for folders?
- Would we maybe display stars next to folders within OneDrive? Or just the "offline" button?
- I don't know where to anchor the "one/shuffle/all/repeat/timer" choice for folders within OneDrive. Would it be only for starred folders within OneDrive? I can imagine this getting really confusing.
- Or maybe it would solely be an offline thing? (But then, there'd be the danger that a user might forget which things they had made available offline, buried deep within their OneDrive)
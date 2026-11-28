# OnePlay TODO

## Google Drive support for Music

We will support Google Drive (and later Dropbox) as a store of music.

Prototype on an installed iPhone PWA. Try Drive’s `files.download` URI and test seeking, locked-screen advance, and access-token expiry.

If prototype passes, address duplicate filenames with ID-based navigation, isolate account storage, and build a resumable folder scan with a Drive changes token committed alongside the local index. 

The issue is that `drive.file` scope is available to everyone, but `files.download` requires verification of the app. The fact that our app is simple+local means we might not have to pay for the more expensive server validation. We would do Google validation on the PWA.

Prior to Google Validation, we can let it be used for up to 100 users (lifetime cumulative users). They will see a warning sign when they connect that this is an unvalidated app. We need to do this anyway, because full validation submission is only done for a working app, where we can submit a video showing how it works. There is uncertainty whether they will validate us: their policy is that `files.download` is for only a narrow range of programs, e.g. file sync, not for arbitrary apps; we don't know whether our app (which does indeed have syncing) will pass muster.

## OnePlay Video

**Start with the workout.** Pick *Pumpin’*, a playlist drawn from a OneDrive folder of ’80s and ’90s music videos, tap Shuffle, and cast it to the living-room Chromecast. The appeal is the surprise of what comes on next, like watching MTV. Someone who has arranged *My treadmill workout* to match a warm-up, a run, and a cooldown can press All to play it in order. Music’s five playback modes cover both uses (All, Repeat, Shuffle, One, and Timer).

**Keep the familiar library.** Reuse Music’s folder view, selection, playlists, favorites, and shortcuts. A workout starts each clip at the beginning. For a DVD-ripped film or BBC episode, offer “Resume at 48:12” using a position saved against the file. That lets someone stop an episode on the TV and pick it up on the phone the next night, even if they open it through a different shortcut. A series favorite can remember the current episode, much as an audiobook favorite remembers its chapter.

**Put the player where the picture is.** On the phone, give the video the main viewing area, with a conventional seek bar, fullscreen, and captions. While casting, show what’s playing on the TV, the playback controls, and the upcoming queue. Browsing for another clip should leave the TV playing.

**Casting must survive a switch to Messages.** Use the native iOS Cast sender SDK in the proposed Swift host. Give the Chromecast the ordered or shuffled queue so it can fetch and advance through clips while the iPhone is busy or locked. On return, the phone reads the receiver’s current clip and position. Timer must also stop the TV at its deadline while OnePlay is backgrounded. Start with Google’s default receiver and verify how long a OneDrive queue stays playable given its short-lived download URLs. [iOS Cast SDK](https://developers.google.com/cast/docs/ios_sender/integrate) · [Cast queue behavior](https://developers.google.com/cast/docs/ios_sender/queueing) · [OneDrive download URLs](https://learn.microsoft.com/en-us/graph/api/resources/driveitem?view=graph-rest-1.0#instance-attributes)

**First prototype.** Use an iPhone, the living-room Chromecast, and files from the actual collection.

1. Cast four clips. Open Messages before the first ends, stay there through two transitions, then return and press Next. The phone should show and control the clip actually on TV. Repeat with a full workout to exercise older URLs, and with a short timer to verify the TV stops on time.
2. Cast a BBC episode, try its subtitles, and seek halfway through. Stop casting, then resume on the phone the following night. This tests the bookmark and whether the actual rip’s video, audio, and subtitles work on both screens. [Cast media support](https://developers.google.com/cast/docs/media)

**Later options.** For offline viewing, consider downloading a selected episode or playlist with its size shown up front. For a home NAS, establish how the Chromecast would fetch the video as well as how OnePlay would browse the share. A media server such as Jellyfin is worth exploring if the collection needs format conversion. [Jellyfin playback options](https://jellyfin.org/docs/general/post-install/transcoding/)

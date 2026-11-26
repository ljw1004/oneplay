# Listening and downloading directly from OneDrive folders

Design proposal for OnePlay Music. A listener can keep an album for a flight, remember a place in an audiobook, or start a folder in Shuffle while leaving their Home screen exactly as they arranged it.

## What happens today

The reported One → Shuffle → All sequence follows from the player’s current rules. Cycling to One while playing from OneDrive changes the live player. Ordinary folders can carry that mode between them, but OneDrive has no stored preference to return to. Starting a favorite with **Remember my spot** loads its configured mode, which is synced with the favorite. Leaving the favorite for OneDrive resets playback to All. The last live queue and mode can survive a restart. That session record serves a different purpose from a preference for the next folder. The browser and bundled iOS player both implement the favorite-exit reset. [Browser context switch](../src/playback.ts) · [Favorite settings supplied to iOS](../src/index.ts) · [Native start](../ios/App/NativePlayback.swift)

## What the listener sees

Open an ordinary folder. Beside its existing Play button, add one visible **…** button, accessible as “Options for Dune.” Keep ordinary child rows uncluttered. A shortcut star continues to mean “on Home.” Downloads have their own progress and completion marks.

| In Dune’s menu | Effect |
| --- | --- |
| **Keep offline…** | Shows the recursive track count and starts a download on confirmation. Reopening it shows progress, pause, retry or removal as appropriate. |
| **Remember my spot** | Saves the chapter and elapsed time on this device. Once there is a bookmark, the folder offers **Resume · Chapter 7 · 18:42**. |
| **Starting mode · Use library setting (All)** | Sets how playback started from this folder begins. The choices are Use library setting, All, One, Repeat, Shuffle and Timer. |
| **Add shortcut to Home** | Makes Dune easier to reach. Opening that shortcut gives the same settings and position as opening Dune in OneDrive. |
| **Select tracks…** | Enters the existing selection UI. Check one or more tracks and tap **Keep offline**. Pressing and holding a filename goes directly to the same selection. Neither action starts the audio. |

Offer the same listening and download controls on a playlist. A playlist has its own order and listening history, including when it contains a whole book. Its menu names the playlist. Removing a shortcut from Home changes its visibility. A playlist that already includes it still plays the folder, and the folder keeps its settings and downloads. This requires separating Home visibility from today’s favorite deletion operation. Deleting an actual playlist removes its bookmark, download request and references from other playlists.

## Playback rules

**Where will Chapter 7 start?** Tap a filename to hear it from 0:00. Tap **Resume Dune · Chapter 7 · 18:42** to continue from 18:42. The footer’s Play/Pause continues the actual current session. Opening or browsing a folder alone does none of these things.

**Which tracks will play next?** Folder Play queues that folder and its descendants. Tapping a physical track queues the folder currently displaying the track, even if another queue already contains it. This deliberately changes the current track-tap shortcut that sometimes keeps a larger queue. In a multi-disc book, tapping a filename in Disc 2 plays through Disc 2. Tapping **Resume Dune** plays through the rest of the book. On playlist routes, retain the playlist order and occurrence identity. A tap in a playlist plays the selected occurrence in the outer playlist, and an explicit Play on a displayed subfolder can limit the queue to that subtree. Now Playing names the queue in **Playing from …**.

**Whose place is saved?** When starting physical playback, look from the chosen queue folder upward for the nearest folder with **Remember my spot** enabled. Save to that one book throughout the queue. This lets someone start a chapter inside Disc 2 and still advance Dune’s bookmark. If Disc 2 also has its own bookmark enabled, it owns that listening instead. Playing **Books** above Dune and later reaching Dune through automatic advance leaves Dune’s bookmark alone. Playing from **Road Trip** can update Road Trip’s bookmark only. An automatic transition never starts writing another book’s history.

In Disc 2, show **Saves your place in Dune** when the bookmark belongs to Dune, and offer the named **Resume Dune** action when a position exists. The same information belongs in the player when the queue and saved folder differ. This is especially valuable after starting directly on a search result. For a track result, show its playback destination before the tap when the result could route through a playlist or another folder of the same name. Use the actual route chosen by search.

**Which mode wins?** Use the queue folder’s explicit starting mode, or the outer playlist’s mode on a playlist route. Otherwise use **Settings → Usual playback mode**, initially All. Starting mode is independent of bookmarking. A disc can save progress to Dune and play in its own mode. A playlist containing the disc can shuffle it without editing either folder. Browsing another folder never changes the sound.

Tapping the mode in Now Playing opens a picker headed **This queue · Dune**. Choosing **One** applies immediately and lasts through pause, resume, and advances in this queue. Starting a new queue reads its starting mode afresh. The picker also offers **Save One for Dune**. The name always refers to the playing source that owns the setting, even if the library is showing something else. Changing a folder’s **Starting mode** from its own menu affects the next start. To make the original One → Shuffle → One scenario work across *all* ordinary folders, set **Usual playback mode** to One and save Shuffle for Road Trip. A listener who wanted One once needs only the player picker.

Shuffle folder Play starts a fresh pass. Preserve the last sequential bookmark during Shuffle. If a bookmark already exists, offer **Resume Dune** separately from **Shuffle Dune**. Explicit Resume plays in order when the starting mode is Shuffle. Timer remains one of the five modes. Choosing it in the player is temporary unless saved, and each new timed session gets a fresh deadline. If the bookmarked chapter is unavailable offline, keep its position and explain what is unavailable. A different cached chapter can still be chosen explicitly.

## Finding and removing downloads

Put **Downloads** on Home, alongside the routes to the library and favorites. Show each explicitly kept folder, playlist or track, with its source path when names collide. Tap its name to open it in the library. Its download details show progress such as **18 of 24 on this device**, **Waiting for connection**, or **24 of 24 ready**. An offline request can be saved before a connection returns. A ready mark requires verified local files. Show **Keep on my devices** in the confirmation because download intent follows the account’s existing favorite-pin sync convention. Each device reports its own inventory and applies its own storage limit.

Pinning Dune includes all discs and chapters, including later additions discovered on refresh. An individual chapter can be kept separately, even if Dune already covers it. Download the recording once. On the chapter’s download details, show *why* it is kept, for example **Kept by Dune and Road Trip**. Removing Dune’s request releases chapters with no remaining owner. Report **1 chapter is still kept by Road Trip** when the overlap is known. When a chapter is kept only through Road Trip, its details offer **Manage Road Trip**. To keep three chapters from a book, select those three directly. This keeps the first version free of per-folder exclusion lists.

## Fit with the existing app

- Keep sparse user preferences and direct download requests outside the music index. Key a physical folder by account, source root, drive and folder ID. Use its last known path for display and for finding it quickly. Shortcuts address that same folder. Playlists retain their existing UUID and occurrence keys. A bookmark reached through a shortcut must translate back to a physical track ID. Today the queue key includes the logical route, so just reusing the shortcut key would lose the resume point in OneDrive. [Library queue walk](../src/tracks.ts)
- Compute the playback folder, mode owner and bookmark owner once per new selection in shared TypeScript. Pass those decisions to both players. Keep position checkpoints local with the player that actually advanced, including Swift while the screen was locked. Keep starting modes and the opt-in with synced preferences. The current favorites uploader writes a whole document. Use a separately versioned preference document, durable pending offline edits and merge by changed owner/field so an older client or a second device cannot erase an unrelated edit. [Favorite persistence](../src/favorites.ts) · [Native session store](../ios/App/PlaybackStore.swift)
- Add physical folders and individual tracks as download owners alongside playlists. Feed the union into the existing engines. Keep an owner’s last known membership on an incomplete scan or inaccessible share, while honoring revoked playback access. Recompute membership on a pin or library change, yield during large walks, and use reverse membership for progress and “kept by.” Opening a folder or ticking off one download must not trigger a 30,000-track scan. [Browser pin projection](../src/index.ts) · [Native owner projection](../src/native-pins.ts)
- Migrate existing shortcut settings, pin ownership and saved position before retiring the old owner. Translate the saved occurrence against a complete cached source and keep the original until the new record is durable. An unavailable share postpones migration. Preserve playlist references to the shortcut and preserve the live player independently. A moved folder with the same ID keeps its settings. A different folder created later at the same path must not acquire its predecessor’s book position. Coordinate old and new clients during migration so a removed legacy pin cannot reappear on the next sync.

## What the usability review changed

Sol 6.2 High received seven tasks and text-only screens in a fresh conversation. It saw the draft rules after recording its first taps and expectations. This was one model walkthrough, with no interactive prototype or listener observation.

| Task | First response | Comparison and decision |
| --- | --- | --- |
| Keep a book for a flight | Open the folder’s **…**, then check Downloads. | Matched. The reviewer could not tell whether a listed item was ready. Show a completed count and explicit **ready** state. |
| Keep one chapter without playing it | Press and hold the filename. If that failed, it had no second guess. | Matched the existing gesture. Keep a visible **Select tracks…** route as well. |
| Resume through the Home shortcut | Enable remembering on Dune, return via the shortcut, press folder Play. A chapter tap probably starts at zero. | Matched. Name the action **Resume** and print the chapter and time. |
| Start inside Disc 2 | Initially guessed the disc would own playback and Dune’s bookmark would stay put. On seeing the rules, expected listening inside the book to count toward Dune. | Exposed a flaw. In the draft, the same chapter tap updated Dune only if a previous Dune queue was still active. Revised to the visible folder’s queue and nearest opted-in ancestor. |
| Change mode for tonight, one folder, or the library | Now Playing for the current source, Dune’s menu for Dune, Settings for the library. Predicted All after leaving Road Trip with the initial library default. | Matched. “Tonight” can also mean several queues. The temporary control is labelled **This queue** and ends with that queue. |
| Remove a book that overlaps a kept playlist | Remove the download on Dune. The playlist chapter should survive. Look in Downloads for why. | Matched. Name the other owner in removal feedback and track details. |
| Play the same chapter through Road Trip or search | Expected Road Trip to leave Dune alone. Could not predict an unlabelled search hit. | Playlist expectation matched. Show the playback destination on ambiguous track results before starting audio. |

In a final check with the revised Disc 2 screen, the reviewer correctly predicted all three outcomes. A Chapter 8 tap starts at zero in Disc 2 and updates Dune regardless of the preceding queue. **Resume Dune** opens the whole book at 18:42. Playing Books above Dune leaves Dune’s bookmark alone. The last outcome is the remaining cost worth testing with the listener.

## Release decision

I would ship **direct offline + Home Downloads** first. This alone answers the flight request and can be tried without changing a single playback rule. A folder-only version would make a listener create a one-track playlist for the same trip. The downloader already works in track IDs, so individual track requests earn their place in this first slice.

Next, try the two-disc book and the One → Shuffle → One sequence with the actual listener on a phone-sized prototype. Give them the goals without naming the controls. Watch which button they use to resume, whether they expect playback to cross the disc boundary, and whether they can set One for an evening versus their whole library. Ship the bookmark and mode changes together once those interactions read clearly. Automatically creating shortcuts for every configured folder would be cheaper to wire up, but would put every downloaded album on Home and leave the original ambiguity about where a mode is saved.

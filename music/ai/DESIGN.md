# OnePlay Music

OnePlay Music is a mobile-first SPA app for playing your OneDrive music collection. It fills a gap:
- The official OneDrive app from Microsoft can play music and has offline, but only a single fiel at a time -- it has no playlists, stops after the first track, is sluggish and hard to find
- You can't pull a .m3u index of your OneDrive music into iTunes because OneDrive authentication stopped that working, and even when it did work, iTunes cut off the end of tracks
- There are a wide variety of existing apps in the app store but they're all irritating in various ways. I tried every single one.

This is a living document, not a spec. We will explore UI ideas and jot them down here.
The description here is a starting point of things we want to try, but there's no point
trying to plan the more advanced features until we've implemented the basics and
studied how fluidly they work out in practice.

Goals:
1. Work on mobile; mobile-first design.
2. Be able to easily + joyfully navigate the playlist of up to 30k music tracks, often arranged in hierarchical directories. The filenames, directory structure, filesize, and directory sizes, are the only information we can use to render the playlist.
3. Be able to play from an entire directory (or directory tree), in which case it will either play sequential items from that directory, or shuffle, depending on user selection
4. There should be an "audiobook mode", where an audiobook is either a directory with music files, or a directory tree with music files. The characteristic of audibooks is that each file is often quite long, e.g. 30mins or 1hr, and they need high-fidelity scrubbing to find exactly where you were. It might be that the same UI we use for playing music will also prove suitable for audibooks.
5. For audiobooks, we have to be able to resume an audiobook from where we were last. If we resume a different audiobook, it will resume from where that different audiobook was last.
6. Audiobooks will need a "sleep" mode, i.e. stop playing after say half an hour. (If there's any way to hook them up to the iPhone's sleep detector and switch off automatically, that'd be great).
7. We need to be able to create playlists. Typically the playlist will be a selection of directories. (It might be possible to create it from a selection of songs within a directory too). I presume users will want to administer their playlists -- add or remove playlists, add or remove items from them -- but my general design philosophy is to REDUCE the burden of administration. No user actually enjoys administering their collections. Too many apps just dump users into the deep end with the need to do administration without thinking how to do it easy.
8. Users will want to be able to click directly into the audiobooks they've been listening to, or their playlists, without too much bother.
9. I presume we'll need some kind of search. This is a streamlined client app so we don't have any AI power to assist in the search. The only thing we have to search is the information I mentioned above, so probably the only possible search will be by directory name or filename.
10. There has to be some space to show progress on indexing. There should also be a way to log out.
11. Sometimes errors will occur. I imagine showing these with a full-screen overlay.
12. We rejected skeuomorphic metaphors because they age quickly and require art production we can’t sustain. An abstract tree enhanced with motion, spacing, and gesture shortcuts keeps the interface light, timeless, and achievable for a two-person codebase.

## Playlist: hierarchical tree view

Here is the top-level view after I've signed into my OneDrive account ☁ and someone has shared their music with me 🔗 and I've created one playlist ♫ and two favorites ☆. I also have The Odyssey audiobook downloaded ↓ for offline listening.

- ☰ OnePlay Music 🔍
  - Workout Playlist ♫
  - Beatles ☆
  - The Odyssey ☆ ↓
  - OneDrive
  - share2

If the user clicks on an item, then it expands; we remove all its peers, and show only its ancestors and children. Here I'll click on Beatles:

- ☰ OnePlay Music 🔍
  - Beatles ☆ ▷
    - Sgt Pepper
    - White Album
    - Abbey Road

And I'll click on Sgt Pepper:

- ☰ OnePlay Music 🔍
  - Beatles ☆
    - Sgt Pepper ▷
      - Lonely Hearts Club Band
      - ⟳ With a little help
      - Lucy in the sky with diamonds
      - Getting Better

The pattern is (1) there's a breadcrumb view from the top level down to the currently selected folder, (2) we see all immediate children of the current folder, (3) the currently-selected folder has a "play" button which will set the "currently-playing" to be the recursive descendents of that.

I imagine that the breadcrumb items will be styled one way (say with a background color grey), the currently selected folder will be styled (say with a yellow background color), and the immediate children of the currently selected folder will have their own style (no background). Also, maybe we'll show folders in bold, and individual tracks in regular type.

Icons/buttons:
- ▷ is a button to "set the currently-playing list to be this folder and all its recusive descendents". It is shown on the currently-selected folder. We might show it filled-in ▶ if the selected-folder is already the currently-playing list (so that clicking on it will be a no-op)
- ♫ is a non-tappable badge indicating a playlist (a folder that the user created which lets them rename the playlist and add/remove items). To manage a playlist, long-press to enter select mode, then use the action bar's right button.
- ☆ is a non-tappable badge indicating a favorite (a folder that exists elsewhere, likely in a OneDrive account, which the user favorited). The user can't rename nor add/remove files. To manage a shortcut, long-press to enter select mode, then use the action bar's right button.
- ☰ is the app's main settings button, positioned to the left of "OnePlay Music" on the title row only. It is the sole entry point for settings. This is app-level chrome, not a row-level badge — it sits outside the indent hierarchy and does not participate in the right-side badge convention used by ♫, ☆, ↓, etc. Clicking it opens the Settings view. In error states (signed-out, denied share), the ☰ gains a warning badge dot to signal that user attention is needed.
- 🔗 is a non-functional badge to indicate a share. (I'm not sure whether we should have this or not).
- 🔍 lets you search.
- ↓ is a badge to show that a favorite has been marked for "make available offline" and is complete. It may be animated "↓⌄_" to show that we're actively downloading. It's just a badge; not tappable.
- ⟳ immediately to the right of "OnePlay Music" shows we'll pulling favorites, or pushing our updates to favorites, or polling OneDrive/shares to see if we need to rebuild the index. It's always very short-lived.
- ⟳ immediately to the right of OneDrive or a share shows that we're indexing that source. This often lasts 30s but can be 2-5mins the first time for shares. The user can click the hamburger menu ☰ to see progress.
- ⟳ to the left of a track shows that we're currently loading this track to start playing it.
- > to the left of a track shows it is currently playing, or is the currently selected playback folder

Almost all of the screen is taken up by this hierarchical view. You can naturally scroll up and down. But because track titles are long 50-120 characters, and I don't want to truncate them nor wrap them, you also have to be able to scroll left and right. I suppose we might want some kind of "snap" so that a human scroll gesture is interpreted solely as either a vertical scroll or a horizontal scroll? Hard to tell. Anyway, the breadcrumbs area will never scroll horizontally.

Navigating the hierarchy (clicking a folder, clicking a breadcrumb) must be animated. Rows that persist across the transition slide from their old position to their new position; new children fade in. This uses the FLIP technique (First, Last, Invert, Play). Without animation, navigation feels disorienting — the user loses spatial context.

In the initial state of the app, there won't be any favorites. We'll display it like this, with a placeholder.

- ☰ OnePlay Music 🔍
  - [favorites will go here]
  - OneDrive


## Playback controls

The bottom of the screen will have a "playback controls" area. Here the user will control playback of the current playlist (i.e. playback folder). It shows only the most basic controls: the track title, and a play/pause/resume button, and to the left a "current track" indicator.

Modern iOS apps like Podcasts have the playback controls in a "pill" area that sits on top of the scrolling window. I don't like that. I'd rather have it be a footer anchored to the bottom of the screen that reduces the space available for the hierarchical tree view.

You can swipe this playback-control areas up where it expands into a half-screen-height larger area that has an iPod style scroll-wheel. (This is similar to Safari on iPhone which prior to iOS 26 had a control area at the bottom with addess bar, and you could expand it to fill half the hieght for Bookmarks/Share. Bookmarks has blue Done text to dismiss; share has a close icon. In Safari when the popup appears then the rest of the screen is almost imperceptibly faded out, but we will leave the rest of the screen (the playlist area) usable and normal.)

In our "playback controls" area we want to give as much space possible to track title: two full lines of text. This is unconventional, but reflects my personal preoccupation that track titles are typically 60-120 characters long and need plenty of space to see them all. There will be a single Play/Pause/Resume button at the right, and a "current track" indicator to the left. For the Play/Pause/Resume button let's start with just a simple glyph, no border or surrounding matter, just like the Podcasts app. That way the button won't carry heavier weight/border/chrome than the text.

The motive this design is
- My preoccupation with long track titles means that the default bottom area must leave as much space as possible for text, so just a single button is the most we can have. I'm only grudgingly allowing a "current track" indicator to the left because I see no alternative.
- Audiobooks require a scrubber that allows 2s resolution scrubbing even in a 1hr chapter. There's no way to have this resolution in a normal scrubber; the only possibility is something circular, like the spiral groove in a record or like the iPod's scrollwheel
- We nevertheless want the bottom bar to have at least one button to start playing, to satisfy the most important scenario that "user has just opened app and wants to play where they last left off", and also "autoplay is disallowed by browser; play must be triggered by a user action".
- We also want a visual language where the icon shown in the playback area, also echoes the icon shown in the playlist view which indicates what track is currently playing
- I can't conceive of a good way to learn what is the current playback folder

If there's no playback folder, then we'll hide the entire playback area.

## Relationship between Playlist, Playback Controls, and "Playback folder"

This section introduces the notion of "playback folder".

In the playlist part of the view,
- The currently selected folder is shown with a yellow background. It has a "ghost play button" ▷ to its right with the meaning "let this folder become the new playback folder, and start playing the next track in it". It is a "ghost" button meaning it has potential to play, but it's not currently playing.
- If the current state of the playlist view shows the playback folder, then it will have an indicator to its left, a chevron. This is the same as the chevron to the left of the playback area.

If you click on an individual track then (1) if the track isn't within the hierarchy of the playback folder, then the playback folder will be changed to the folder immediately containing the track, (2) we will start playing that track; it will become the current playback track.

The current-track indicator is shown both in the playlist and to the left of the playback area. It will be a spinner if loading. Otherwise I don't know. Maybe a chevron >. The purpose of this is to show "this track is selected". Analogies I'm thinking of are that we often write an arrow -> to show that something is selected, and we often use chevrons to show selection. The current-track-indicator could distinguish between two states "paused" and "playing" but it doesn't have to. There will be a third mode of the current-indicator, a spinner, to show that the track is loading.

When you click the chevron > in the playback controls area, then it will scroll+expand the playlist areas as necessary to show the currently-playing track within the playback folder. (In general, it maybe be found within multiple different playlists/shortcuts/accounts; we will scroll+expand to show it within the context of whichever playback-folder the user had chosen).

## Scrubber

When the user expands the playback-area, it reveals an extra area with additional playback controls.
1. The bulk of the area is taken up with a scrubber wheel, which looks exactly like that on the iPod. Like the iPod, the scrubber wheel doesn't show a line for how far through the track we are; it's a write-only surface.
2. The track's currentTime and duration is shown in the middle of the wheel
3. If the user holds+drags on this wheel, it will start a scrub-drag. We'll show a "thumb" for the duration of the drag, a sort of curved arc lozenge with rounded edges that subtends about 45 degrees. This is so that even when the user's finger is on the wheel to scroll, they'll still be able to see the rest of the lozenge on either side, so they know what they're doing. In implementation terms, we'll respond to position-changed events, calculate the current angle, calculate how the angle has changed since the last one, and we'll do velocity control so faster scrubs move the head faster. I'd quite like the scrub thumb to "stop" at the start/end of the track, so if the user tries to go further, they'll see that it doesn't.
3. There are special locations at the top and bottom for +30s and -15s, just like the iPhone podcasts app. If the user taps on these it won't start a hold+drag; it'll merely seek. We have to keep our own local notion of how far we are in the track, so that if the user clicks -15s say four times in succession then we know the true intended target is -60s from where it was at the start; we can't each time ask the music player "what is your current position" in case it's too slow to react.
4. There special locations on the wheel, to the right and left, distinguished with icons. Tapping on these will move next-track or prev-track, and start playing if it's currently paused.
5. There will be an indicator at the top left which shows the current "shuffle" mode; the user can click on it to cycle through different modes.
   - "one" picks next track in sequential order and stops when it's finished
   - "timer" picks next tracks in sequential order and stops after 30 minutes
   - "all" picks next tracks in sequential order and stops when the playback folder is finished
   - "repeat" picks next tracks in sequential order and loops back to the start when finished
   - "shuffle" picks next tracks in random order and keeps going indefinitely
  

## Favorites

Goals:
- Users can pin folders as favorites, and assemble playlists. Users will probably spend most of their time within 'favorites' rather than browsing their full music collection.
- Because we're hierarchical, we're more powerful than conventional playlists: we can add entire directories as favorites.
- Some settings (current track, current time, repeat mode) might be specific to each favorite, and persisted.
- I don't want "administering favorites" to ever be a burden to users. I want it as simple and lightweight as possible. All the time a user spends administering their favorites (curating, adding, removing) is wasted time.
- We must treat favorites as *sacrosanct*. A user has invested considerable time and thought to pick their favorites. We must persist them dutifully in OneDrive and strive hard that their work never gets lost. Ideally they'll be durable against things like "directory has been renamed" too.

Scenarios:
- I have two audiobooks on the go. Each one has shuffle-mode="all", and remembers its own currentTrack and currentTime. I can resume one of my audiobooks just by clicking the play button on that favorite.
- My kids love Taylor Swift and keep asking me to play her music. I have a favorite for the Taylor Swift directory hierarchy. When my kids ask to play her latest album "Showgirls" then I can expand the hierarchy and play that folder.
- Some of my music is "serious" where I intentionally listen through in album order. Other of my music is "frivolous" where I prefer shuffle. Audiobooks are always in album order. Podcasts of comedy might be in either.
- I have assembled a Christmas playlist made from a variety of different folders. I'll set that playing, maybe on repeat, maybe on shuffle, for many hours.
- I have grown tired of a track / album. I want to remove it from my playlist.

Plan:
- There are two different kinds of favorites: 
  - Shortcuts ☆ are a reference to an entire folder or directory tree in the music hierarchy. You therefore can't add/remove members nor rename it.
  - Playlists ♫ are a collection of files/folders. You can add and remove top-level members of a playlist.
- It might be possible for a playlist to refer to other favorites (as long as it's not circular). This might be powerful, or it might be too confusing. This feature would allow the concept of "favorite collections"! A user might select several of their favorites, and then create a new playlist out of those.
  - Will users get confused? Should we limit depth? No I don't think so. As long as there aren't cycles, that will be simplest. If the user attempts an action that would create a cycle, that will be such a niche activity that we could even just indicate it with something low-tech like an alert() box.
- You enter "select" mode (similar to iPhone Photos app) by click+holding on an itme.
  - In select mode, there will be checkboxes to the left of each row in the playlist area, for you to select/deselect that row
  - And a bar at the bottom of the screen can appear, similar to iPhone Photos app. In iPhone photos app it shows (1) a share button through which we might add it to a favorite, (2) a count of how many photos are selected; we might show how many things have been selected, or how many recursive files that selection denotes; (3) a button to delete, which we might use to remove selected items from a playlist, or remove a favorite entirely.
  - In select mode, there should be a floating "cancel" button at the top right to get out of select mode.
  - Some apps on iPhone (e.g. Outlook, though not Photos) also allow swipe-to-select. That's less discoverable but a bit conventional by now. We could use that for a quicker way to favorite an individual folder, but I think that's not possible because we allow horizontal scrolling.
- Favorites need the ability to have their own playback (currentTrack, currentTime, repeatMode) for sake of audiobooks; it's part of MVP.
  - When a favorite is created for the first time, there will be a checkbox for whether this favorite should have its own playback.
  - When a user selects a favorite, the action bar should offer a way to turn that on or off. (The absence is called "use global defaults")
  - It's unclear whether a favorite needs a badge to say that it keeps its playback. I'll try both and see.
- When the user clicks the "reveal in playlist" chevron in their controls, this will reveal the current song in its place in favorites.
  - We don't have any way to "reveal in music library" for a favorite. That'd be nice to have, but I can't think how to achieve it.
- We said we want a user's favorites to be durable. One way is: if a favorite refers to a directory or file which gets moved or renamed, could we automatically patch it up by searching by ID if it's no longer present at the path? Although, if a different ID appears at the same path, we should respect the new ID. One idea is that if a favorite references a path+ID that simply can't be found, we might leave this in the favorite indefinitely, not even surfacing it to the user; when an item is restored, then it will automatically come back into the favorite. (This has the potential for favorites to grow unchecked, but I don't think that will happen in practice).
- What Outlook does is, if you long-press on a row, then it animates into select mode with this row selected. This way it teaches users about select mode, it shows them that select mode is good for even just a single item, and it doesn't require any additional UI. We'll do that. I imagine that right-click will do the same as long-press.
- "This favorite remembers my spot" or "Remember my spot within this favorite" will be the wording. I'll try both and see. It will govern (1) currentTrack, (2) currentTime, (3) repeatMode. It won't capture the current order of tracks in the current shuffle, in the case that repeatMode===shuffle. And if you press Play within a favorite that's governed by shuffle, then it will disregard currentTrack and currentTime and just jump to a random one.
- The shortcut☆ and playlist ♫ icons will be ubiquitous. They will always accompany the name. For instance if a shortcut or playlist is contained within another playlist, we'll see those icons.
- I think the user won't be able to select the top-level "OnePlay Music" row. Therefore, our checkmarks can fit at the left without needing to shift rows to the right!

Action bar:
- Our primary use for the action bar is to administer favorites. We don't need to use it for playback.
- The design is modeled on iOS Photos' select-mode action bar: a grey bar at the bottom with large circular icon buttons and a center label. No pills or chrome. The circle button styling: ~48px diameter, white background, subtle shadow, centered glyph in dark grey. Visually they look like tappable buttons with slight depth.
- Left: the "share" icon which opens a popup menu:
   - "Add as Shortcut ☆" — if exactly one selected item, which is a OneDrive folder (anywhere in the tree: under an account root, inside a shortcut expansion, inside a playlist expansion). Not already a shortcut target. Opens the shortcut modal: title "Add new shortcut", checkbox for "Remember my spot", information text "Once created, long-press and use the action bar to alter settings or make available offline", Create/Cancel
   - "Add to existing playlist ♫" — if one or more playlists already exist. Opens the playlist picker modal: title "Add to playlist", button-like tappable things for each existing playlist, Cancel.
   - "Add into new Playlist ♫" — always available. Opens the create-playlist modal: title "Create new playlist", editable text box for name, checkbox for "Remember my spot", similar information text, Create/Cancel button where Create is greyed out until you type a name that's different from existing names
- Center: selection summary text, either "N tracks" or "N folders" or "N selected" (if there are a mix of tracks and folders selected) or "Select items" (if nothing is selected)
- Right: a multipurpose button. This is the sole entry point for managing individual favorites.
  - Favorites button: if you've selected exactly one item, and it is a favorite, then this button becomes the icon of that favorite (☆ or ♫), and clicking it opens the favorite popup for that item (Remember my spot ✓, Rename if it's a playlist, Make (un)available offline, Delete)
  - Delete button: if you've selected multiple items and and at least one can be deleted, this will pop up the delete modal
  - If neither apply then we omit the right button
- The action bar and expanded playback controls are mutually exclusive: entering select mode auto-collapses expanded controls; while in select mode, controls cannot be expanded.

Rejected ideas:
- User-authored algorithmic favorites e.g. "all tracks with this tag" or "recently added". These have a high administrative burden. A user's ability to upload new music into a directory already gives them similar expressivity -- i.e. if they modify the content of a directory on OneDrive, then any favorited thing that mentions that directory will automatically include the new tracks.
- "Recently played" algorithmic favorite. This would be nice. But we'll skip it for now to keep the app simple: it's not part of the MVP.
- Queues and filters. We have no playback queues. We only have "currently playing folder". This is a nice simplification for us.
- Swipe. Many apps such as Mail use side-swipe to select/delete items. That would be nice. But for us, horizontal scrolling is already reserved for scrolling long track names, so we can't re-use it.
- Surfacing "broken references". It would be nice to indicate to a user when their favorite is broken in some way. But doing so will require more UI, so I just won't: not part of MVP.

## Memory

When you start the app after some time away, it will restore to the exact same place as you left off.

It will remember OneDrive signin. This is an SPA. OneDrive grants refresh tokens for 24 hours. After that, they should attempt a silent login.
- It'd be nice to do silent Entra login with a hidden iFrame, but iFrames typically block third-party cookies (which Entra counts as), hence the iFrame doesn't pass the right cookies, hence silent auth is rejected.
- Popups generally allow cookies, but they're not allowed in SPA apps pinned to home-screen.
- My only option is a top-level redirect of the main page. These redirects are allowed even if not user-initiated (e.g. they don't have to come from a click).
- Note that redirect will break background playing. That's because background playing depends upon the next URL already being available so we can assign the audio element's "source" property synchronously in its OnCompleted handler, not asynchronously after fetching the URL. Redirecting the main page at any time would interrupt audio, and redirecting upon OnCompleted handler would break the synchronous assignment. So it'd be great if we had at least 3 hours grace before starting a playlist.
- Redirect will always feel janky in a low-connectivity situation.

Plan:
1. Upon app startup/resume, we'll consider an auto-redirect as follows. (1) If we're resuming at a time when playback is in progress, don't redirect. (2) If there's more than 3 hours grace since the last redirect-auth-lineage, don't redirect. (3) If we're in evidence:not-online, don't redirect. (4) We already kickoff a network connectivity test to onedrive. If that fails to complete successfully, then don't redirect. (4) If we've already attempted an auto-redirect within the past 12 hours (stored in localStorage), don't redirect. (5) If the prior attempt at auto-redirect (results stored in localStorage) got an "interaction_required" response then don't auto-redirect. (6) The result is: the user opens the app, and it looks responsive instantly, but then 1s or so later there'll be "jankiness" while it shuttles off to another website and then comes back. It's a shame but we can live with this. We'll do this with prompt=none to guarantee that the user doesn't have to interact with Entra during this auto-redirect; there might still be irritating interactions if connectivity switched from high to low but that's unlikely given our recent successful probe.
2. We will offer the chance for a non-auto, possibly-interactive, refresh. (1) It's up for debate whether this should be offered always. It'd be quite unconventional. We usually see apps with a "sign out" option, but never with a "stay signed in" option, and I don't think users would understand it. So let's not offer it always. (2) We will certainly offer it if the user isn't logged in, i.e. if the refresh token has failed, or if the startup/resume auto-redirect gave us a failure that the user isn't signed in and can't do silent (which should be taken as evidence:signed-out). In this case it would probably be a "Disconnected warning" icon next to the OneDrive item in the tree, replacing the existing cloud icon. (3) It's up for debate whether we should offer it, probably with a gentler neutral/proactive "ExpiringSoon" icon, if there's only 1hr left. I pick 1hr because 3hr would have been covered by app startup/resume, so the only way it we'd ever see this is if the user had been using the app for 2hr+ without resuming it. I don't think we should show this proactive icon if there's >3hr left. My conclusion is, don't bother with this, because it's so unconventional.


## Local cache, and offline

The app must work seamlessly in low-connectivity environments. We won't rely on a boolean like "are we in airplane mode", because there are many low-connectivity environments that don't trigger it (e.g. wifi is available but blocking all requests; cellular is available but so weak that all requests just time out after a long time).

For the hierarchical view, we will always display a cached index, nothing else.

For the playback controls, we will always play a downloaded track if its available for the item. If not, we'll display a loading spinner while we request to play it.

How will we know when our cached index is stale? Our cache will be merkle-tree-like, based on the "recursive size of contents of a folder" instead of checksum (since recursive-size is free on OneDrive). We will issue periodic requests to OneDrive, about once every five minutes after the last check has completed (or immediately upon startup), to check if the root size has changed. If it has then we'll kick off a background refresh. There will be no per-folder trigger, i.e. selecting a particular folder won't prompt us to check just this folder. If we're in a low-connectivity environment, that's fine: things that are in the local index will show; things that aren't in the local index will not show.

We need to be concerned about "persistent identity" when pointing to items on OneDrive. This applies to things we store -- current-folder, playback-folder, playlists, shortcuts. We want the system to self-heal as much as possible. (1) If a user renames an item (folder or file) and it still has the same OneDrive id, we'd like our app to automatically use the new name. (2) Failing that, if a user deletes an item and creates another one with the same name, we'd like to use that. It is an open question whether "unhealable items" should be shown in the UI to indicate that they're broken, or just silently removed. I vote for "silently removed" on the grounds that the user has already done administrative work on their OneDrive account, and we shouldn't force them to do extra administrative work on this app as well.

There will be interesting edge cases to work around, for instance what if your selected folder no longer exists after an index update? At that point we'll just default to the initial state. What if you're currently playing a track from a Favorite, then the favorite gets deleted or the track gets removed from the favorite, and you hit the Next button?

Note that "re-pull index after an index has completed" is something that will happen during the life of the application. It's not part of startup. It will likely happen every few minutes.

Available Offline:
- A favorite may have been marked as available offline. This mark is shown as ↓ badge to the right of the favorite icon. (Note: when a favorite is nested inside another favorite, the nested view of it shows the ♫/☆ icon just so the user knows that they've got a layer of indirection here, and the ↓ isn't shown in this nested spot; it's only shown at top level. To be clear, a nested favorite is nothing more than a pointer to an existing top-level favorite). It will be animated "↓⌄_" when downloads for this playlist are queued and downloading is actively happening (i.e. the app believes it is online and can download).
- The way to mark a favorite as available offline is via the favorite popup in select mode (long-press the favorite, then tap the action bar's right button). There's an option "Make available offline >". When you chose this, it opens the "Available offline modal".
- We will have our own limit of how much cache we're willing to use for offline files. Default 2gb. The size needed for an "marked for offline" folder may grow or shrink based on user actions (e.g. adding a new folder into a playlist), but also on non-user actions (e.g. an index has just completed and has revealed that a shortcut now is substantially larger than it was last time the index was built). If ever we're trying to download items that are larger than the limit, we'll pause downloads, and have some kind of warning indicator; maybe the icon would be "↓⏸" next to each other, or maybe the two would be superimposed. The user would know to long-press the favorite and use the action bar to learn more.
- The "Available Offline" modal is a sort of control center for offline stuff. It is brought up in relation to an individual favorite, and has things specific to that favorite (how many tracks+bytes for that favorite, whether it's finished downloading or not, actions to turn on or off available-offline status for this favorite, ability to pause/unpause this favorite), and global information (the global queue of downloads, ability to change the global quota, how many tracks+bytes we store globally). This modal is used for different purposes (when the user taps "make available offline", when they tap "make unavailable offline", when they just want to view the offline status of a favorite maybe to pause/resume it or just see what it's doing). The reason to combine them is (1) simplicity of UI so the user only needs to learn a single modal, (2) because shortcuts and playlists might overlap, sharing storage, so it's not really meaningful to talk about storage/queue of one playlist in isolation, (3) the actions "make available offline" and "make unavailable" are both dangerous ones, so this modal is used to act as a confirmation dialog that let's the user make an informed choice. For instance if they entered it from "make available offline" in the action bar popup, the confirmation button will be "Make available offline"; when they entered it from "make unavailable offline" in the action bar popup, the confirmation button will be "Make unavailable offline" and there'll be the warning that cache will be lost.
- "Paused" icon is shown for three things: (1) if the user has clicked Pause, (2) if we had a network error trying to download tracks, (3) if we've hit quota. The first "user click" is stored in a boolean which is persisted to IndexDB. The most recent error is stored only in RAM; the total size of files in IndexedDB can be computed from indexedDB at any time, including after restart, though we may decide to cache it depending on implementation ease. It's intentional that all three causes are shown with the same UI to the user, to keep concepts simple for them. The modal will show the most recent error, and will show a quota warning. If the user hits "resume" on any favorite, that resets the persisted "paused" boolean AND the error in RAM. Note that there's no "global" pause; if a user wants to pause five downloads, they can do so manually for each one.
- Prioritizing the queue can be accomplished by the user through pausing/unpausing individual favorites. There's no specified download order across favorites. We'll be happy with whatever algorithm is easiest for inserting items in into the queue. (Except, for a given OneDrive folder, let's add items to the queue in alphabetical order if they're not already there; for a playlist, let's add its tracks in order if they're not already there). The download should work through the queue in order.
- The "resume" button is blocked if there's not enough storage available.
- PWAs can try "navigator.connection" to see if they're wifi or not. But this is apparently unreliable. We'll just ignore it; the algorithm below handles partial-connectivity well.
- Storage is in IndexDB, driven by driveId:itemId. iOS might decide to delete our entire IndexedDB. That's a problem we have to live with.
- While downloading, our global download queue stores their OneDrive ID, and we only resolve this to a URL at the moment we're ready to start downloading. We'll do up to two concurrent downloads at a time in the global list. (There might in addition be a third download due to playing the current track)
- There's no need of persistence of the download-queue. That will be recomputed fresh at appropriate times.
- Resuming a favorite means restarting individual file downloads; we don't keep partial bytes from an incomplete downloaded track.
- When the player plays an item, if it's available in offline cache, then it will play from there.
- If the user is viewing the modal for one favorite, and wants to see a different favorite, they can close this and open the other
- The downloading semantics are best understood as "pinning". If a OneDrive track is required by *any* available-offline folder, then it is pinned, and should be in IndexedDB, and if not in IndexedDB then it should go in the queue. And (garbage collection) if any item is in IndexedDB but isn't pinned, then it should be deleted from IndexedDB. This is how we deal with shared storage between overlapping favorites. It implies that "make unavailable offline" on FolderA won't actually delete items that are available via a different offline favorite.
- The app will keep internal state for whether (1) it has recent evidence we are online and signed in, (2) it has recent evidence we are online but signed out, (3) it has no evidence: its attempts to make network requests have been coming back "timeout" or similar, (4) it has evidence that the device is not online (`navigator.onLine === false`).
   - Upon start, it checks `navigator.onLine`. If false, it enters `evidence:not-online` and skips the initial pull (no wasted fetch). If true, it's in a "no evidence" state until it has received back a message from OneDrive about the merkle checksum (size) of the music folder. This might transition it to evidence:signed-in or evidence:signed-out. Or it might remain in no-evidence if it gets back a timeout.
   - It does periodic network activity (every 5 minutes after the last check completed), e.g. to play a track, or to kick off a periodic pull of the OneDrive folder's checksum, or while it's in the process of downloading tracks, or while it's in the process of indexing. These can also transition it into any of the four states. Periodic pulls are suppressed in `evidence:not-online` and `evidence:signed-out`. (Some algorithms such as indexing may have an automatic internal immediate retry; the state only switches after those have finished).
   - The browser `offline` event transitions to `evidence:not-online`; the `online` event transitions to `no-evidence` and schedules an immediate pull. A `visibilitychange` backstop catches missed `online` events.
   - Error classification in the download engine consults `navigator.onLine` to choose between `no-evidence` and `evidence:not-online` when a network/timeout error occurs.
- The queue starts at empty when you launch/resume the app. It is not persisted.
   - We have a single global boolean for whether the download-queue-calculation is dirty. It starts dirty.
   - Whenever we pull a fresh index that has changed, it gets marked dirty. Whenever the user modifies a favorite, either its content or marking it as available/unavailable or pausing/resuming it, or altering quota, the global gets marked dirty.
   - Any time we transition into "dirty + evidence:signed-in" state from any other state, then we abort any existing track-downloads, recalculate the download-queue, kick off "purge unpinned files from IndexDB", kick off downloading, and mark ourselves as "not-dirty". Note that dirty is merely a flag for whether the download-queue needs to be recalculated; it is not a flag for whether downloads are happening. There might be some races e.g. if we kick off a purge, but immediately after get a fresh index and the tracks should no longer be purged. But that doesn't matter; it will be eventually automatically healed. If a favorite is paused then it won't contribute items to the downoad-queue.
   - Any time we transition into "no-evidence" state then the queue remains but the download icons stop animating.
   - Basically there are several globals: (1) evidence:signed-in, evidence:signed-out, no-evidence, evidence:not-online, (2) is download queue dirty or not, (3) is the download queue empty or not (and we can calculate for each favorite whether it has queue'd downloads), (4) is each favorite paused or not, (5) are we beyond quota. From these we can deduce the form of each favorite's icon: absent if it's not marked as offline; ↓⏸ if it is marked offline and it's incomplete and either we're out of quota or it has the pause boolean set or error is true; ↓ if either it's marked as offline and we're in no-evidence state, evidence:signed-out, or evidence:not-online, or it's marked as offline and none of its files are in the download queue; animated ↓⌄_ if it's marked as offline and some of its files are in the download queue.
   - Note that static ↓ means two things, either that download is complete, or we don't think we can download anything. The reason to combine them is for the user, because they have the same information for the user: "nothing's happening here worth your attention."
   - Note that "out of quota" doesn't affect the paused boolean. Its effect is achieved by altering the icon, and greying out the "resume" button.
   - Note that if we're in a "no-evidence" or "evidence:signed-out" state then the resume button doesn't actually start a download, but it might still change the icon.
   - In the queue, "404 not found" should cause the item to be removed from the queue; "429 rate limit" and "503 transient server error" can push it to the back of the queue; timeout should transition us into "no-evidence" state; auth errors should transition us to "evidence:signed-out" state; success should transition us to "evidence:signed-in" state. Note that if an item was placed in the queue earlier but then got deleted before we tried to download it, then (1) the 404 error will handle it will, (2) things will self-heal once we get the next periodic index refresh. I guess we should consider for all other errors which of three behaviors is best: remove, push-to-end, or transition to no-evidence. I don't know what are the main errors we should handle nor what is the best default. Probably "remove" is the best default.
- If a user is out of quota, the implication of this design is that they can (1) increase quota, (2) remove favorites, (3) remove items from favorites. There's no way to configure a favorite to be half-online and half-not. It's all or nothing.
- Purging an item from IndexDB should be unrelated to the audio player's current track. The audio player will fetch from IndexDB into a blob, which will atomically succeed or fail, and won't imply any lock.
- Recursive file size totals for a favorite, for display in a modal? - this will involve walking the entire favorite. But we do this already, each time someone presses Play on it, and we assume that walk is cheap enough. It's all in RAM. Should be okay.
- Our index of music tracks does not contain byte size of each item. In cases where we want to compute byte-size, we can only compute byte-sizes of those tracks that have been downloaded.
- If we're in "evidence:signed-out" or "evidence:not-online" then we need to change the UI. All tracks that aren't in the offline cache should be displayed in grey italic (whether they're shown under OneDrive or under a Favorite), and tapping on them is a no-op. For evidence:signed-out, the hamburger ☰ should gain a warning badge dot, so the user knows to tap it and sign in again. For evidence:not-online, the hamburger stays normal (the user already knows they're offline). Note that if we're in "no-evidence" then tracks are shown as normal, and you can try to tap them, and you might just get an indefinite spinner if it can't connect. This is the best way to signal poor-connection to the user: let them see the raw truth of what's happening. (They can always hit "pause" if they want the spinner to go away.)
- The quota button will default to 2Gb, and can be set to 1/2/5/10Gb. (As always, if you change quota, that marks things as dirty, with all the state-transition and recomputation that implies).

   
```
+-------------------------------------+
| Make Available Offline              |  <-- title reflects how the user opened this modal
| OR: Available Offline               |
|                                     |
| ☆ Beatles "" or "↓" or "↓⌄_" or "↓⏸"|  <-- this is the favorite you clicked on (readonly)
|                                     |      the icon is the same as shown in tree view
|                                     |      and can update live inside this dialog
| 20 tracks                           |  <-- In "Make available offline" we show "20 tracks",
|                                     |      and no GB; just a recursive count of the favorite
| OR: 20 tracks, 0.2 Gb               |  <-- In "Available offline: we also show the byte sum
|                                     |      of all tracks for this favorite that are in IndexDB.
|                                     |      offline" we also show the byte sum of all tracks
| OR: 15/20 tracks [Pause/Resume]     |  <-- In "Available offline" and this favorite has some
|                                     |      items not offline, then show this.
|                                     |      Resume is greyed-out if used>=max.
| Paused due to {error}               |  <-- if the error global is set
| OR: Paused due to max storage       |  <-- if used >= max
|                                     |
| Total: 53 tracks, 0.3 / [2.0 Gb max]|  <-- This section is about the global storage+queue
|                                     |      The max is a button with a dropdown.
|                                     |      We show this form when our download queue is empty.
|                                     |      It shows how much storage is used.
| OR: Downloading: 23/53 tracks, 0.3 Gb so far [2.0 Gb max] | <-- only shown via "Available" entry
|                                     |      This line is shown when our download queue has items.
|   ↓⌄_ track1... 13% + 19 others     |  <-- the global queue; for the name, we'll show the
|                                     |      alphabetically first of concurrent downloads.
|                                     |      The % indicator is there for really big tracks.
|                                     |
| [Make unavailable offline]          |  <-- if opened via "Available offline >"; closes modal
| [Make available offline]            |  <-- if opened via "Make available offline"; closes modal
| [Cancel/Close]                      |  <-- Initially "Cancel". But if you make a change
|                                     |      to pause/resume/max, then it becomes "Close".
|                                     |      That's because pause/resume/max have immediate effect
|                                     |      The change in wording is only for user;
|                                     |      behavior is always just to dismiss dialog.
+-------------------------------------+
```


### Playback invariant: never transition to known-unavailable tracks

We adopt a hard invariant: once the app knows a track is unavailable in the current evidence state, playback must never transition to it.

- Existing rule remains: tapping a greyed-out unavailable track is a no-op.
- This rule also applies to all other playback entrypoints: folder Play, next, prev, and auto-advance on ended.

Terminal evidence states:
- In `evidence:not-online` and `evidence:signed-out`, a track is considered playable only if it is already in offline cache.
- In other states (`evidence:signed-in`, `no-evidence`), playback behaves normally.

Folder Play behavior:
- If the selected folder has no children at all, suppress the folder Play button.
- If the user presses folder Play and recursive playback resolution finds zero playable tracks, show a modal alert and do not enter loading/playback transition.

Next/prev/ended behavior:
- When in terminal evidence states, the playback list used for movement is the playable subset only.
- If no playable successor exists, do not advance to an unavailable track; stop progression at the end of the current track (same feel as mode `one` ending).
- No modal is shown for auto-advance exhaustion.

Mid-session evidence transitions:
- If evidence changes to `evidence:not-online` or `evidence:signed-out` while a track is already playing, let the current track finish.
- After it finishes, only advance if a playable cached successor exists; otherwise stop without modal.


## Search

The top "OnePlay Music" titlerow has a search icon to the far right. When you click on it, the search-mode expands to fill the entire row: there's a pill with a search icon inside the pill to the left, an edit fields, and the ghost text "Search your library...". And to the right is a circular icon with an X in it to get out of search mode. To be clear: the big right circular X icon is to exit out of search experience, and once you type your first character then the edit box gets a smaller conventional light-on-dark X icon to clear the edit box. This is the exact same UX as search in the iPhone Photos app (except their search is at the bottom); I hope that `input type="search"` will deliver most of it. Incidentally, because the title row is always pinned to the top, then our search icon will always be pinned to the top -- not because we positioned it there directly, but because it's container always ends up being there. This will be a nice visual anchor.

When you tap the search button, it auto-focuses on the edit field and brings up the keyboard. If you were in select mode, it exits out of select mode. (It might be possible that people want to achieve select by searching, but that will be altogether too much complexity for a small-value feature).

Typing into the edit box will perform searches. The searches will replace the current tree with a list of search results. (To be precise: we'll still remember the state of the tree, and restore it exactly as it was once the user closes the search results). They will search amongst OneDrive tracks whose name matches, OneDrive folders whose name matches, and Favorites whose name matches. We don't need any visual indicators beyond the ones already familiar and clear -- favorites are in bold with favorite icons; folders are in bold; tracks are in black regular type; trying to add headings would be a departure from the existing visual language of the app.

It'd be nice if the list could be updated on every keystroke. Experimentally, my iPhone12 can filter 50k tracks in ~50ms (capping at 500 results), which is plenty fast enough. If we capped then display a final non-clickable item as "[Only showing first 500 results]". I never believe in "debounce". I think it's a bad pattern. The right pattern is to start work as soon as the user types something, but interrupt the work when the type the next thing. By the way, our searches should appear instantaneous: if they're longer than 100ms, something's wrong.

The search algorithm: case-insensitive multiword substring match, e.g. "sym 9" will match "Symphony No. 9". We will show favorites first, then folders, then tracks. Within each, list in order of discovery, which (because of how the index was constructed) is alphabetical. (It'd be possible to show a mixed list, order in terms of quality of match, but that will feel buggy rather than useful to the user).

We will only do searches within available tracks, hence not greyed-out tracks. The rationale is that a user is searching because they want to do something; and with greyed-out tracks they can't do anything. It will be frustrating to them if they're searching while offline for something to play but the results are swamped with things they can't. Notionally folders and favorites are never greyed out hence will always be searched. But if it's easy to implement, I think it would be nice to omit folders/favorites if every one of their children is grey. Maybe the easiest to implement would be omit folders if all their immediate children are grey, to avoid a costly recursive search?

I believe we can do an optimization for the 90% case where the user is typing a single word and they type an additional character. If the previous search was uninterrupted and uncapped and a single word and a prefix of the current search string, then we can calculate the new results by filtering the old results. This won't help in the first 1-2 characters which will likely be capped, but they generally reach their cap by traversing only a tiny fraction of the tree, so it's fine. It will help the 90% case where you just start typing away. It won't help for the 10% case of backspacing or inserting or pasting.

You can scroll through the search results.

When you tap an item in the search results, it exits search mode, jumps to that item in the real tree, scrolling into view if necessary.
- If you tapped a song, then we scroll that song into view (selecting its parent as currently-selected-folder), and start playing it.
- If you tapped a folder, then we set that folder as currently-selected-folder, with all that entails.
- If you tapped a favorite, then we set that favorite as currently-selected-folder.

For folders and songs, there might in general be multiple paths to that item, e.g. MyPlaylist1 > MyFolder1 > MyTrack1 and OneDrive > Comedy > MyFolder1 > MyTrack1. We'll always prefer a Favorite path over a OneDrive path. If it appears in multiple favorites, we'll prefer the ones where it appears shallowest. If there are multiple still, we'll pick the alphabetically first one.

Note that the search will be performed within the in-memory index and favorites databases. They also power the tree; hence we will always be able to find a tree place for it. Just as the tree isn't visible until we have the index, so too the search button isn't visible until we have it (since the search button is placed on the top row of the tree).

The next time you hit the search button, it will have remembered your search filter and the scroll position within the results. This memory is cleared 1 minute after exiting search mode (and also on app restart/resume). The 1-minute decay balances two competing needs: if you tap a search result, realize it's wrong, and immediately re-open search, your query is still there; but if you've moved on to browsing or listening, the search field is fresh. The timer starts when the user exits search (by tapping a result or hitting X), not when they entered it.

We might consider showing "subtitle paths" for each search result. But I'd rather not. I think that will look too cluttered. There are two reasons to consider it. (1) If the search hits just look bland and the same, e.g. Track01.mp3, there might be many with the same name and you won't know which is which. But I think that in this case users won't even care about search. (2) A search hit might have multiple parents, e.g. one parent under Favorites and one under OneDrive, and we could show the user which one they'll be opening. But I think this is too much information for a scenario I can't imagine happening for real: I think that users will spend 99% of their time in playlists, and resort to OneDrive/Share sources only when they want to populate the playist. Some people say we should show subtitles only in the case of clashes, but that'd look even more irregular like a bug "why do some have subtitles but not others?!"

We might consider limiting search to only within the current selected-folder. But I think that will be too surprising, and limited value.

## Settings

When you click the hamburger menu ☰ on the title row, it replaces the main "OnePlay Music" tree with the topmost row "Settings" and an (X) to the right (similar to how Search replaces the main title row to have a topmost row with edit-field an an (X) to the right). The child area will be one big freeform scrollable div to contain settings; the Settings row at the top will be fixed.

Just like Search, Settings will also remember the exact tree state (selected-folder, scroll positions) so that when you click the X button then it will restore exactly.

Search doesn't re-use the "currently selected folder" styling because that's not how iPhone does it, and because it's not a currently selected folder. Likewise Settings won't re-use it. We'll just rely on styling of "Settings" to make it look like a heading. However the Settings title itself will have the same row height as the existing tree, just like Search does.

```
+----------------------+
| Settings         (X) |
|                      |
| OneDrive             |
| [Sign out]|[Reconnect...] | <-- only one or the other
|                      |
| Shared with you      |
|   share1 [Rename...][Remove...] |
|   share2 [Rename...][Remove...] |
|   Add [+...] |
|                      |
| Duration of Timer mode |
| [30]mins             |
|                      |
| Index|Indexing...    |
| OneDrive: 50% ⟳      |
| share1: 20% ⟳        |
| OR: Last updated 5mins ago ✓ |
| [Refresh now]        |
|                      |
| Debug                |
| [turn on]|[turn off] | <-- only on or the other
+----------------------+
```

Reconnect? That's because if you've failed Entra, then you need an explicit interactive signin. The hamburger ☰ will have gained a warning badge dot, and you'll have to do an explicit interactive signin. This is similar to existing iPhone apps where you navigate to the Accounts page and it shows accounts that have problems and need to be signed in again. The Sign out and Reconnect buttons will both dismiss the Settings dialog (indeed they redirect the main frame). The other buttons leave it open.

The shared-with-you buttons (Rename..., Remove..., Add...) both bring up modals: Remove brings a modal to confirm, and Add brings a modal for you to paste the URL. The Remove modal will tell you how many favorites currently reference items in that share, and its confirmatory "Remove" button will be destructive-styled. Upon removing a share, the normal healing process runs.

Bedtime timer will be a popup for a pre-made list of options, 15m, 30m, 45m, 60m, end-of-track. There is no option for "Off". The meaning of this is that if playback mode is set to "timer" then it will be used.

Index? This is the only place where people can see the progress of a long-running background index, which might take up to two minutes. Also, the Refresh button will kick off a background check. The Index will normally just be "up to date" if everything is up to date. But if anything is in progress, then it will be a list of all in-progress things, followed by our conventional spinner. It will say "Indexing..." when doing the probe (merkle size check) or settings sync with the words "Checking for updates ⟳", as well as when doing actual indexing using the notation described in the diagram above, a list of "Name: % ⟳" for each index that's currently ongoing. If a probe or settings sync concurrent with any indexing work, then it will prefer the "Checking for udpates" wording.

Bedtime timer and debug flags will persist to localStorage.

There's zero benefit to having some debug features turned on and off, and the list of debug features will change over time. That's why this is just a single all-encompassig option. I didn't put this under an Advanced section because this is the only advanced feature. I don't show version number because in a PWA, users will certainly be on the latest or second-latest version, and I'm not going to do frequent updates.


## Shares

Shares appear in the tree view as peers underneath the OneDrive icon.

You add them by going to the main settings page which has a button "Add share...". This brings up an "add share" modal. In it, you paste a share-url that someone has provided to you and click Add. When you click OK then it will make a network call to verify that the share is reachable, and show a spinner "adding...". Once complete we'll dismiss the modal. If there was failure, we'll leave the modal up and show the error so the user can edit the URL and try again; if success, then the share will be added to the Settings page, and the tree, and we'll have kicked off a background index that will in time update the "Indexing" section of the settings page.

The add-share modal has informative text "Other people can use their OneDrive app to share their music folders with you. Have them message you the URL, and paste it here".

The list of shares will be persisted on OneDrive and cached to IndexedDB. Each share also has our (renamable) name for it, which is also persisted likewise.  The initial name of the share will be derived from the share: if it's the entire OneDrive folder or the entire Music folder, then it will be the username of the person sharing (if we can derive their username from the share url). Otherwise it will be the name of the folder that was shared. This is all information that we derive while adding the share, before the the add-share modal gets dismissed.

Some people will share their entire OneDrive folder, in which case we will seek out the "Music" folder and index that. I don't know if this is possible in the OneDrive API? Can we look for canonical folders in shares? If we can't, we'll try some heuristics ("Music", "Musique", "My Music", whatever are the common ones). Some people will share their Music folder, in which case we'll index that. Others will share an arbitrary subfolder, in which case we'll index that. Note that the last two cases (share music folder, share arbitrary folder) are basically identical: we just index what's given to us.

The indexing of shares is algorithmically the same as indexing of the user's OneDrive but there's an important UX difference: the tree view isn't ever displayed without the OneDrive index, but it can and will be displayed before a share index has become available yet. If a share index isn't available, then tap-to-expand the share won't do anything. While a share index is underway, there'll be the standard spinning ⟳ icon to the right of it, same as OneDrive.

The index of the share will not be stored on the share (which will often be readonly); it will be stored on the primary OneDrive account.

In Select mode, share rows themselves are not selectable (same as OneDrive); only their children.

Background refreshes of shares happen similarly to background refreshes of OneDrive. There'll be an initial probe to check the merkle hash (size) of the entire folder, indicated by a spinner on the title row. The initial probes for OneDrive and shares can all be issued concurrently. The results of this probe will be used in evidence of state, as always, with no particular order: the evidence state machine will be updated as appropriate from the most recent call to succeed.

The difference is that if a share query fails, that's not evidence of being signed out; "signed out" solely refers to being signed out of the primary OneDrive account. If indexing is needed, we'll do them one at a time: OneDrive first, then shares in order. That's because indexing is extremely network-heavy, issuing a carefully controlled number of batch requests at a time, and doing multiple indexes concurrently would overwhelm it. For the merkle size of a share, if the share was the entire OneDrive account, we'll only use index (and use the Merkle size of) the Music folder; in all other cases we'll index and use the merkle size of whatever folder was given to us.

Let us use the word "denied" for when our attempt to access a share gets a permission error of some sort. (I'm avoiding the word "unavailable" since we already use that to refer to tracks that can't be played because we're offline or signed out and they're not cached). There might be several reasons why a share is denied. It might have been a time-limited share that ran out. Or the sharer might have rescinded their grant. In all cases, if a share is denied, then the hamburger ☰ will gain a warning badge dot, the same as when signed out. The user can click it to attempt to repair matters in the Settings dialog.

I believe that OneDrive shares can be password-protected. We won't bother supporting this. This will presumably result in a rejection when we try to add the url in the first place, and hopefully our alert() notice will be able to give the reason. If it's possible for an existing share url to change from open to password-protected, then that will count as denied, and I hope we'll be able to get a reason for it.

Denied shares are shown as normal folder rows in the tree view. But in the settings dialog, a share is denied will have a small row of text under it in the list explaining why it's denied. I don't know how much information we can get about reason? Hence I can't yet give concrete phrases to use here. For now let's show the what we get from OneDrive (error code, and error text if present) and I'll figure out next steps once I see it. The reason should be stored in ram. It doesn't need to be persisted; it will be updated each time we attempt a background refresh.

The name of the share in the Settings dialog is our name for it. Each share row in the settings dialog has two icons, (1) an edit icon which pops up a modal to rename it, (2) a delete icon which pops up a modal to confirm the delete. Both actions, if confirmed, will update the settings dialog, the tree, IndexedDB, and kick off a sync to OneDrive.

If you delete a share from the Settings dialog, it takes you to the "Disconnect from share" modal. If the share isn't used in any favorites, it will have the title "Disconnect from share" and the button to confirm will be a red one "Disconnect". If the share contributed to any favorites, the modal will have informative text "This will remove N tracks from M playlists". If you confirm disconnecting of a share, it will updated IndexDB and delete the OneDrive cache (and show this with a spinner) before closing the modal. The work to sync the updated list of shares to OneDrive will be kicked off as a normal sync in the background.

We earlier described the process of "healing" favorites. Healing of shared items will be slightly different. The reason is that if someone has shared with you, and you've done work to incorporate their tracks into your playlist, and then the share becomes denied, we don't want the work to go to waste. Therefore, (1) if there exist any denied shares, then we won't remove ANY shared items from playlists during healing. The playlist will still have the item, but it will be shown as unavailable. (2) During healing, if an item can be found in ANY non-denied shared item, then it will be kept. The specific scenario I have in mind is that a share has become denied, maybe because it was on a timer, and I ask my friend for a fresh share. He gives me the fresh share URL, and I add it, and then I remove the old denied share. (It would also be possible to change the URL of an existing share, but I think that will be confusing.) I expect that users will not leave disconnected shares around for long; I expect they'll fix them almost instantly.

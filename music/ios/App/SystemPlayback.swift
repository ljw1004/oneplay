import AVFoundation
import MediaPlayer
import os

/// System transport and the WebKit footer control the same native session. Remote
/// commands may arrive on any queue, including while the library page is suspended.
final class SystemPlayback {
    private let player: NativePlayback
    private let commands = MPRemoteCommandCenter.shared()
    private let publishedItem = OSAllocatedUnfairLock<String?>(initialState: nil)
    @MainActor private var artworkTask: Task<Void, Never>?
    @MainActor private var artwork: MPMediaItemArtwork?
    private var targets = [(MPRemoteCommand, Any)]()
    private var observers = [NSObjectProtocol]()

    init(player: NativePlayback, changed: @escaping @MainActor @Sendable () -> Void) {
        self.player = player
        for (command, action) in [(commands.playCommand, "play"), (commands.pauseCommand, "pause"),
                                  (commands.togglePlayPauseCommand, "toggle"), (commands.nextTrackCommand, "next"),
                                  (commands.previousTrackCommand, "previous"), (commands.changePlaybackPositionCommand, "seek")] {
            let target = command.addTarget { [weak self] event in
                guard let self else { return .commandFailed }
                let seek = event as? MPChangePlaybackPositionCommandEvent
                let item = publishedItem.withLock { $0 }
                guard let item else { return .noActionableNowPlayingItem }
                do {
                    guard try player.applyRemote(action, seconds: seek?.positionTime, displayedItem: seek == nil ? nil : item) else {
                        return .commandFailed
                    }
                    Task { @MainActor in changed() }
                    return .success
                } catch { return .commandFailed }
            }
            targets.append((command, target))
        }
        let center = NotificationCenter.default
        let audio = AVAudioSession.sharedInstance()
        observers.append(center.addObserver(forName: AVAudioSession.didBecomeInactiveNotification, object: audio, queue: .main) { note in
            guard let context = note.userInfo?[AVAudioSession.deactivationContextKey] as? AVAudioSession.DeactivationContext,
                  context.source == .system else { return }
            player.handleOutputChange(.interruption(mayResume: context.interruptionContext?.reason != .routeDisconnected))
            Task { @MainActor in changed() }
        })
        observers.append(center.addObserver(forName: AVAudioSession.resumptionRecommendationNotification, object: audio, queue: .main) { note in
            guard let context = note.userInfo?[AVAudioSession.resumptionContextKey] as? AVAudioSession.ResumptionContext else { return }
            do { try player.finishInterruption(shouldResume: context.recommendation == .shouldResume) }
            catch { Logger().notice("Interrupted recording unavailable on resume") }
            Task { @MainActor in changed() }
        })
        observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: audio, queue: .main) { note in
            guard let reason = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
                  reason == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue,
                  let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription,
                  previous.outputs.contains(where: { old in !audio.currentRoute.outputs.contains { $0.uid == old.uid } }) else { return }
            player.handleOutputChange(.routeDisconnected)
            Task { @MainActor in changed() }
        })
        observers.append(center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: audio, queue: .main) { _ in
            player.handleOutputChange(.servicesReset)
            Task { @MainActor in changed() }
        })
        observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) { note in
            guard let engine = note.object as? AVAudioEngine else { return }
            // Apple delivers this on the engine's internal queue. Retire it after that callback returns.
            DispatchQueue.main.async {
                if player.handleOutputChange(.configuration(engine)) { changed() }
            }
        })
    }

    deinit {
        for (command, target) in targets { command.removeTarget(target) }
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    /// Publish on transport and audible transitions. iOS advances elapsed time at the supplied rate.
    @MainActor func publishNowPlaying() {
        let sample = player.snapshot
        let state = sample["state"] as? String
        let coldRestore = state == "paused" && publishedItem.withLock { $0 == nil }
        let item = coldRestore ? nil : sample["item"] as? String
        if publishedItem.withLock({ $0 != item }) {
            artworkTask?.cancel()
            artworkTask = nil
            artwork = nil
        }
        publishedItem.withLock { $0 = item }
        let center = MPNowPlayingInfoCenter.default()
        commands.playCommand.isEnabled = item != nil
        commands.pauseCommand.isEnabled = item != nil
        commands.togglePlayPauseCommand.isEnabled = item != nil
        commands.previousTrackCommand.isEnabled = item != nil && sample["canPrevious"] as? Bool == true
        commands.nextTrackCommand.isEnabled = item != nil && sample["canNext"] as? Bool == true
        let duration = sample["duration"] as? Double ?? 0
        commands.changePlaybackPositionCommand.isEnabled = item != nil && duration > 0
        guard let item else {
            if center.nowPlayingInfo != nil { center.nowPlayingInfo = nil }
            return
        }
        if artworkTask == nil, state == "playing", let read = player.artworkReader(for: item) {
            artworkTask = Task.detached(priority: .utility) { [weak self] in
                guard !Task.isCancelled, let cover = NowPlayingArtwork.embedded(readPrefix: read) else { return }
                await MainActor.run { [weak self] in
                    guard !Task.isCancelled, let self, publishedItem.withLock({ $0 == item }) else { return }
                    artwork = cover
                    publishNowPlaying()
                }
            }
        }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: sample["systemTitle"] as? String ?? sample["title"] as? String ?? "",
            MPMediaItemPropertyAlbumTitle: sample["album"] as? String ?? "",
            MPNowPlayingInfoPropertyElapsedPlaybackTime: sample["position"] as? Double ?? 0,
            MPNowPlayingInfoPropertyPlaybackRate: state == "playing" ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue
        ]
        info[MPMediaItemPropertyArtwork] = artwork ?? NowPlayingArtwork.icon
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = max(duration, sample["position"] as? Double ?? 0) }
        center.nowPlayingInfo = info
    }
}

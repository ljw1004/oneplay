"""Exercise the real URLSession retry and rejected-range paths on local synthetic bytes."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event, Thread
import re
import subprocess

requests = []
server_overshoot = {}
block = 65536
tail_requested = Event()
metered_request = Event()
stalled_fixture = Event()
opening_cancelled = Event()


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        bounds = self.headers['Range']
        requests.append((self.path, bounds))
        lo, hi = map(int, re.fullmatch(r'bytes=(\d+)-(\d+)', bounds).groups())
        if self.path.startswith('/window'):
            length = (128 if self.path in ('/window-successor', '/window-seek', '/window-metered-ahead') else 12) * block
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {lo}-{hi}/{length}')
            self.send_header('Content-Length', str(hi-lo+1))
            self.end_headers()
            for offset in range(lo, hi+1, block):
                self.wfile.write(bytes([offset // block]) * block)
                if self.path == '/window-next-cancel' and offset == 0:
                    # Another request from the reopened decoder releases the abandoned response.
                    if not opening_cancelled.wait(5):
                        stalled_fixture.set()
                    return
                if self.path == '/window-next-cancel' and lo == block:
                    opening_cancelled.set()
                if self.path == '/window-wifi' and offset == 0:
                    # Full-response buffering deadlocks here. The decoder needs the head, then the tail.
                    if not tail_requested.wait(5):
                        stalled_fixture.set()
                        return
                elif self.path == '/window-wifi' and offset == 11*block:
                    tail_requested.set()
                elif self.path == '/window-switch' and lo == 0 and offset == 0:
                    if not metered_request.wait(5):
                        stalled_fixture.set()
                    # The client cancelled this wide response after the route changed.
                    return
                elif self.path == '/window-switch' and lo == block:
                    metered_request.set()
            return
        oversized = self.path in ['/oversized-503', '/ignored-range']
        length = block * (128 if oversized else 80 if self.path.startswith('/budget') else 2)
        if self.path in ['/redirected', '/final', '/resized']: length = block * 3
        # The last allowed 64 KiB speculative request meets a noncompliant server dumping 8 MiB.
        if oversized and lo == 28 * block:
            self.send_response(503 if self.path == '/oversized-503' else 200)
            self.send_header('Content-Length', str(length))
            self.end_headers()
            sent = 0
            try:
                while sent < length:
                    self.wfile.write(b'x' * 8192)
                    sent += 8192
            except (ConnectionResetError, BrokenPipeError):
                pass
            server_overshoot[self.path] = sent
            print(f'{self.path}: {sent} rejected-body bytes accepted by the server socket', flush=True)
            return
        # Renewed capabilities for the same Graph object can name independently validated CDN resources.
        tag = '"cdn-b"' if self.path in ['/renewed', '/budget-renewed', '/final'] else '"cdn-a"'
        validator = self.headers.get('If-Match')
        if validator is not None and validator != tag:
            self.send_response(412)
            data = b''
        elif len(requests) == 1:
            self.send_response(503)
            data = b'retry'
        elif self.path == '/redirected' and lo == block:
            self.send_response(302)
            self.send_header('Location', '/final')
            data = b'redirect'
        elif self.path in ['/expired','/denied'] or (self.path == '/audiobook' and lo == block):
            self.send_response(403)
            data = b'denied'
        elif lo >= length:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{length}')
            data = b''
        else:
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {lo}-{hi}/{length}')
            data = bytes([42])*(hi-lo+1)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('ETag', tag)
        self.end_headers()
        self.wfile.write(data)


with ThreadingHTTPServer(('127.0.0.1', 0), Fixture) as server, TemporaryDirectory() as temp:
    Thread(target=server.serve_forever, daemon=True).start()
    root = Path(__file__).resolve().parents[1]
    source = Path(temp)/'test.swift'
    source.write_text('''
import Foundation
@main struct Check {
    static func main() throws {
        let base = URL(string: CommandLine.arguments[1])!
        func source(_ length: Int64, initial: String = "initial") throws -> MeteredSource {
            let media = RemoteMP3(name:"synthetic",etag:"\\"v1\\"",bytes:length,
                                  initial:base.appendingPathComponent(initial),renewed:base.appendingPathComponent("renewed"))
            return try MeteredSource(media, number:1,speculative:true,trace:{print($0)})
        }
        let valid = try source(131072)
        let prefix = try valid.read(0,64)
        precondition(prefix == Data(repeating:42,count:64))
        precondition((65536...65541).contains(valid.specBytes))
        valid.promote()
        let cached = try valid.read(0,64)
        precondition(cached == prefix)
        try valid.finishRenewal()
        let continuation = try valid.read(65536,64)
        precondition(continuation == prefix)
        let wrongLength = try source(196608)
        do { _ = try wrongLength.read(131072,64); fatalError("416 accepted") }
        catch let error as PlaybackError { precondition(error.errorDescription?.contains("416") == true) }
        let budget = try source(80*65536,initial:"budget")
        do { _ = try budget.read(0,4_000_001); fatalError("Budget exceeded") }
        catch let error as PlaybackError { precondition(error.errorDescription == "Speculation budget exhausted") }
        precondition(budget.specBytes == 1_900_544)
        // Graph and CDN validators can be distinct. Replaying a failed range requires the same Graph version.
        func location(_ name: String, tag: String = "graph-v1", size: Int64 = 131072) -> MediaLocation {
            MediaLocation(url: base.appendingPathComponent(name), etag: tag, size: size)
        }
        var renewals = 0
        var diagnostics: [String] = []
        let expired = try MediaRanges(location("expired"), speculative: false, trace: { print($0) },
                                      diagnostic: { diagnostics.append($0) }, renew: { _ in
            renewals += 1; return location("fresh")
        })
        let afterExpiry = try expired.read(0, 8)
        precondition(afterExpiry == Data(repeating: 42, count: 8) && renewals == 1)
        precondition(diagnostics == ["HTTP 403; renewing media URL at offset 0", "Renewed media URL validated",
                                     "Renewed media URL returned HTTP 206 at offset 0"])
        let denied = try MediaRanges(location("denied"), speculative: false, trace: { print($0) }, renew: { _ in
            renewals += 1; return location("denied")
        })
        do { _ = try denied.read(0, 8); fatalError("Denied location accepted") }
        catch let error as PlaybackError { precondition(error.errorDescription?.contains("403") == true) }
        precondition(renewals == 2)
        let replacing = try MediaRanges(location("expired"), speculative: true, trace: { print($0) }, renew: { _ in
            location("wrong-version", tag: "graph-v2")
        })
        do { _ = try replacing.read(0, 8); fatalError("Version mismatch accepted") }
        catch let error as PlaybackError { precondition(error.errorDescription == "Recording changed during playback") }
        let local = try MediaRanges(location("local"), speculative: true, trace: { print($0) })
        _ = try local.read(0, 8)
        local.promote()
        do { try local.renewLocation { location("wrong-size",size:131071) }; fatalError("Size mismatch accepted") }
        catch let error as PlaybackError { precondition(error.errorDescription == "Recording changed during playback") }
        let redirected = try MediaRanges(location("redirected",size:3*65536), speculative: true, trace: { print($0) })
        _ = try redirected.read(0, 8)
        let fromFinal = try redirected.read(65536, 8)
        let afterRedirect = try redirected.read(131072, 8)
        precondition(fromFinal == afterExpiry && afterRedirect == afterExpiry)
        // A compliant large object exhausts speculation, then continues at the first missing block on demand.
        var promoted = 0
        let size = Int64(80*65536)
        let continuationSource = try MediaRanges(location("budget-initial",size:size), speculative:true,
            trace:{ _ in }, awaitDemand:{ promoted += 1 }, renew:{ _ in fatalError("Promotion renewed a valid grant") })
        _ = try continuationSource.read(0,2_000_000)
        precondition(promoted == 1 && continuationSource.specBytes == 1_900_544)
        for kind in ["oversized-503","ignored-range"] {
            let hostile = try MediaRanges(location(kind,size:8*1024*1024),speculative:true,trace:{print($0)})
            do { _ = try hostile.read(0,2_000_000); fatalError("Oversized speculative response accepted") }
            catch let error as PlaybackError { precondition(error.errorDescription?.contains("Oversized speculative") == true) }
            precondition(hostile.specBytes <= MediaRanges.limit)
        }
        for wifi in [true, false] {
            let name = wifi ? "window-wifi" : "window-cell"
            let pool = MediaPool(unmeteredWiFi: { wifi })
            let length = Int64(12*65536)
            func open(_ tag: String = "v1") throws -> MediaRanges {
                try MediaRanges(location(name, tag: tag, size: length), drive: "d", item: "i",
                                pool: pool, speculative: false, trace: { _ in })
            }
            let first = try open()
            for block in [0,11,1,2,3] {
                let data = try first.read(Int64(block*65536), 65536)
                precondition(data == Data(repeating: UInt8(block), count: 65536))
                if wifi && block == 0 {
                    let bar = pool.debugRanges(drive: "d", item: "i")
                    precondition(bar["cached"] as? [[Int64]] == [[0,65536]])
                    precondition(bar["fetching"] as? [[Int64]] == [[0,11*65536]])
                }
            }
            first.cancelAndDrain()
            precondition((pool.debugRanges(drive: "d", item: "i")["fetching"] as? [[Int64]])?.isEmpty == true)
            let reopened = try MediaRanges(location(name, tag: "v1", size: length), drive: "d", item: "i", pool: pool,
                                           speculative: false, trace: { _ in },
                                           renew: { _ in fatalError("Seek requested metadata") })
            let retained = try reopened.read(3*65536+7, 1)
            precondition(retained == Data([3]))
            if !wifi {
                let missing = try reopened.read(6*65536+7, 1)
                precondition(missing == Data([6]))
            }
            reopened.cancelAndDrain()
            let revised = try open("v2")
            _ = try revised.read(11*65536, 1)
            revised.cancelAndDrain()
        }
        final class Route: @unchecked Sendable {
            private let lock = NSLock()
            private var wifi = true
            var unmetered: Bool { lock.withLock { wifi } }
            func setMetered() { lock.withLock { wifi = false } }
        }
        let route = Route()
        let changingPool = MediaPool(unmeteredWiFi: { route.unmetered })
        let changing = try MediaRanges(location("window-switch", size: 12*65536), drive:"d", item:"switch",
                                       pool: changingPool, speculative: false, trace:{ _ in })
        _ = try changing.read(0, 1)
        route.setMetered()
        changingPool.cancelWiFiReadsIfMetered()
        let onCellular = try changing.read(65536, 1)
        precondition(onCellular == Data([1]))
        changing.cancelAndDrain()
        // A re-prepared successor owns its prior wire charge even after evicting all cached data.
        // The missing middle of a late metered seek streams in one GET. Normal demand resumes at four blocks.
        let seek = try MediaRanges(location("window-seek", size: 128*65536), speculative: false, trace: { _ in })
        seek.meteredSeekByte = 93*65536 + 25
        for i in 4..<97 {
            let bytes = try seek.read(Int64(i*65536), 1)
            precondition(bytes == Data([UInt8(i)]))
        }
        seek.finishMeteredSeek()
        _ = try seek.read(97*65536, 1)
        seek.cancelAndDrain()
        // Even a far-off time estimate only admits 32 blocks of metered read-ahead for the current track.
        let ahead = try MediaRanges(location("window-metered-ahead", size: 128*65536), speculative: false, trace: { _ in })
        try ahead.extendMeteredWindow(through: 100*65536)
        let received = try ahead.read(0, 32*65536)
        precondition(received.count == 32*65536 && received.last == 31)
        ahead.cancelAndDrain()
        let successor = try MediaRanges(location("window-metered-ahead", size: 128*65536), speculative: true, trace: { _ in })
        try successor.extendMeteredWindow(through: 100*65536)
        successor.cancelAndDrain()
        let ledger = MediaRanges.Budget()
        let specPool = MediaPool()
        for n in 1...2 {
            let again = try MediaRanges(location("budget-reopened", size: size), drive: "d", item: "i",
                                        pool: specPool, budget: ledger, occurrence: 2, speculative: true, trace: { _ in })
            _ = try again.read(0, 1)
            precondition(again.specBytes == n * 65536)
            again.cancelAndDrain()
            specPool.clear()
        }
        // The manual Next opening is available before the rolling window reaches it.
        // Two HTTP reads cover the metered prefix and independent tail; reopening is cache-only.
        let earlyPool = MediaPool()
        let earlySize = Int64(12*65536)
        let inspecting = DispatchSemaphore(value: 0)
        let openingWindow = MediaRanges.SuccessorWindow { inspecting.signal(); return MediaRanges.openingPrefix }
        let opening = try MediaRanges(location("window-next-opening", size: earlySize), drive:"d", item:"next",
                                      pool:earlyPool, speculative:true, successorWindow: openingWindow, trace:{ _ in })
        let headByte = try opening.read(0, 1)
        let tailByte = try opening.read(earlySize-1, 1)
        precondition(headByte == Data([0]) && tailByte == Data([11]) && opening.specBytes == 5*65536)
        // A high-bitrate decoder can be parked at the first block past the opening when Next is tapped.
        while inspecting.wait(timeout: .now()) == .success {}
        let retired = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            do { _ = try opening.read(MediaRanges.openingPrefix, 1); fatalError("Read past early prefix") }
            catch is CancellationError { retired.signal() }
            catch { fatalError(error.localizedDescription) }
        }
        precondition(inspecting.wait(timeout: .now()+3) == .success)
        opening.cancelAndDrain()
        precondition(retired.wait(timeout: .now()+3) == .success)
        openingWindow.releaseAtJoin()
        let manual = try MediaRanges(location("window-next-opening", size:earlySize), drive:"d", item:"next",
                                     pool:earlyPool, speculative:false, trace:{ _ in })
        for block in 0..<4 {
            let value = try manual.read(Int64(block)*65536, 1)
            precondition(value == Data([UInt8(block)]))
        }
        let finalByte = try manual.read(earlySize-1, 1)
        precondition(finalByte == tailByte)
        manual.cancelAndDrain()
        // Tap Next after the first block arrives, while the other three blocks are still pending.
        let partialPool = MediaPool()
        let partialWindow = MediaRanges.SuccessorWindow { MediaRanges.openingPrefix }
        let pending = try MediaRanges(location("window-next-cancel", size:earlySize), drive:"d", item:"next",
                                      pool:partialPool, speculative:true, successorWindow: partialWindow, trace:{ _ in })
        let finished = DispatchGroup()
        finished.enter()
        DispatchQueue.global().async {
            defer { finished.leave() }
            _ = try? pending.read(0, 1)
        }
        let deadline = Date().addingTimeInterval(3)
        while partialPool.read(pending.file, at:0) == nil && Date() < deadline { Thread.sleep(forTimeInterval:0.01) }
        precondition(partialPool.read(pending.file, at:0) != nil)
        pending.cancelAndDrain()
        partialWindow.releaseAtJoin()
        precondition(finished.wait(timeout:.now()+3) == .success && pending.specBytes >= 65536)
        let afterTap = try MediaRanges(location("window-next-cancel", size:earlySize), drive:"d", item:"next",
                                       pool:partialPool, speculative:false, trace:{ _ in })
        let retained = try afterTap.read(0, 1)
        let missing = try afterTap.read(65536, 1)
        precondition(retained == Data([0]) && missing == Data([1]))
        afterTap.cancelAndDrain()
        // A sparse current track leaves 1 MB before EOF. The unmetered successor may fill the remaining
        // 5 MB, even when Core Audio scans beyond the narrow preparation budget before producing PCM.
        let windowPool = MediaPool(unmeteredWiFi: { true })
        let b = Int64(MediaRanges.block)
        var allowance: Int64 = 5_000_000
        let growingWindow = MediaRanges.SuccessorWindow { allowance }
        let next = try MediaRanges(location("window-successor", size: 128*b), drive: "d", item: "next",
                                   pool: windowPool, speculative: true, successorWindow: growingWindow, trace: { _ in })
        _ = try next.read(0, 1)
        _ = try next.read(allowance/b*b-1, 1)
        _ = try next.read(128*b-1, 1) // independent tail, charged once
        allowance = MediaRanges.wifiWindow
        try next.extendWindow(from: 0, to: allowance)
        _ = try next.read(allowance/b*b-1, 1)
        precondition(windowPool.read(next.file, at: allowance/b*b) == nil && next.specBytes == b)
        growingWindow.releaseAtJoin()
        next.promote()
        let retainedHead = try next.read(0, 1)
        precondition(retainedHead == Data([0]))
        next.cancelAndDrain()
        // Simulate expiry between reads in a single recording. The first missing offset resumes on the fresh grant.
        let initial = location("audiobook")
        var refreshed = 0
        let audiobook = try MediaRanges(initial, speculative: false, trace: { _ in }, renew: { rejected in
            precondition(rejected === initial)
            refreshed += 1
            return location("audiobook-fresh")
        })
        _ = try audiobook.read(0, 8)
        _ = try audiobook.read(65536, 8)
        _ = try audiobook.read(0, 8)
        precondition(refreshed == 1)
        // The old interval still fits. A compliant 206 reports the larger file in Content-Range.
        var sizeChecks = 0
        let resized = try MediaRanges(location("resized"), speculative: false, trace: { _ in }, renew: { _ in
            sizeChecks += 1
            return location("resized", size: 3*65536)
        })
        do { _ = try resized.read(0, 1); fatalError("Mixed different sizes") }
        catch let error as PlaybackError { precondition(error.errorDescription == "Recording changed during playback") }
        precondition(sizeChecks == 1)
        local.cancel()
        do { _ = try local.read(0, 8); fatalError("Cancelled cache hit") } catch is CancellationError {}
    }
}
''')
    binary = Path(temp)/'check'
    subprocess.run(['swiftc','-D','DEBUG','-D','CELLULAR_PROBE','-D','RANGE_TRANSPORT_TEST',root/'App/MeteredSource.swift',
                    root.parents[1]/'music/ios/App/MediaRanges.swift',source,'-o',binary],check=True)
    subprocess.run([binary, f'http://127.0.0.1:{server.server_port}'],check=True)
    assert requests[:4] == [('/initial','bytes=0-65535'),('/initial','bytes=0-65535'),
                        ('/renewed','bytes=65536-131071'),('/initial','bytes=131072-196607')], requests
    expected = [('/budget',f'bytes={block*i}-{block*(i+1)-1}') for i in range(29)]
    assert requests[4:33] == expected
    assert requests[33:39] == [(f'/{name}', 'bytes=0-65535') for name in
                             ['expired', 'fresh', 'denied', 'denied', 'expired', 'local']]
    assert requests[39:43] == [('/redirected','bytes=0-65535'), ('/redirected','bytes=65536-131071'),
                               ('/final','bytes=65536-131071'), ('/final','bytes=131072-196607')]
    assert requests[43:72] == [('/budget-initial', f'bytes={block*i}-{block*(i+1)-1}') for i in range(29)]
    assert requests[72] == ('/budget-initial', f'bytes={29*block}-{33*block-1}')
    assert all(28*block + sent < 4_000_000 for sent in server_overshoot.values()), server_overshoot
    assert set(server_overshoot) == {'/oversized-503', '/ignored-range'}
    for path, window in [('/window-wifi', 11), ('/window-cell', 4)]:
        tail = f'bytes={11*block}-{12*block-1}'
        missing = [f'bytes={6*block}-{10*block-1}'] if path == '/window-cell' else []
        assert [r for p, r in requests if p == path] == [f'bytes=0-{window*block-1}', tail, *missing, tail]
    assert [(p,r) for p,r in requests if p.startswith('/audiobook')] == [
        ('/audiobook','bytes=0-65535'), ('/audiobook','bytes=65536-131071'), ('/audiobook-fresh','bytes=65536-131071')]
    switched = [r for p, r in requests if p == '/window-switch']
    assert switched[0] == f'bytes=0-{11*block-1}'
    assert len(switched) == 2 and switched[1] in (f'bytes={block}-{2*block-1}', f'bytes={block}-{5*block-1}'), switched
    assert [r for p, r in requests if p == '/window-next-cancel'] == [f'bytes=0-{4*block-1}', f'bytes={block}-{5*block-1}']
    assert [r for p, r in requests if p == '/window-next-opening'] == [f'bytes=0-{4*block-1}', f'bytes={11*block}-{12*block-1}']
    assert [r for p, r in requests if p == '/window-successor'] == [
        f'bytes=0-{76*block-1}', f'bytes={127*block}-{128*block-1}', f'bytes={76*block}-{91*block-1}']
    sought = [r for p, r in requests if p == '/window-seek']
    assert sought == [f'bytes={4*block}-{97*block-1}', f'bytes={97*block}-{101*block-1}'], sought
    assert [r for p, r in requests if p == '/window-metered-ahead'] == [f'bytes=0-{32*block-1}']
    assert not stalled_fixture.is_set(), "Decoder failed to make progress before fixture timeout"
    server.shutdown()

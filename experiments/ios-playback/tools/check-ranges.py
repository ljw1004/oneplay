"""Exercise the real URLSession retry and rejected-range paths on local synthetic bytes."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import re
import subprocess

requests = []
server_overshoot = {}
renewed_ranges = []
block = 65536


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        bounds = self.headers['Range']
        requests.append((self.path, bounds))
        lo, hi = map(int, re.fullmatch(r'bytes=(\d+)-(\d+)', bounds).groups())
        oversized = self.path in ['/oversized-503', '/ignored-range']
        length = block * (128 if oversized else 80 if self.path.startswith('/budget') else 2)
        if self.path in ['/redirected', '/final']: length = block * 3
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
        if self.path == '/budget-renewed':
            renewed_ranges.append((lo, validator))
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
        elif self.path in ['/expired','/denied']:
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
        do { _ = try valid.read(65536,64); fatalError("Expired location allowed") }
        catch let error as PlaybackError { precondition(error.errorDescription == "Expired URL blocked") }
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
                                      diagnostic: { diagnostics.append($0) }, renew: {
            renewals += 1; return location("fresh")
        })
        let afterExpiry = try expired.read(0, 8)
        precondition(afterExpiry == Data(repeating: 42, count: 8) && renewals == 1)
        precondition(diagnostics == ["HTTP 403; renewing media URL at offset 0", "Renewed media URL validated",
                                     "Renewed media URL returned HTTP 206 at offset 0"])
        let denied = try MediaRanges(location("denied"), speculative: false, trace: { print($0) }, renew: {
            renewals += 1; return location("denied")
        })
        do { _ = try denied.read(0, 8); fatalError("Denied location accepted") }
        catch let error as PlaybackError { precondition(error.errorDescription?.contains("403") == true) }
        precondition(renewals == 2)
        let replacing = try MediaRanges(location("expired"), speculative: true, trace: { print($0) }, renew: {
            location("wrong-version", tag: "graph-v2")
        })
        do { _ = try replacing.read(0, 8); fatalError("Version mismatch accepted") }
        catch let error as PlaybackError { precondition(error.errorDescription == "Recording changed during playback") }
        let local = try MediaRanges(location("local"), speculative: true, trace: { print($0) })
        _ = try local.read(0, 8)
        local.promote()
        do { try local.installRenewal(location("wrong-size",size:131071)); fatalError("Size mismatch accepted") }
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
            trace:{ _ in }, awaitDemand:{ promoted += 1 }, renew:{ location("budget-renewed",size:size) })
        _ = try continuationSource.read(0,2_000_000)
        precondition(promoted == 1 && continuationSource.specBytes == 1_900_544)
        for kind in ["oversized-503","ignored-range"] {
            let hostile = try MediaRanges(location(kind,size:8*1024*1024),speculative:true,trace:{print($0)})
            do { _ = try hostile.read(0,2_000_000); fatalError("Oversized speculative response accepted") }
            catch let error as PlaybackError { precondition(error.errorDescription?.contains("Oversized speculative") == true) }
            precondition(hostile.specBytes <= MediaRanges.limit)
        }
        local.cancel()
        do { _ = try local.read(0, 8); fatalError("Cancelled cache hit") } catch is CancellationError {}
    }
}
''')
    binary = Path(temp)/'check'
    subprocess.run(['swiftc','-D','CELLULAR_PROBE','-D','RANGE_TRANSPORT_TEST',root/'App/MeteredSource.swift',
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
    assert requests[43:74] == [(f'/budget-{"initial" if i < 29 else "renewed"}', f'bytes={block*i}-{block*(i+1)-1}') for i in range(31)]
    assert renewed_ranges == [(29*block, None), (30*block, '"cdn-b"')], renewed_ranges
    assert all(28*block + sent < 4_000_000 for sent in server_overshoot.values()), server_overshoot
    assert set(server_overshoot) == {'/oversized-503', '/ignored-range'}
    server.shutdown()

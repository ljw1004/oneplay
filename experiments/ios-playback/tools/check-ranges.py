"""Exercise the real URLSession retry and rejected-range paths on local synthetic bytes."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import re
import subprocess

requests = []
block = 65536


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        bounds = self.headers['Range']
        requests.append((self.path, bounds))
        lo, hi = map(int, re.fullmatch(r'bytes=(\d+)-(\d+)', bounds).groups())
        length = block * (80 if self.path == '/budget' else 2)
        if len(requests) == 1:
            self.send_response(503)
            data = b'retry'
        elif lo >= length:
            self.send_response(416)
            self.send_header('Content-Range', f'bytes */{length}')
            data = b''
        else:
            self.send_response(206)
            self.send_header('Content-Range', f'bytes {lo}-{hi}/{length}')
            data = bytes([42])*(hi-lo+1)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('ETag', '"v1"')
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
        catch let error as ProbeError { precondition(error.errorDescription == "Expired URL blocked") }
        valid.finishRenewal()
        let continuation = try valid.read(65536,64)
        precondition(continuation == prefix)
        let wrongLength = try source(196608)
        do { _ = try wrongLength.read(131072,64); fatalError("416 accepted") }
        catch let error as ProbeError { precondition(error.errorDescription?.contains("416") == true) }
        let budget = try source(80*65536,initial:"budget")
        do { _ = try budget.read(0,4_000_001); fatalError("Budget exceeded") }
        catch let error as ProbeError { precondition(error.errorDescription == "Speculation budget exhausted") }
        precondition(budget.specBytes == 3_997_696)
    }
}
''')
    binary = Path(temp)/'check'
    subprocess.run(['swiftc','-D','CELLULAR_PROBE','-D','RANGE_TRANSPORT_TEST',root/'App/MeteredSource.swift',
                    root/'App/Splice.swift',source,'-o',binary],check=True)
    subprocess.run([binary, f'http://127.0.0.1:{server.server_port}'],check=True)
    assert requests[:4] == [('/initial','bytes=0-65535'),('/initial','bytes=0-65535'),
                        ('/renewed','bytes=65536-131071'),('/initial','bytes=131072-196607')], requests
    expected = [('/budget',f'bytes={block*i}-{block*(i+1)-1}') for i in range(61)]
    assert requests[4:] == expected
    server.shutdown()

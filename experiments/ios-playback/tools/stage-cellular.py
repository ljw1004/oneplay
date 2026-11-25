"""Stage a disposable MP3 origin on unto.me and write a private local manifest."""
import hashlib
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import urllib.request

os.umask(0o077)
root = Path('/tmp/oneplay-gate2')
root.mkdir(exist_ok=True)
# A fresh pair of unlisted HTTPS locations per fixture lets the app retire one at promotion.
folder = 'probe-' + secrets.token_hex(20)
parent = '/mnt/disks/pod7disk/www/untome/oneplay'
tracks = []
with tempfile.TemporaryDirectory() as temp:
    stage = Path(temp)
    for n in range(1, 12):
        original = next((Path.home()/'Downloads/gapless').glob(f'Pink Floyd*[[]{min(n,10):02d}]*.mp3'))
        file = stage / (secrets.token_hex(16)+'.mp3')
        if n == 11:
            subprocess.run(['ffmpeg','-nostdin','-v','error','-stream_loop','-1','-i', original,
                            '-t','7200','-c:a','copy',file],check=True)
        else:
            os.link(original,file)
        other = stage / (secrets.token_hex(16)+'.mp3')
        os.link(file, other)
        base = f'https://unto.me/oneplay/{folder}/'
        tracks.append(dict(name=original.name if n<11 else 'Two-hour MP3 cancellation control',
                           bytes=file.stat().st_size,sha256=hashlib.file_digest(file.open('rb'),'sha256').hexdigest(),
                           initial=base+file.name, renewed=base+other.name))
    stage.chmod(0o755)
    (root/'staging.json').write_text(json.dumps(tracks))
    subprocess.run(['rsync','-rH','--perms','--chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r',
                    str(stage)+'/',f'lu@unto.me:{parent}/{folder}/'],check=True)
subprocess.run(['ssh','lu@unto.me',f'chmod 755 {parent}/{folder} && chmod 644 {parent}/{folder}/*.mp3'],check=True)
(root/'origin-name').write_text(folder)
for track in tracks:
    req = urllib.request.Request(track['initial'],headers={'Range':'bytes=0-0'})
    with urllib.request.urlopen(req,timeout=12) as r:
        assert r.status==206 and r.headers['Content-Range']==f"bytes 0-0/{track['bytes']}" and len(r.read())==1
        track['etag']=r.headers['ETag']
    req = urllib.request.Request(track['renewed'],method='HEAD')
    with urllib.request.urlopen(req,timeout=12) as r:
        assert r.headers['ETag']==track['etag'] and int(r.headers['Content-Length'])==track['bytes']
(root/'cellular.json').write_text(json.dumps(tracks))
print('Verified both HTTPS locations for',len(tracks),'MP3 fixtures; 206, byte length and strong ETag.')

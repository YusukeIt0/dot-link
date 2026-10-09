"""Build the arm64 runtime for the personal Mac installer; no system installation."""
import hashlib, json, shutil, subprocess, tarfile, urllib.request, zipfile
from pathlib import Path
root=Path(__file__).resolve().parent.parent
cache=root/'.runtime/vendor'; cache.mkdir(parents=True,exist_ok=True)
manifest=json.loads((root/'scripts/mac-runtime-manifest.json').read_text())
def download(name, spec):
    path=cache/name
    if path.exists() and spec.get('sha256') and hashlib.sha256(path.read_bytes()).hexdigest()==spec['sha256']: return path
    tmp=path.with_suffix(path.suffix+'.partial')
    with urllib.request.urlopen(urllib.request.Request(spec['url'],headers={'User-Agent':'Dot-Link-build'}),timeout=60) as source, tmp.open('wb') as target:
        shutil.copyfileobj(source,target)
    digest=hashlib.sha256(tmp.read_bytes()).hexdigest()
    if spec.get('sha256') and digest!=spec['sha256']: tmp.unlink(); raise RuntimeError('Checksum mismatch: '+name)
    tmp.replace(path)
    if not spec.get('sha256'):
        spec['sha256']=digest
        (root/'scripts/mac-runtime-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print('Verified '+name,flush=True); return path
node=download('node.tar.xz',manifest['node']); tunnel=download('tunnel.zip',manifest['tunnel']); whisper=download('whisper.tar.gz',manifest['whisper'])
for archive, dest in [(node,cache/'node-source'),(whisper,cache/'whisper-source')]:
    dest.mkdir(exist_ok=True)
    with tarfile.open(archive) as tf:
        for item in tf.getmembers():
            if item.name.startswith('/') or '..' in Path(item.name).parts: raise RuntimeError('Unexpected archive path')
    subprocess.run(['/usr/bin/tar','xf',str(archive),'-C',str(dest),'--strip-components=1'],check=True)
tunnelDir=cache/'tunnel-source'; tunnelDir.mkdir(exist_ok=True)
with zipfile.ZipFile(tunnel) as z:
    if any(x.startswith('/') or '..' in Path(x).parts for x in z.namelist()): raise RuntimeError('Unexpected archive path')
    z.extractall(tunnelDir)
source=cache/'whisper-source'; build=cache/'whisper-build'
subprocess.run(['cmake','-S',str(source),'-B',str(build),'-DCMAKE_BUILD_TYPE=Release',f'-DCMAKE_C_FLAGS=-ffile-prefix-map={root}=/src/dot-link',f'-DCMAKE_CXX_FLAGS=-ffile-prefix-map={root}=/src/dot-link','-DBUILD_SHARED_LIBS=OFF','-DGGML_METAL=ON','-DGGML_METAL_EMBED_LIBRARY=ON','-DGGML_BLAS=OFF','-DGGML_NATIVE=OFF','-DGGML_CPU_ARM_ARCH=armv8.2-a','-DWHISPER_CURL=OFF','-DWHISPER_BUILD_TESTS=OFF','-DWHISPER_BUILD_EXAMPLES=ON','-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0'],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['cmake','--build',str(build),'--config','Release','--target','whisper-cli','-j','4'],check=True,stdout=subprocess.DEVNULL)
runtime=cache/'runtime'; (runtime/'bin').mkdir(parents=True,exist_ok=True); (runtime/'licenses').mkdir(exist_ok=True)
for name, path in [('node',cache/'node-source/bin/node'),('tunnel-client',next(tunnelDir.rglob('tunnel-client'))),('whisper-cli',build/'bin/whisper-cli')]:
    shutil.copy2(path,runtime/'bin'/name); (runtime/'bin'/name).chmod(0o755)
    links=subprocess.check_output(['/usr/bin/otool','-L',str(runtime/'bin'/name)],text=True)
    if '/opt/homebrew/' in links or '/usr/local/' in links: raise RuntimeError('Nonportable binary: '+name)
    print('Bundled '+name,flush=True)
for src,name in [(cache/'node-source/LICENSE','Node-LICENSE.txt'),(source/'LICENSE','Whisper-LICENSE.txt')]: shutil.copy2(src,runtime/'licenses'/name)
for src in tunnelDir.rglob('*'):
    if src.is_file() and ('license' in src.name.lower() or src.name.upper()=='NOTICE' or src.suffix=='.txt'): shutil.copy2(src,runtime/'licenses'/('Tunnel-'+src.name))
shutil.copy2(root/'scripts/mac-runtime-manifest.json',runtime/'manifest.json')
print('Mac runtime ready',flush=True)

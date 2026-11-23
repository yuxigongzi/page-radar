import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(ROOT, "dist")
VERSION = json.load(open(os.path.join(ROOT, "manifest.json"), encoding="utf-8"))["version"]
ZIP_OUT = os.path.join(DIST, "page-radar-%s.zip" % VERSION)
CRX_OUT = os.path.join(DIST, "page-radar-%s.crx" % VERSION)
KEY = os.path.join(DIST, "page-radar-key.pem")

INCLUDE_DIRS = ["background", "content", "offscreen", "popup", "options", "icons", "shared"]
EXCLUDE = {"test", "tools", "dist", ".git"}

BROWSER_CANDIDATES = [
    os.environ.get("BROWSER_PATH", ""),
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]


def collect():
    files = [("manifest.json", os.path.join(ROOT, "manifest.json")),
             ("README.md", os.path.join(ROOT, "README.md")),
             ("DEVELOPER.md", os.path.join(ROOT, "DEVELOPER.md"))]
    for d in INCLUDE_DIRS:
        base = os.path.join(ROOT, d)
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [x for x in dirnames if x not in EXCLUDE]
            for f in filenames:
                full = os.path.join(dirpath, f)
                files.append((os.path.relpath(full, ROOT).replace(os.sep, "/"), full))
    return files


def build_zip(files):
    if os.path.exists(ZIP_OUT):
        os.remove(ZIP_OUT)
    with zipfile.ZipFile(ZIP_OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        for arc, full in files:
            zf.write(full, arc)
    print("built", ZIP_OUT)
    print("files", len(files))
    print("bytes", os.path.getsize(ZIP_OUT))


def find_browser():
    for cand in BROWSER_CANDIDATES:
        if cand and os.path.exists(cand):
            return cand
    return None


def build_crx(files):
    browser = find_browser()
    if not browser:
        print("skip crx: no Chrome/Edge binary found (set BROWSER_PATH)")
        return

    stage = tempfile.mkdtemp(prefix="pageradar-pack-")
    ext_dir = os.path.join(stage, "page-radar")
    profile = tempfile.mkdtemp(prefix="pageradar-pack-profile-")
    try:
        for arc, full in files:
            dest = os.path.join(ext_dir, arc.replace("/", os.sep))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copy2(full, dest)

        cmd = [browser, "--user-data-dir=" + profile, "--pack-extension=" + ext_dir, "--no-message-box"]
        if os.path.exists(KEY):
            cmd.append("--pack-extension-key=" + KEY)
        subprocess.run(cmd, timeout=180, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        crx = ext_dir + ".crx"
        pem = ext_dir + ".pem"
        if not os.path.exists(crx):
            print("skip crx: packer produced no output")
            return
        shutil.copy2(crx, CRX_OUT)
        if not os.path.exists(KEY) and os.path.exists(pem):
            shutil.copy2(pem, KEY)
            print("saved signing key", KEY)
        print("built", CRX_OUT)
        print("bytes", os.path.getsize(CRX_OUT))

        verify = os.path.join(ROOT, "tools", "verify_crx.mjs")
        if os.path.exists(verify):
            subprocess.run(["node", verify, CRX_OUT], check=False)
    finally:
        shutil.rmtree(stage, ignore_errors=True)
        shutil.rmtree(profile, ignore_errors=True)


files = collect()
build_zip(files)
build_crx(files)

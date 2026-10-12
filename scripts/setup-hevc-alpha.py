"""Build a local, Alpha-enabled HEVC encoder without replacing system FFmpeg."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
SOURCES = {
    "nasm": (
        "nasm-2.16.03.tar.xz", "https://www.nasm.us/pub/nasm/releasebuilds/2.16.03/nasm-2.16.03.tar.xz",
        "1412a1c760bbd05db026b6c0d1657affd6631cd0a63cddb6f73cc6d4aa616148",
    ),
    "x265": (
        "x265-4.2.tar.gz",
        "https://bitbucket.org/multicoreware/x265_git/get/e444744c03978c1fb4e037168967020cf2648427.tar.gz",
        "0a3d41f6b4e2fe5a49d783d6631bd1a49c44cdf999074a3ff09e2cb71ac8ed33",
    ),
    "ffmpeg": (
        "ffmpeg-8.1.tar.xz", "https://ffmpeg.org/releases/ffmpeg-8.1.tar.xz",
        "b072aed6871998cce9b36e7774033105ca29e33632be5b6347f3206898e0756a",
    ),
    "pkgconf": (
        "pkgconf-2.5.1.tar.xz", "https://distfiles.dereferenced.org/pkgconf/pkgconf-2.5.1.tar.xz",
        "cd05c9589b9f86ecf044c10a2269822bc9eb001eced2582cfffd658b0a50c243",
    ),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prefix", type=Path, default=ROOT / ".tools/hevc-alpha")
    parser.add_argument("--jobs", type=int, default=min(4, os.cpu_count() or 1))
    parser.add_argument("--force", action="store_true", help="Rebuild even if this version is already installed")
    args = parser.parse_args()
    if args.jobs < 1:
        parser.error("--jobs must be positive")
    prefix = args.prefix.resolve()
    prefix.mkdir(parents=True, exist_ok=True)
    sys.path.insert(0, str(ROOT))
    from backend.hevc import probe_hevc_alpha
    versions = {"ffmpeg": "8.1", "x265": "4.2", "alpha": True, "buildRevision": 1}
    metadata = prefix / "versions.json"
    if not args.force and metadata.exists() and json.loads(metadata.read_text()) == versions:
        if probe_hevc_alpha(str(prefix / "bin/ffmpeg"))["available"]:
            print(f"HEVC Alpha already ready: {prefix / 'bin/ffmpeg'}", flush=True)
            return
    build = prefix / "build"
    build.mkdir(exist_ok=True)
    env = {**os.environ, "PATH": str(prefix / "bin") + os.pathsep + os.environ.get("PATH", ""),
           "PKG_CONFIG_PATH": str(prefix / "lib/pkgconfig")}
    log_path = prefix / "build.log"

    def run(label, command, cwd=build):
        print(label, flush=True)
        with log_path.open("ab") as log:
            log.write(("\n" + " ".join(map(str, command)) + "\n").encode())
            subprocess.run(list(map(str, command)), cwd=cwd, env=env, stdout=log, stderr=log, check=True)

    def source(name):
        filename, url, digest = SOURCES[name]
        downloads = prefix / "downloads"
        downloads.mkdir(exist_ok=True)
        archive = downloads / filename
        if not archive.exists():
            print(f"Downloading {filename}…", flush=True)
            temporary = archive.with_suffix(".partial")
            try:
                with urlopen(url, timeout=90) as response, temporary.open("wb") as target:
                    shutil.copyfileobj(response, target)
                temporary.replace(archive)
            finally:
                temporary.unlink(missing_ok=True)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != digest:
            raise RuntimeError(f"SHA-256 mismatch for {archive}; remove it and retry.")
        destination = build / name
        if not destination.exists():
            destination.mkdir()
            with tarfile.open(archive) as bundle:
                bundle.extractall(destination, filter="data")
        roots = [p for p in destination.iterdir() if p.is_dir()]
        if len(roots) != 1:
            raise RuntimeError(f"Unexpected source layout: {destination}")
        return roots[0]

    try:
        nasm = shutil.which("nasm", path=env["PATH"])
        if not nasm:
            package = source("nasm")
            run("Configuring nasm…", [package / "configure", f"--prefix={prefix}"], package)
            run("Building nasm…", ["make", f"-j{args.jobs}"], package)
            run("Installing nasm…", ["make", "install"], package)
            nasm = str(prefix / "bin/nasm")
        pkg_config = shutil.which("pkg-config") or shutil.which("pkgconf")
        if not pkg_config:
            pkg_config = str(prefix / "bin/pkgconf")
            if not Path(pkg_config).exists():
                package = source("pkgconf")
                run("Configuring pkgconf…", [package / "configure", f"--prefix={prefix}", "--disable-shared"], package)
                run("Building pkgconf…", ["make", f"-j{args.jobs}"], package)
                run("Installing pkgconf…", ["make", "install"], package)
        cmake = [shutil.which("cmake")] if shutil.which("cmake") else ["uv", "tool", "run", "--from", "cmake==4.1.0", "cmake"]
        x265 = source("x265")
        x265_build = build / "x265-build"
        run("Configuring x265 4.2 with ENABLE_ALPHA=ON…", [*cmake, "-S", x265 / "source", "-B", x265_build,
            "-DCMAKE_BUILD_TYPE=Release", f"-DCMAKE_INSTALL_PREFIX={prefix}",
            "-DENABLE_ALPHA=ON", "-DENABLE_SHARED=OFF", "-DENABLE_CLI=OFF", "-DENABLE_LIBNUMA=OFF",
            "-DENABLE_ASSEMBLY=ON", f"-DNASM_EXECUTABLE={nasm}"])
        run("Building x265…", [*cmake, "--build", x265_build, "--parallel", args.jobs])
        run("Installing x265…", [*cmake, "--install", x265_build])
        ffmpeg = source("ffmpeg")
        ffmpeg_build = build / "ffmpeg-build"
        ffmpeg_build.mkdir(exist_ok=True)
        run("Configuring FFmpeg 8.1…", [ffmpeg / "configure", f"--prefix={prefix}",
            "--disable-everything", "--disable-autodetect", "--disable-doc", "--disable-debug", "--disable-network",
            "--disable-ffplay", "--enable-gpl", "--enable-libx265", "--enable-pthreads",
            "--enable-encoder=libx265,rawvideo", "--enable-decoder=rawvideo,hevc", "--enable-parser=hevc",
            "--enable-demuxer=rawvideo,mov", "--enable-muxer=mov,mp4,rawvideo,null",
            "--enable-protocol=file,pipe", "--enable-filter=buffer,buffersink,format,scale",
            "--enable-bsf=hevc_mp4toannexb,extract_extradata", f"--pkg-config={pkg_config}", "--pkg-config-flags=--static",
            f"--extra-cflags=-I{prefix / 'include'}", f"--extra-ldflags=-L{prefix / 'lib'}"], ffmpeg_build)
        run("Building FFmpeg…", ["make", f"-j{args.jobs}"], ffmpeg_build)
        run("Installing FFmpeg…", ["make", "install"], ffmpeg_build)
        # Validate actual RGBA round-trip, not merely an advertised pixel format.
        capability = probe_hevc_alpha(str(prefix / "bin/ffmpeg"))
        if not capability["available"]:
            raise RuntimeError(capability["reason"])
        metadata.write_text(json.dumps(versions))
        print(f"HEVC Alpha ready: {prefix / 'bin/ffmpeg'}", flush=True)
    except Exception:
        if log_path.exists():
            print(log_path.read_text(errors="replace")[-5000:], file=sys.stderr)
        print(f"Build log: {log_path}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()

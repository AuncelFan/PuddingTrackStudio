"""Detect HEVC auxiliary Alpha support by encoding and decoding real pixels."""
from __future__ import annotations

from functools import lru_cache
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def probe_hevc_alpha(executable: str) -> dict:
    try:
        path = Path(shutil.which(executable) or executable).resolve()
        stat = path.stat()
    except OSError:
        return {"available": False, "reason": "HEVC Alpha 编码器不存在。"}
    return dict(_probe(str(path), stat.st_mtime_ns, stat.st_size))


@lru_cache(maxsize=8)
def _probe(executable: str, modified: int, size: int) -> dict:
    # Four large blocks avoid chroma subsampling artefacts at the sample points.
    colours = [(144, 216, 188, 0), (144, 216, 188, 128),
               (144, 216, 188, 255), (144, 216, 188, 64)]
    pixels = bytes(channel for y in range(64) for x in range(64)
                   for channel in colours[(y // 32) * 2 + x // 32])
    try:
        with tempfile.TemporaryDirectory(prefix="trace-hevc-probe-") as directory:
            movie = str(Path(directory) / "alpha.mov")
            subprocess.run([
                executable, "-y", "-v", "error", "-f", "rawvideo", "-pixel_format", "rgba",
                "-video_size", "64x64", "-framerate", "1", "-i", "pipe:0", "-an",
                "-vf", "scale=iw:ih:flags=accurate_rnd+bitexact,format=yuva420p",
                "-c:v", "libx265", "-preset", "fast", "-crf", "18",
                "-pix_fmt", "+yuva420p", "-x265-params", "pools=2:frame-threads=1:log-level=error",
                "-tag:v", "hvc1", "-movflags", "+faststart", "-threads", "2", movie,
            ], input=pixels, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=True)
            decoded = subprocess.run([
                executable, "-v", "error", "-i", movie, "-frames:v", "1",
                "-sws_flags", "accurate_rnd+bitexact",
                "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=15, check=True).stdout
            if len(decoded) != len(pixels):
                raise ValueError("HEVC 解码帧尺寸异常。")
            samples = []
            for (x, y), expected in zip([(16, 16), (48, 16), (16, 48), (48, 48)], colours):
                offset = (y * 64 + x) * 4
                actual = tuple(decoded[offset:offset + 4])
                samples.append(actual[3])
                if abs(actual[3] - expected[3]) > 6:
                    raise ValueError(f"HEVC Alpha 往返验证失败（期望 {expected[3]}，实际 {actual[3]}）。")
                if expected[3] and any(abs(a - b) > 12 for a, b in zip(actual[:3], expected[:3])):
                    raise ValueError("HEVC 半透明颜色往返验证失败。")
        return {"available": True, "reason": None, "ffmpeg": executable, "verifiedAlpha": samples}
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode(errors="replace")[-800:].strip()
        return {"available": False, "reason": f"编码器不支持经验证的 HEVC Alpha：{detail}"}
    except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
        return {"available": False, "reason": f"HEVC Alpha 验证失败：{exc}"}


def hevc_alpha_capability() -> dict:
    # An explicit override must pass verification; never silently replace it.
    if override := os.environ.get("TRACE_HEVC_FFMPEG_PATH"):
        return probe_hevc_alpha(override)
    candidates = [ROOT / ".tools/hevc-alpha/bin/ffmpeg"]
    if configured := os.environ.get("FFMPEG_PATH"):
        candidates.append(Path(shutil.which(configured) or configured))
    if system := shutil.which("ffmpeg"):
        candidates.append(Path(system))
    failure = None
    for candidate in candidates:
        if candidate.is_file():
            capability = probe_hevc_alpha(str(candidate))
            if capability["available"]:
                return capability
            failure = failure or capability
    if failure:
        return {"available": False, "reason": failure["reason"] + " 请运行 npm run setup:hevc-alpha 安装兼容编码器，然后刷新页面。"}
    return {"available": False, "reason": "HEVC Alpha 尚未安装，请运行 npm run setup:hevc-alpha，然后刷新页面。"}

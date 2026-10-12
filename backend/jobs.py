from __future__ import annotations

import json
import logging
import os
import signal
import shutil
import subprocess
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import imageio_ffmpeg

from .hevc import hevc_alpha_capability

ROOT = Path(__file__).resolve().parents[1]
DATA = Path(os.environ.get("TRACE_DATA_DIR", ROOT / ".data")).resolve()
LOGGER = logging.getLogger(__name__)


def write_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(path)


def ffmpeg_path():
    return os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg") or imageio_ffmpeg.get_ffmpeg_exe()


def stop_process(process):
    """Stop the Node renderer and the FFmpeg child it owns."""
    if process is None or process.poll() is not None:
        return
    try:
        # render.mjs starts FFmpeg, so killing only Node can leave the encoder
        # holding the pipe and keep the single render worker occupied forever.
        os.killpg(process.pid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        process.terminate()
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            process.kill()
        process.wait(timeout=2)


class JobManager:
    def __init__(self):
        self.directory = DATA / "jobs"
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.jobs = {}
        self.processes = {}
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="video-render")
        for status_file in self.directory.glob("*/status.json"):
            try:
                job = json.loads(status_file.read_text())
                if job["status"] in ("queued", "running"):
                    job.update(status="failed", stage="failed", error="服务重启中断了任务，请重新导出。")
                    write_json(status_file, job)
                self.jobs[job["id"]] = job
            except (OSError, ValueError, KeyError):
                LOGGER.warning("Cannot restore job %s", status_file)

    def persist(self, job):
        job["updatedAt"] = time.time()
        write_json(self.directory / job["id"] / "status.json", job)

    def create(self, manifest):
        output_format = manifest["config"]["format"]
        executable = ffmpeg_path()
        if output_format == "hevc-alpha":
            capability = hevc_alpha_capability()
            if not capability["available"]:
                raise RuntimeError(capability["reason"])
            executable = capability["ffmpeg"]
        with self.lock:
            if sum(job["status"] in ("queued", "running") for job in self.jobs.values()) >= 3:
                raise ValueError("已有 3 个待处理任务，请等待完成或取消后再导出。")
            job_id = str(uuid.uuid4())
            directory = self.directory / job_id
            directory.mkdir()
            extension = "mov" if output_format == "hevc-alpha" else output_format
            output = directory / f"minimap.{extension}"
            job = {"id": job_id, "status": "queued", "stage": "queued", "progress": 0,
                   "createdAt": time.time(), "renderedFrames": 0,
                   "frameCount": manifest["plan"]["frameCount"], "format": extension,
                   "encoding": output_format,
                   "videoDurationSeconds": manifest["plan"]["videoDurationSeconds"],
                   "width": manifest["config"]["width"], "height": manifest["config"]["height"],
                   "fps": manifest["plan"]["fps"], "error": None}
            self.jobs[job_id] = job
            self.persist(job)
            manifest.update(output=str(output), ffmpeg=executable)
            write_json(directory / "input.json", manifest)
            self.executor.submit(self.run, job_id)
            return dict(job)

    def get(self, job_id):
        with self.lock:
            return dict(self.jobs[job_id])

    def cancel(self, job_id):
        with self.lock:
            job = self.jobs[job_id]
            if job["status"] in ("queued", "running"):
                job.update(status="cancelled", stage="cancelled")
                self.persist(job)
                if process := self.processes.get(job_id):
                    stop_process(process)
            return dict(job)

    def run(self, job_id):
        directory = self.directory / job_id
        log_path = directory / "render.log"
        process = None
        try:
            with self.lock:
                job = self.jobs[job_id]
                if job["status"] == "cancelled":
                    return
                job.update(status="running", stage="starting")
                self.persist(job)
                with log_path.open("w") as log:
                    process = subprocess.Popen(
                        ["node", str(ROOT / "scripts/render.mjs"), str(directory / "input.json")],
                        cwd=ROOT, stdout=subprocess.PIPE, stderr=log, text=True, encoding="utf-8",
                        start_new_session=True,
                    )
                self.processes[job_id] = process
                if job["status"] == "cancelled":
                    stop_process(process)
                    return
            for line in process.stdout:
                try:
                    update = json.loads(line)
                except ValueError:
                    continue
                with self.lock:
                    if job["status"] == "cancelled":
                        continue
                    if update.get("stage") == "failed":
                        job.update(error=update.get("error", "渲染失败"))
                    # Completion is published only after the encoder process exits successfully.
                    job.update({key: value for key, value in update.items() if key in ("progress", "stage", "renderedFrames")})
                    self.persist(job)
            code = process.wait()
            with self.lock:
                if job["status"] != "cancelled":
                    output = directory / f"minimap.{job['format']}"
                    if code == 0 and output.exists() and output.stat().st_size > 0:
                        job.update(status="done", stage="done", progress=1, sizeBytes=output.stat().st_size,
                                   downloadUrl=f"/api/exports/{job_id}/download")
                    else:
                        detail = log_path.read_text(errors="replace")[-1500:] if log_path.exists() else ""
                        job.update(status="failed", stage="failed", error=job["error"] or detail or f"渲染进程异常退出 ({code})")
                self.persist(job)
        except Exception as exc:
            LOGGER.exception("Export failed: %s", job_id)
            stop_process(process)
            with self.lock:
                job = self.jobs[job_id]
                if job["status"] != "cancelled":
                    job.update(status="failed", stage="failed", error=str(exc))
                    self.persist(job)
        finally:
            with self.lock:
                self.processes.pop(job_id, None)
            # Raw points/frames are already persisted with the track. Avoid retaining huge manifests.
            (directory / "input.json").unlink(missing_ok=True)
            if self.jobs[job_id]["status"] != "done":
                (directory / f"minimap.{self.jobs[job_id]['format']}").unlink(missing_ok=True)

    def close(self):
        with self.lock:
            for job_id in list(self.processes):
                self.cancel(job_id)
        self.executor.shutdown(wait=True, cancel_futures=True)

from __future__ import annotations

import asyncio
import json
import os
import re
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .jobs import DATA, ROOT, JobManager, ffmpeg_path, write_json
from .hevc import hevc_alpha_capability
from .models import ExportRequest, PlanRequest
from .track import TrackError, make_plan, parse_kml

TRACKS = DATA / "tracks"
TILES = DATA / "tiles"
MAX_UPLOAD = 20 * 1024 * 1024
DEMO = ROOT / "examples/West Lake Loop.kml"


@asynccontextmanager
async def lifespan(app):
    TRACKS.mkdir(parents=True, exist_ok=True)
    TILES.mkdir(parents=True, exist_ok=True)
    app.state.jobs = JobManager()
    app.state.tile_semaphore = asyncio.Semaphore(4)
    app.state.tile_locks = {}
    app.state.http = httpx.AsyncClient(timeout=20, follow_redirects=True, headers={
        "User-Agent": "PuddingTrackStudio/0.1 (https://github.com/AuncelFan/PuddingTrackStudio)",
        "Referer": "https://www.openstreetmap.org/",
    })
    yield
    await app.state.http.aclose()
    await run_in_threadpool(app.state.jobs.close)


app = FastAPI(title="PuddingTrackStudio", version="0.1.0", lifespan=lifespan)


@app.exception_handler(TrackError)
async def track_error(request, exc):
    return JSONResponse(status_code=422, content={"detail": str(exc), "code": exc.code})


def get_track(track_id):
    if not re.fullmatch(r"[a-f0-9-]{36}", track_id):
        raise HTTPException(404, "轨迹不存在。")
    path = TRACKS / f"{track_id}.json"
    if not path.exists():
        raise HTTPException(404, "轨迹不存在，请重新导入。")
    return json.loads(path.read_text(encoding="utf-8"))


def save_tracks(contents, filename, duration=None):
    tracks = parse_kml(contents, filename, duration)
    for track in tracks:
        track["id"] = str(uuid.uuid4())
        track["filename"] = filename
        write_json(TRACKS / f"{track['id']}.json", track)
    return {"tracks": tracks}


@app.get("/api/health")
async def health():
    return {"status": "ok", "ffmpeg": Path(ffmpeg_path()).name,
            "renderer": "shared Canvas 2D / Skia", "maxFrames": 216000,
            "hevcAlpha": await run_in_threadpool(hevc_alpha_capability)}


@app.post("/api/tracks")
async def upload_track(file: UploadFile = File(), duration_seconds: float | None = Form(default=None)):
    if not (file.filename or "").lower().endswith(".kml"):
        raise HTTPException(422, "请选择 .kml 文件。")
    try:
        contents = await file.read(MAX_UPLOAD + 1)
    finally:
        await file.close()
    if len(contents) > MAX_UPLOAD:
        raise HTTPException(413, "文件超过 20 MB。")
    return await run_in_threadpool(save_tracks, contents, file.filename, duration_seconds)


@app.post("/api/demo")
async def demo():
    return await run_in_threadpool(save_tracks, DEMO.read_bytes(), DEMO.name)


@app.get("/api/tracks/{track_id}")
async def read_track(track_id: str):
    return await run_in_threadpool(get_track, track_id)


@app.post("/api/tracks/{track_id}/plan")
async def plan(track_id: str, body: PlanRequest):
    track = await run_in_threadpool(get_track, track_id)
    return await run_in_threadpool(make_plan, track, **body.model_dump())


@app.post("/api/exports", status_code=202)
async def export(body: ExportRequest, request: Request):
    if body.config.format == "hevc-alpha":
        capability = await run_in_threadpool(hevc_alpha_capability)
        if not capability["available"]:
            raise HTTPException(503, capability["reason"])
    track = await run_in_threadpool(get_track, body.trackId)
    frame_plan = await run_in_threadpool(make_plan, track, **body.plan.model_dump())
    # Renderer only contacts this local service, never an arbitrary user supplied URL.
    port = request.url.port or (443 if request.url.scheme == "https" else 80)
    origin = os.environ.get("TRACE_RENDER_ORIGIN", f"http://127.0.0.1:{port}")
    try:
        return await run_in_threadpool(request.app.state.jobs.create, {
            "track": track, "plan": frame_plan, "config": body.config.model_dump(),
            "camera": body.camera.model_dump(), "origin": origin,
        })
    except ValueError as exc:
        raise HTTPException(429, str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(503, str(exc)) from exc


def job_or_404(manager, job_id):
    try:
        return manager.get(job_id)
    except KeyError as exc:
        raise HTTPException(404, "导出任务不存在。") from exc


@app.get("/api/exports/{job_id}")
async def job_status(job_id: str, request: Request):
    return job_or_404(request.app.state.jobs, job_id)


@app.delete("/api/exports/{job_id}")
async def cancel_job(job_id: str, request: Request):
    job_or_404(request.app.state.jobs, job_id)
    return request.app.state.jobs.cancel(job_id)


@app.get("/api/exports/{job_id}/download")
async def download(job_id: str, request: Request):
    job = job_or_404(request.app.state.jobs, job_id)
    if job["status"] != "done":
        raise HTTPException(409, "视频尚未完成。")
    path = request.app.state.jobs.directory / job_id / f"minimap.{job['format']}"
    if not path.exists():
        raise HTTPException(410, "视频文件已被清理，请重新导出。")
    media = {"mp4": "video/mp4", "webm": "video/webm", "mov": "video/quicktime"}[job["format"]]
    return FileResponse(path, media_type=media, filename=f"trace-{job['width']}x{job['height']}-{job['fps']}fps.{job['format']}")


@app.get("/api/tiles/{provider}/{z}/{x}/{y}.png")
async def tile(provider: str, z: int, x: int, y: int, request: Request):
    if provider not in ("osm", "gaode") or not 0 <= z <= 18 or not (0 <= x < 2 ** z and 0 <= y < 2 ** z):
        raise HTTPException(422, "无效地图瓦片。")
    path = TILES / provider / str(z) / str(x) / f"{y}.png"
    if path.exists():
        return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=604800"})
    key = f"{provider}/{z}/{x}/{y}"
    locks = request.app.state.tile_locks
    lock = locks.setdefault(key, asyncio.Lock())
    async with lock:
        if path.exists():
            return FileResponse(path, media_type="image/png", headers={"Cache-Control": "public, max-age=604800"})
        url = (f"https://tile.openstreetmap.org/{z}/{x}/{y}.png" if provider == "osm" else
               f"https://webrd01.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=7&x={x}&y={y}&z={z}")
        async with request.app.state.tile_semaphore:
            try:
                response = await request.app.state.http.get(url)
                response.raise_for_status()
                if not response.content.startswith((b"\x89PNG", b"\xff\xd8")):
                    raise ValueError("Not a tile image")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(response.content)
            except (httpx.HTTPError, ValueError) as exc:
                raise HTTPException(502, "地图服务不可用；可检查代理或使用离线坐标网格。") from exc
    return Response(response.content, media_type="image/png", headers={"Cache-Control": "public, max-age=604800"})


if (ROOT / "dist").exists():
    app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="frontend")

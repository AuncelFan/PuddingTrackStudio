from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class PlanRequest(StrictModel):
    speed: float = Field(default=60, ge=0.01, le=3600)
    fps: int = Field(default=30, ge=1, le=120)
    start: float = Field(default=0, ge=0)
    end: float | None = Field(default=None, gt=0)


class SceneConfig(StrictModel):
    mode: Literal["map", "geometry"] = "map"
    basemap: Literal["grid", "osm", "gaode"] = "grid"
    format: Literal["mp4", "webm", "mov", "hevc-alpha"] = "mp4"
    width: int = Field(default=640, ge=32, le=3840)
    height: int = Field(default=640, ge=32, le=3840)
    routeColor: str = Field(default="#91e2bc", pattern=r"^#[0-9a-fA-F]{6}$")
    trailColor: str = Field(default="#ffbc7a", pattern=r"^#[0-9a-fA-F]{6}$")
    markerColor: str = Field(default="#ffbc7a", pattern=r"^#[0-9a-fA-F]{6}$")
    markerStyle: Literal["dot", "ring", "arrow", "pin", "crosshair"] = "dot"
    backgroundColor: str = Field(default="#15232c", pattern=r"^#[0-9a-fA-F]{6}$")
    routeOpacity: float = Field(default=0.85, ge=0.05, le=1)
    backgroundOpacity: float = Field(default=1, ge=0, le=1)
    # Sizes use the renderer's 640 px reference canvas. These bounds keep
    # line width and marker diameter within the shorter canvas edge.
    lineWidth: float = Field(default=4, ge=1, le=640)
    markerSize: float = Field(default=7, ge=2, le=320)
    showGrid: bool = True
    showTrail: bool = False
    showEndpoints: bool = True
    showHud: bool = False
    glow: bool = True

    @model_validator(mode="after")
    def valid_output(self):
        if self.width * self.height > 3840 * 2160:
            raise ValueError("总像素数不能超过 3840 × 2160。")
        if self.format in ("mp4", "webm", "hevc-alpha") and (self.width % 2 or self.height % 2):
            raise ValueError("MP4 / WebM / HEVC Alpha 的宽高须为偶数。")
        if self.format == "mp4" and self.mode == "geometry" and self.backgroundOpacity < 1:
            raise ValueError("H.264 MP4 不含透明通道；请选 WebM / MOV 或将背景不透明度设为 100%。")
        return self


class Camera(StrictModel):
    center: tuple[float, float]
    span: float = Field(ge=20, le=80150034)

    @model_validator(mode="after")
    def valid_center(self):
        if abs(self.center[0]) > 120225051 or abs(self.center[1]) > 20037509:
            raise ValueError("地图中心超出可显示范围。")
        return self


class ExportRequest(StrictModel):
    trackId: str = Field(pattern=r"^[0-9a-f-]{36}$")
    plan: PlanRequest = Field(default_factory=PlanRequest)
    config: SceneConfig = Field(default_factory=SceneConfig)
    camera: Camera

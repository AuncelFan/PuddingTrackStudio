"""KML/GPX parsing and time resampling. No smoothing or distance resampling."""
from __future__ import annotations

import math
import re
from bisect import bisect_right
from datetime import datetime, timezone
from itertools import combinations, groupby
from pathlib import Path

from defusedxml import ElementTree as ET

MAX_POINTS = 300_000
MAX_FRAMES = 216_000
DUPLICATE_DISTANCE_METERS = 10.0


class TrackError(ValueError):
    def __init__(self, message: str, code: str = "invalid_kml"):
        super().__init__(message)
        self.code = code


def tag(element):
    return element.tag.rsplit("}", 1)[-1]


def children(element, name):
    return [child for child in element if tag(child) == name]


def first_text(element, name, default=""):
    return next(((child.text or "").strip() for child in element.iter() if tag(child) == name), default)


def direct_text(element, name, default=""):
    """Read a direct child without accidentally selecting a nested Placemark."""
    return next(((child.text or "").strip() for child in element if tag(child) == name), default)


def timestamp(text: str) -> float:
    try:
        value = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
        if value.tzinfo is None:
            raise ValueError("timezone missing")
        return value.timestamp()
    except (ValueError, OverflowError) as exc:
        raise TrackError(f"无效时间 {text!r}；时间须包含时区（如 Z 或 +08:00）。") from exc


def coordinate(text: str, gx=False):
    try:
        cleaned = text.strip()
        # KML Point exports commonly use either `lon,lat[,alt]` or
        # `lon lat [alt]`; gx:coord always uses whitespace.
        values = (
            [float(v) for v in cleaned.split() if v]
            if gx or "," not in cleaned
            else [float(v) for v in cleaned.split(",") if v]
        )
        if len(values) not in (2, 3):
            raise ValueError()
        lon, lat = values[:2]
        altitude = values[2] if len(values) == 3 else 0.0
        if not all(math.isfinite(v) for v in (lon, lat, altitude)) or not -180 <= lon <= 180 or not -90 <= lat <= 90:
            raise ValueError()
        return [lon, lat, altitude]
    except (ValueError, TypeError) as exc:
        raise TrackError(f"无效坐标：{text[:90]!r}") from exc


def _plain_description(text):
    # COROS writes its lap metadata as escaped HTML inside <description>.
    return " ".join(re.sub(r"<[^>]*>", " ", text or "").split())


def _coros_seconds(placemark):
    """Return the numeric COROS lap/activity duration in seconds, if present."""
    description = _plain_description(first_text(placemark, "description"))
    match = re.search(r"\bTime\s*:\s*([0-9]+(?:\.[0-9]+)?)\b", description, re.I)
    return float(match.group(1)) if match else None


def _coros_timed_track(root, parent, track_name):
    """Decode COROS's LineString + Laps export.

    COROS does not emit a timestamp for every coordinate. It emits a single
    MultiGeometry route, lap start placemarks, and each lap's elapsed seconds.
    We map those lap boundaries onto the route and interpolate within each lap.
    Returning None means the document is not this format and should use the
    regular LineString fallback.
    """
    placemarks = [element for element in root.iter() if tag(element) == "Placemark"]
    route_placemark = next(
        (
            element
            for element in placemarks
            if direct_text(element, "name").strip().lower() == "track"
            and any(tag(child) == "LineString" for child in element.iter())
        ),
        None,
    )
    laps_folder = next(
        (
            element
            for element in root.iter()
            if tag(element) == "Folder" and direct_text(element, "name").strip().lower() == "laps"
        ),
        None,
    )
    if route_placemark is None or laps_folder is None:
        return None

    # COROS splits one recorded route into many geometry chunks. Their order is
    # the recorded route order, so join chunks for distance interpolation; the
    # lap markers provide the timing anchors.
    route = []
    distance = 0.0
    lines = [element for element in route_placemark.iter() if tag(element) == "LineString"]
    for line_index, line in enumerate(lines):
        text = first_text(line, "coordinates")
        if not text:
            continue
        for point_index, value in enumerate(text.split()):
            point = coordinate(value)
            if route:
                distance += haversine(route[-1][0], point)
            # A tiny deterministic tie-breaker keeps distinct points in a
            # zero-length/geometry boundary strictly ordered in time.
            progress = distance + len(route) * 1e-6
            # COROS splits one recorded route into many LineStrings, including
            # one-point fragments. They are geometry chunks, not independent
            # timed tracks, so only the first coordinate starts the route.
            route.append((point, progress, line_index == 0 and point_index == 0, len(route)))
    if len(route) < 2:
        return None

    lap_rows = []
    start_row = end_row = None
    for placemark in laps_folder.iter():
        if tag(placemark) != "Placemark":
            continue
        name = direct_text(placemark, "name").strip()
        point = next((element for element in placemark.iter() if tag(element) == "Point"), None)
        coordinate_text = first_text(point, "coordinates") if point is not None else ""
        if not coordinate_text:
            continue
        try:
            position = coordinate(coordinate_text)
        except TrackError:
            continue
        lower_name = name.lower()
        if lower_name == "start":
            start_row = (position, _coros_seconds(placemark))
        elif lower_name == "end":
            end_row = (position, _coros_seconds(placemark))
        else:
            match = re.fullmatch(r"lap\s*(\d+)", lower_name)
            seconds = _coros_seconds(placemark)
            if match and seconds is not None:
                lap_rows.append((int(match.group(1)), position, seconds))
    lap_rows.sort(key=lambda row: row[0])
    if not lap_rows or any(row[0] != i + 1 for i, row in enumerate(lap_rows)):
        return None
    if start_row is None:
        start_row = (lap_rows[0][1], None)

    def nearest(position, lower_bound=0):
        # Lap markers are monotonic along this export. Restricting the search
        # prevents a loop from matching an earlier visually close coordinate.
        return min(
            range(lower_bound, len(route)),
            key=lambda index: haversine(route[index][0], position),
        )

    boundaries = []
    cursor = 0
    start_index = nearest(start_row[0])
    boundaries.append((start_index, 0.0))
    cursor = start_index
    elapsed = 0.0
    for lap_number, position, seconds in lap_rows:
        index = nearest(position, cursor)
        if index < cursor:
            return None
        # Lap N's marker denotes the beginning of lap N; its duration is the
        # interval to the next marker (or to End for the final lap).
        boundaries.append((index, elapsed))
        elapsed += seconds
        cursor = index
    end_index = nearest(end_row[0], cursor) if end_row is not None else len(route) - 1
    if end_index < boundaries[-1][0]:
        return None
    activity_total = end_row[1] if end_row is not None and end_row[1] is not None else elapsed
    if activity_total <= 0:
        return None
    lap_total = elapsed
    # COROS rounds lap durations independently. If the activity summary is
    # shorter than their sum, preserve all lap intervals and report the
    # discrepancy rather than silently dropping the tail of the route.
    activity_total = max(activity_total, lap_total)
    boundaries.append((end_index, activity_total))

    # Collapse duplicate boundary indices while retaining the latest time;
    # Lap 1 and Start intentionally point to the same coordinate.
    collapsed = []
    for index, time in boundaries:
        if collapsed and index == collapsed[-1][0]:
            collapsed[-1] = (index, time)
        else:
            collapsed.append((index, time))
    if len(collapsed) < 2:
        return None

    times = [None] * len(route)
    for (left_index, left_time), (right_index, right_time) in zip(collapsed, collapsed[1:]):
        if right_index < left_index or right_time < left_time:
            return None
        left_progress, right_progress = route[left_index][1], route[right_index][1]
        span = right_progress - left_progress
        for index in range(left_index, right_index + 1):
            ratio = (route[index][1] - left_progress) / span if span > 0 else 0.0
            times[index] = left_time + (right_time - left_time) * max(0.0, min(1.0, ratio))
    for index in range(collapsed[0][0]):
        times[index] = collapsed[0][1]
    for index in range(collapsed[-1][0] + 1, len(route)):
        times[index] = collapsed[-1][1]
    if any(value is None for value in times) or any(b < a for a, b in zip(times, times[1:])):
        return None

    raw = []
    for (point, _progress, segment_start, _), time in zip(route, times):
        raw.append([*point, time, segment_start])
    track = normalize(track_name(route_placemark), raw, "COROS Laps（分段时间）")
    # The file has reliable elapsed lap durations, but not a timestamp per GPS
    # sample. Keep it as a timed track while exposing that distinction to the UI.
    track["timingDerived"] = True
    track["startTime"] = None
    track["endTime"] = None
    track["warnings"].insert(0, "检测到 COROS Laps：原文件没有逐点时间，已按分段时长和路线里程插值；停留只能在分段范围内近似。")
    if end_row is not None and end_row[1] is not None and abs(end_row[1] - lap_total) > 1e-6:
        if end_row[1] >= lap_total:
            track["warnings"].append(f"COROS 活动总时长与各 Lap 之和相差 {end_row[1] - lap_total:g} 秒，已以活动总时长作为终点。")
        else:
            track["warnings"].append(f"COROS 各 Lap 之和比活动总时长多 {lap_total - end_row[1]:g} 秒，已保留全部 Lap 时间。")
    return track


def haversine(a, b):
    lat1, lat2 = math.radians(a[1]), math.radians(b[1])
    dlat = lat2 - lat1
    dlon = math.radians(b[0] - a[0])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 6_371_008.8 * 2 * math.asin(min(1, math.sqrt(h)))


def normalize(name, raw, source, duration=None):
    """points: [longitude, latitude, altitude, UTC seconds, cumulative meters, segment start]."""
    if len(raw) < 2:
        raise TrackError("轨迹至少需要两个有效点。")
    if len(raw) > MAX_POINTS:
        raise TrackError(f"单条轨迹最多支持 {MAX_POINTS:,} 个原始点。")
    warnings = []
    synthetic = all(point[3] is None for point in raw)
    if not synthetic and any(point[3] is None for point in raw):
        raise TrackError("轨迹中部分点缺少时间，不能可靠地按时间回放。")
    if synthetic:
        if duration is None:
            raise TrackError("该轨迹不含逐点时间；请填写实际总时长后重新导入。推算模式会按距离匀速播放。", "missing_time")
        if not math.isfinite(duration) or duration <= 0 or duration > 604800:
            raise TrackError("推算总时长须大于 0 且不超过 604800 秒。")
        warnings.append("原文件没有逐点时间；当前时间按总时长和距离匀速推算，并非真实记录时间。")
    else:
        # Preserve segment boundaries; sort only within each original segment.
        segments = []
        for point in raw:
            if not segments or point[4]:
                segments.append([])
            segments[-1].append(point)
        for segment in segments:
            if any(segment[i][3] < segment[i - 1][3] for i in range(1, len(segment))):
                warnings.append("段内时间乱序，已按时间排序。")
            segment.sort(key=lambda point: point[3])
        segments.sort(key=lambda segment: segment[0][3])
        raw = []
        for segment in segments:
            for i, point in enumerate(segment):
                raw.append([*point[:4], i == 0])
        deduped = []
        merged_groups = removed_points = 0
        for _, same_time in groupby(raw, key=lambda point: point[3]):
            same_time = list(same_time)
            if deduped and same_time[0][3] < deduped[-1][3]:
                raise TrackError("多个轨迹段的时间相互重叠；请拆成独立轨迹后导入。")
            if len(same_time) > 1:
                # Check the entire group, not just successive points: a chain
                # of small steps must not merge positions over 10 m apart.
                positions = list(dict.fromkeys((point[0], point[1]) for point in same_time))
                if any(haversine(a, b) > DUPLICATE_DISTANCE_METERS for a, b in combinations(positions, 2)):
                    raise TrackError("同一时间的轨迹点水平距离超过 10 米，无法唯一插值；请修正时间或拆分轨迹。")
                merged_groups += 1
                removed_points += len(same_time) - 1
            # Keep the last recorded position/altitude, carrying any segment
            # boundary forward so duplicate points cannot connect two segments.
            point = [*same_time[-1][:4], any(point[4] for point in same_time)]
            deduped.append(point)
        if merged_groups:
            warnings.append(f"已合并 {merged_groups} 组同一时间且水平位置差异不超过 10 米的轨迹点，减少 {removed_points} 点；每组保留最后一个点。")
        raw = deduped
        if len(raw) < 2 or raw[-1][3] <= raw[0][3]:
            raise TrackError("轨迹需要至少两个不同的时间。")
    points = []
    distance = 0.0
    for i, point in enumerate(raw):
        lon, lat, alt, time, segment_start = point
        if points:
            # Keep a route crossing the date line local and interpolate the shortest longitude arc.
            lon += round((points[-1][0] - lon) / 360) * 360
            if not segment_start:
                distance += haversine(points[-1], [lon, lat])
        points.append([lon, lat, alt, time, distance, bool(i == 0 or segment_start)])
    if synthetic:
        for i, point in enumerate(points):
            point[3] = duration * (point[4] / distance if distance else i / (len(points) - 1))
        # Zero length edges can create equal timestamps; retain the later identical position.
        points = [p for i, p in enumerate(points) if i == len(points) - 1 or p[3] != points[i + 1][3]]
        if len(points) < 2:
            raise TrackError("轨迹没有可用的时间范围。")
    if any(abs(point[1]) > 85.05112878 for point in points):
        warnings.append("部分纬度超出 Web Mercator 范围，显示时会裁到 ±85.0511°。")
    segment_count = sum(point[5] for point in points)
    if segment_count > 1:
        warnings.append("多段轨迹不连线；段间时间空白保持在上一段终点，到新段起点时跳转。")
    return {
        "name": name or "未命名轨迹", "source": source, "synthetic": synthetic,
        "points": points, "pointCount": len(points), "segmentCount": segment_count,
        "distanceMeters": distance, "durationSeconds": points[-1][3] - points[0][3],
        "startTime": None if synthetic else datetime.fromtimestamp(points[0][3], timezone.utc).isoformat(),
        "endTime": None if synthetic else datetime.fromtimestamp(points[-1][3], timezone.utc).isoformat(),
        "warnings": list(dict.fromkeys(warnings)),
    }


def parse_kml(contents: bytes, filename="track.kml", duration=None):
    try:
        root = ET.fromstring(contents)
    except Exception as exc:
        raise TrackError("无法解析 KML XML（文件损坏或包含不允许的实体）。") from exc
    if tag(root) != "kml":
        raise TrackError("文件根节点必须是 kml。")
    parent = {child: element for element in root.iter() for child in element}

    def track_name(element):
        while element is not None:
            for child in children(element, "name"):
                if child.text and child.text.strip():
                    return child.text.strip()
            element = parent.get(element)
        return Path(filename).stem

    groups = []
    consumed = set()
    for element in root.iter():
        if tag(element) == "MultiTrack":
            tracks = [t for t in element.iter() if tag(t) == "Track"]
            if tracks:
                groups.append((element, tracks))
                consumed.update(tracks)
        elif tag(element) == "Track" and element not in consumed:
            groups.append((element, [element]))
    parsed = []
    for container, tracks in groups:
        raw = []
        for track in tracks:
            coords, whens = children(track, "coord"), children(track, "when")
            if len(coords) != len(whens) or not coords:
                raise TrackError("gx:Track 的 when 和 coord 数量必须相同且非空。")
            for i, (coord, when) in enumerate(zip(coords, whens)):
                raw.append([*coordinate(coord.text or "", gx=True), timestamp(when.text or ""), i == 0])
        parsed.append(normalize(track_name(container), raw, "gx:Track"))
    if parsed:
        return parsed

    coros_track = _coros_timed_track(root, parent, track_name)
    if coros_track is not None:
        return [coros_track]

    point_groups = {}
    track_folders = [el for el in root.iter() if tag(el) == "Folder" and first_text(el, "name").lower() == "track points"]
    search_roots = track_folders or [root]
    for search_root in search_roots:
        for placemark in search_root.iter():
            if tag(placemark) != "Placemark":
                continue
            point = next((el for el in placemark.iter() if tag(el) == "Point"), None)
            if point is None:
                continue
            when = (
                first_text(placemark, "when")
                or first_text(placemark, "begin")
                or first_text(placemark, "time")
            )
            if not when:
                continue
            group = parent.get(placemark, root)
            point_groups.setdefault(group, []).append([*coordinate(first_text(point, "coordinates")), timestamp(when), False])
    for group, raw in point_groups.items():
        if len(raw) >= 2:
            parsed.append(normalize(track_name(group), raw, "TimeStamped Points"))
    if parsed:
        return parsed

    for placemark in [el for el in root.iter() if tag(el) == "Placemark"]:
        raw = []
        for line in placemark.iter():
            if tag(line) == "LineString":
                for i, text in enumerate(first_text(line, "coordinates").split()):
                    raw.append([*coordinate(text), None, i == 0])
        if raw:
            parsed.append(normalize(track_name(placemark), raw, "LineString", duration))
    if not parsed:
        raise TrackError("未找到 gx:Track、带时间的轨迹点或 LineString。")
    return parsed


def parse_gpx(contents: bytes, filename="track.gpx", duration=None):
    try:
        root = ET.fromstring(contents)
    except Exception as exc:
        raise TrackError("无法解析 GPX XML（文件损坏或包含不允许的实体）。", "invalid_gpx") from exc
    if tag(root) != "gpx":
        raise TrackError("文件根节点必须是 gpx。", "invalid_gpx")

    parsed = []
    metadata = next(iter(children(root, "metadata")), None)
    fallback_name = (direct_text(metadata, "name") if metadata is not None else direct_text(root, "name")) or Path(filename).stem
    try:
        for container in root:
            kind = tag(container)
            if kind not in ("trk", "rte"):
                continue
            raw = []
            segments = children(container, "trkseg") if kind == "trk" else [container]
            for segment in segments:
                for i, point in enumerate(children(segment, "trkpt" if kind == "trk" else "rtept")):
                    try:
                        lon, lat = float(point.attrib["lon"]), float(point.attrib["lat"])
                        altitude = float(direct_text(point, "ele", "0"))
                    except (KeyError, ValueError) as exc:
                        raise TrackError("GPX 轨迹点缺少有效的经纬度或海拔。") from exc
                    position = coordinate(f"{lon},{lat},{altitude}")
                    time = direct_text(point, "time")
                    raw.append([*position, timestamp(time) if time else None, i == 0])
            if raw:
                parsed.append(normalize(direct_text(container, "name") or fallback_name, raw, f"GPX {kind}", duration))
        if not parsed:
            raise TrackError("未找到 GPX trk/trkseg/trkpt 或 rte/rtept 路线；独立航点不能作为回放轨迹。")
    except TrackError as exc:
        if exc.code == "invalid_kml":
            exc.code = "invalid_gpx"
        raise
    return parsed


def parse_track(contents: bytes, filename, duration=None):
    """Dispatch uploads by their supported, case-insensitive file extension."""
    extension = Path(filename).suffix.lower()
    if extension == ".gpx":
        return parse_gpx(contents, filename, duration)
    if extension == ".kml":
        return parse_kml(contents, filename, duration)
    raise TrackError("请选择 .kml 或 .gpx 文件。", "unsupported_format")


def make_plan(track, speed=60.0, fps=30, start=0.0, end=None):
    duration = track["durationSeconds"]
    end = duration if end is None else end
    if not all(math.isfinite(value) for value in (speed, fps, start, end)):
        raise TrackError("时间参数须为有限数字。", "invalid_plan")
    if not 0.01 <= speed <= 3600 or not 1 <= fps <= 120 or int(fps) != fps:
        raise TrackError("倍率须为 0.01–3600；帧率须为 1–120 的整数。", "invalid_plan")
    if start < 0 or end > duration + 1e-6 or end <= start:
        raise TrackError("截取范围须满足 0 ≤ 开始 < 结束 ≤ 轨迹总时长。", "invalid_plan")
    count = math.ceil((end - start) * fps / speed) + 1
    if count > MAX_FRAMES:
        raise TrackError(f"超过 {MAX_FRAMES:,} 帧，请提高倍率或缩短截取范围。", "too_many_frames")
    points = track["points"]
    times = [point[3] for point in points]
    origin = times[0]
    frames = []
    index = max(0, bisect_right(times, origin + start) - 1)
    for i in range(count):
        elapsed = min(end, start + i * speed / fps)
        time = origin + elapsed
        while index + 1 < len(points) and points[index + 1][3] <= time:
            index += 1
        a = points[index]
        b = points[min(index + 1, len(points) - 1)]
        ratio = (time - a[3]) / (b[3] - a[3]) if b[3] > a[3] and not b[5] else 0.0
        lon, lat, alt, distance = [a[j] + (b[j] - a[j]) * ratio for j in (0, 1, 2, 4)]
        progress = min(1.0, max(0.0, distance / track["distanceMeters"])) if track["distanceMeters"] > 0 else 0.0
        frames.append([lon, lat, alt, distance, index, elapsed, progress])
    # Metadata is informational. The player consumes only frame indices at fixed FPS.
    return {"frames": frames, "frameCount": count, "fps": fps, "speed": speed,
            "start": start, "end": end, "sourceDurationSeconds": end - start,
            "videoDurationSeconds": count / fps, "sampleStepSeconds": speed / fps}

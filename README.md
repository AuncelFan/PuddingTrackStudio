# PuddingTrackStudio · KML 轨迹影像工作台

项目仓库：[AuncelFan/PuddingTrackStudio](https://github.com/AuncelFan/PuddingTrackStudio)。
使用 [MIT License](LICENSE)。

把含时间的 KML 轨迹生成固定视角的小地图动画，用于第一视角视频的左上角。**镜头保持不动，人物标记按记录时间移动**。前端不插值，也不通过轨迹长度推算真实运动速度。

技术栈参考 [PuddingTrackRater](https://github.com/AuncelFan/PuddingTrackRater)：FastAPI + Vite + OpenLayers + coordtransform。只解析和按时间线性插值，没有评分、聚类、滤波或路线简化。导出采用共享 Canvas 2D 渲染器、Node/Skia 和 FFmpeg。

## 启动

需要 Python 3.11+、[uv](https://docs.astral.sh/uv/)、Node.js 20.19+（推荐 22 LTS）。

```bash
git clone https://github.com/AuncelFan/PuddingTrackStudio.git
cd PuddingTrackStudio
uv sync --dev
npm ci
npm run dev
```

访问 **http://127.0.0.1:5173**。FastAPI 在 http://127.0.0.1:8000，API 文档在 http://127.0.0.1:8000/docs。

FFmpeg 优先使用 `FFMPEG_PATH` 指定的可执行文件，其次是系统 `ffmpeg`，否则自动使用 `imageio-ffmpeg` 包内的二进制。默认无需另外安装 FFmpeg，所用编码器须包括 `libx264`、`libvpx-vp9`、`prores_ks`。

HEVC Alpha 使用独立编码器。在 Linux 上准备 C / C++ 编译器和 `make` 后运行一次：

```bash
npm run setup:hevc-alpha
```

安装脚本下载固定版本并校验 SHA-256，编译启用 `ENABLE_ALPHA=ON` 的 x265 4.2 与 FFmpeg 8.1，安装到 `.tools/hevc-alpha/`。缺少 NASM、pkg-config 或 CMake 时会自动准备这些工具；不会替换系统 FFmpeg。安装结束会实际编码并解码透明 / 半透明色块，验证 Alpha 和颜色。再次运行会检测并复用已安装版本，可用 `npm run setup:hevc-alpha -- --force` 强制重建。安装后刷新页面即可选择 HEVC Alpha；也可用 `TRACE_HEVC_FFMPEG_PATH` 指定其他兼容编码器，它同样必须通过往返验证。Docker 镜像会构建并包含这套编码器。

安装或地图下载遇到网络问题时，先在当前终端执行 `proxy on` 再启动。地图请求经后端缓存，使用其进程环境的代理；离线网格和极简几何不访问地图服务。

生产运行：

```bash
npm run build
npm start
```

访问 **http://127.0.0.1:8000**，后端同时提供前端静态文件。保持一个后端 worker；导出队列保存在当前进程中。不要直接用 Vite preview 提供生产 API。

## 使用

1. 导入 KML，或点击「载入示例」。一份文件含多条独立轨迹时，可以选择其中一条。
2. 选择「地图轨迹」或「极简几何」。地图可选离线坐标网格、OpenStreetMap 或高德；高德底图自动将 WGS84 轨迹转为 GCJ-02。
3. 点击「视角已锁定」解锁，拖动、滚轮缩放，或点击「显示完整轨迹」。满意后锁定。开始播放和导出也会自动锁定当前视角，取消尚未完成的缩放动画。
4. 设置倍率（快捷按钮 **30× / 60× / 120× / 240×**，默认 **60×**）、FPS（默认 **30**）、分辨率（默认 **640 × 640**）。支持自定义尺寸、1–120 FPS、0.01–3600×，以及按轨迹经过秒数截取。
5. 设置轨迹 / 标记 / 背景颜色、线宽、不透明度和标记大小。标记可选圆点、空心环、方向箭头、定位针或准星；已走路径可以单独指定颜色。数值框可直接输入，点击侧面的增减按钮，或按住按钮上下拖拽；Shift 加快，Alt 放慢。线宽与标记大小最多为画布短边像素数，尺寸随画布等比缩放。
6. 点击右栏「视频导出设置」，在弹窗中选择分辨率、FPS 与格式，参考预估大小后导出。右栏显示渲染状态、取消与完成后的下载按钮。大小范围随最终帧数、分辨率和格式变化，是经验估算；实际大小以结果为准。导出使用点击时的配置快照，之后调整预览不会改变已经提交的任务。

默认关闭「已走路线高亮」和 HUD，动画里仅移动标记发生变化，整个底图和路线均保持静止。也可按需要打开高亮或 HUD。播放支持空格快捷键（焦点不在输入框或按钮上时）。

里程进度 HUD 仅显示进度百分比与已走里程。后端按累计距离 / 整条轨迹总距离计算每帧进度，停留和段间空白不增加进度；截取片段保留它在完整路线中的进度。HUD 不显示时间和倍率，时间仍可在预览播放条查看。

地图视角、输出设置和当前轨迹会保存在浏览器本地。轨迹、视频、瓦片缓存保存在项目 `.data/`；可用 `TRACE_DATA_DIR` 更改位置。数据不会自动上传到第三方，在线地图只请求对应范围的瓦片。

Git 保留源代码、自动化测试、文档、锁文件和清理后的默认示例；本地数据、导出视频、测试截图 / 报告、日志、依赖和编译工具均被排除。`examples/` 仅跟踪默认的 `West Lake Loop.kml`，其余个人轨迹或对比素材不会被自动提交。

### 格式与透明度

| 格式 | 编码 | Alpha | 用途 |
| --- | --- | --- | --- |
| MP4 | H.264 / yuv420p | 无 | 通用播放，带不透明背景的小地图 |
| WebM | VP9 / yuva420p | 有 | 透明或半透明叠加，体积较小 |
| MOV | ProRes 4444 | 有 | 专业剪辑软件，文件较大 |
| MOV | HEVC 辅助 Alpha 层 / yuva420p | 有 | 压缩透明素材，需支持 HEVC Alpha 的软件 |

切换到极简几何时，默认透明背景 + WebM。透明 / 半透明背景不能导出为本项目的 H.264 MP4；可改用 WebM / MOV，或将背景不透明度设为 100%。MP4、WebM、HEVC Alpha 的宽高须为偶数；最多支持 3840 × 2160 个像素，也支持同等像素量的竖屏尺寸。

HEVC Alpha 输出为单条 HEVC 视频流中的辅助 Alpha 层，MOV 使用 `hvc1` 标识。后端检测失败时会说明原因并阻止导出。旧 FFmpeg / libx265 会丢弃 Alpha，不能用来生成或可靠解码这种素材；本地专用 FFmpeg 8.1 已验证透明度与颜色，但 Apple 播放器、Final Cut Pro、Premiere 等软件尚未实测，导入前应先用短片检查透明度。HEVC 是有损编码，边缘与 Alpha 存在量化误差，需要高质量中间素材时仍可选 ProRes。

如果 HEVC Alpha 在普通播放器或网盘预览里出现线条显著变粗、标记光晕变成实色，请先检查播放端是否合成了辅助 Alpha 层。透明素材保存的是直通颜色：辉光即使只有很低的不透明度，其 RGB 仍接近轨迹原色；忽略 Alpha 后，整个辉光范围都会变成一条实色粗带。已用同一实际 MOV 的 Alpha 解码与只读颜色层解码复现这种差异，与 PotPlayer / 百度网盘播放的用户反馈一致。调小线宽或关闭辉光不能解决透明通道缺失；应在支持 HEVC Alpha 的剪辑软件中叠加检查，需要通用播放时选择背景 100% 不透明的 MP4。WebM / ProRes 的 Alpha 支持也取决于目标软件。

本项目导出独立的小地图素材，不会修改或重新编码原始第一视角视频。剪辑时将素材放在左上角，并设置合适的大小。倍率应与原视频一致：实时视频用 1×，60 倍加速视频用 60×。如果视频晚于轨迹开始，先设置截取开始秒数；剪掉的视频片段对应的 KML 段也应分别导出，保持同步。

用 FFmpeg 合成透明 WebM（`-c:v libvpx-vp9` 是输入解码器，确保读取 VP9 alpha）：

```bash
ffmpeg -i pov.mp4 -c:v libvpx-vp9 -i minimap.webm \
  -filter_complex "[1:v]scale=320:-1[mini];[0:v][mini]overlay=24:24:eof_action=pass[v]" \
  -map "[v]" -map '0:a?' -c:v libx264 -crf 18 -c:a copy composite.mp4
```

素材为 ProRes MOV 时移除输入侧的 `-c:v libvpx-vp9` 即可。HEVC Alpha 合成需要支持辅助 Alpha 解码的 FFmpeg 8.1+ 完整构建；项目安装的专用构建仅用于 HEVC 导出和验证，不包含合成所需的全部滤镜和 H.264 编码器。最终合成的 MP4 已把透明素材与原视频合并，因此不再需要 alpha。

### KML 支持范围

- `gx:Track` / `gx:MultiTrack`：`when` 与 `coord` 一一对应，支持带时区的 ISO 8601 时间。
- 带 `TimeStamp/when`、`TimeSpan/begin` 或常见 `<time>` 的 `Placemark/Point`，包含 COROS 的 `Track Points`。
- COROS 的 `Track` + `Laps` 导出：主路线是多个 `LineString`，时间在 `Lap N` 的 HTML 描述中。解析器会将每段秒数映射到对应里程并插值；这是分段时间推导，不是逐点 GPS 时间戳，界面会明确标记并警告。兼容测试使用合成数据，不再附带个人活动文件。
- COROS 文件中独立地标上的单个 `<time>`（例如检票口）只作为地标时间，不会被误当成整条路线的逐点时间。
- 无逐点时间的 `LineString`：必须在导入选项里填写真实总时长。以距离匀速推算，并明确显示警告，无法还原原始停留。
- 停留点保留；重复时间且同坐标可合并，重复时间但不同坐标会拒绝。段内乱序按时间排序，互相重叠的多段时间会拒绝。
- 多段不连接；段间时间空白保持上段终点，到下一段起点时跳转。跨 ±180° 经线按短弧插值。
- 高德转换假设输入 KML 是标准 WGS84；已被转换为 GCJ-02 的非标准 KML 应先还原坐标系。

KML 兼容性不是一个需要“支持所有变体”的单一开关。XML 外壳和标准元素可以用标准解析器稳定处理，再通过格式探测器适配厂商扩展（例如这里的 COROS `Laps`）；真正无法自动根治的是源文件没有保存的信息，例如只有一条路线和一个开始时间、坐标与时间数量不一致、同一时刻对应多个位置，或时间没有时区。遇到这些情况，应用应拒绝制造看似精确的真实时间，给出具体警告并要求用户补充总时长或分段参数。

单文件最大 20 MB，单条轨迹最多 300,000 原始点，一次任务最多 216,000 帧。超限时可以提高倍率、减小 FPS 或截取一段。一次最多 3 个未完成任务，串行执行，渲染不会阻塞 API。

默认示例为 `examples/West Lake Loop.kml`：已清理的西湖真实徒步轨迹，共 1,911 个点，约 11.97 km、2 小时 54 分 20 秒。仅保留路线名称、经纬度、海拔与逐点时间；作者、昵称、账号与平台 ID、头像、照片标记、描述和其他扩展数据均已移除。绝对日期统一平移至 `2000-01-01T00:00:00Z`，逐点时间间隔保持不变，因此播放速度和停留仍来自原记录。原合成示例及 COROS 示例文件已删除。

## 测试

```bash
npm test
npm run build
```

端到端验证会实际导出 MP4 / WebM / ProRes MOV 并解码每一帧；检测到 HEVC Alpha 时也会导出并验证单流 `hvc1` MOV、透明度和直通颜色。还会验证浏览器中的拖动、锁定、播放、格式约束和手机布局。设置 `TRACE_REQUIRE_HEVC_ALPHA=1` 可要求 HEVC Alpha 必须可用。

先启动应用，再执行：

```bash
npx playwright install chromium --with-deps
npm run test:e2e
```

默认测试生产页面 `http://127.0.0.1:8000`。开发模式可设置 `TRACE_WEB_URL=http://127.0.0.1:5173`；另可设置 `TRACE_URL` 指定 API，`TRACE_CHROMIUM_PATH` 复用已有 Chromium。截图及实际导出素材在 `test-results/`。

运行 `npm run test:e2e:subpath` 可验证生产构建在 `/tools/trace/` 多层子目录下的资源、API、瓦片与下载；测试代理会拒绝前缀外的请求。

## 部署与设计文档

```bash
docker compose up --build -d
```

Docker 在 http://127.0.0.1:8000 提供应用，挂载 `.data/` 持久化数据。当前为单机本地创作工具；若需公网或多用户服务，需要另行加入鉴权、独立任务队列和存储配额。

Docker 下载 Debian 依赖较慢时，可以构建时指定镜像源，例如 `docker build --build-arg DEBIAN_MIRROR=https://mirrors.tuna.tsinghua.edu.cn -t pudding-track-studio .`；默认仍使用 Debian 官方源。代理需使用容器可访问的地址，Docker Desktop 通常可使用 `host.docker.internal`，并通过 `--build-arg HTTP_PROXY=... --build-arg HTTPS_PROXY=...` 传入。

前端是单页应用，构建资源、图标、首页、API、瓦片及下载均通过相对路径访问，可直接部署到 `/trace/` 等子目录，也可使用 `index.html` 或 hash 地址，无需重新指定 Vite 构建前缀。部署目录 URL 须以 `/` 结束（例如 `/trace/`）；将 `/trace` 重定向至 `/trace/`，并让该目录下的 `api/` 请求到达 FastAPI。例如 Nginx 同时代理生产页面与 API：

```nginx
location = /trace { return 308 /trace/; }
location /trace/ {
    proxy_pass http://127.0.0.1:8000/;
}
```

`proxy_pass` 末尾的 `/` 会在转发时去除 `/trace/` 前缀，后端保持现有 `/api/...` 路径。独立部署 `dist/` 时同样需要在该子目录下代理 `api/`。

- [架构、时间插值与固定镜头设计](docs/architecture.md)
- [视频渲染方案调研与选择](docs/rendering-research.md)
- [验证结果](docs/validation.md)

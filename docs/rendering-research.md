# 视频渲染方案调研

调研日期：2026-10-12。目标是固定镜头的小地图素材、精确源时间回放、可自定义倍率 / FPS / 分辨率，以及可剪辑的透明几何动画。

## 方案比较

| 方案 | 时间与帧控制 | 透明输出 | 成本与局限 | 判断 |
| --- | --- | --- | --- | --- |
| 浏览器 `MediaRecorder` + `canvas.captureStream()` | 实时录制，受到主线程负载、后台节流和浏览器时钟影响 | 支持情况取决于浏览器 / 编码格式 | 很易实现，但导出通常要等完整播放时长，MP4 支持需运行时判断 | 适合轻量录屏，不作为最终导出核心 |
| Playwright 逐帧页面截图 + FFmpeg | 可逐帧设定，独立于真实时间 | 透明 PNG 可保留 alpha | 每帧截图与 PNG 压缩开销较高；还需处理地图瓦片加载和浏览器部署 | 通用兜底，当前场景不必每帧截图 |
| Remotion | 以帧为中心，成熟的 React 视频组合与分布式渲染 | 支持适用的透明编码组合 | 当前参考栈是 vanilla JS；需要引入 React / Chromium 渲染体系，商业使用还应查看适用许可 | 扩展到复杂视频合成时再评估 |
| **共享 Canvas 2D + Node/Skia + FFmpeg** | **后端预计算源时间位置，逐帧输出** | **VP9 WebM / ProRes 4444 MOV / HEVC Alpha MOV** | 需要 Node 的 Canvas 实现；浏览器和 Skia 抗锯齿可能微有不同 | **本项目选用** |

固定镜头的背景不变，适合先渲染静态画面，再叠加每帧的移动标记。共享 JavaScript Canvas 模块可复用前端样式和坐标逻辑；`@napi-rs/canvas` 提供 Skia 实现和预编译二进制。FFmpeg 接收 RGBA 原始帧流，省去每帧 PNG 编解码，不依赖浏览器实时性能，也可以串行控制内存占用。

Python/FastAPI 负责 KML、帧数组、任务状态和下载；Node 只负责绘图与启动 FFmpeg。这样保留参考仓库的技术路线，同时把编码资源消耗移到独立进程。

## 编码选择

| 输出 | FFmpeg 参数 | 选择原因 |
| --- | --- | --- |
| MP4 | `libx264 -crf 18 -preset fast -pix_fmt yuv420p -movflags +faststart` | 广泛兼容，质量与速度适中，可在下载时较快开始播放 |
| WebM | `libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 0 -crf 22 -row-mt 1` | VP9 可保存 alpha，适合透明素材；禁用不适用的 alternate reference 帧 |
| MOV | `prores_ks -profile:v 4 -pix_fmt yuva444p10le -alpha_bits 16` | ProRes 4444，剪辑软件通常更易使用，适合带 alpha 的高质量中间素材 |
| MOV · HEVC Alpha | `libx265 -preset fast -crf 18 -pix_fmt +yuva420p -x265-params pools=2:frame-threads=1 -tag:v hvc1 -movflags +faststart` | 单流辅助 Alpha 层，帧间压缩减小透明素材体积；使用专用构建并验证后启用 |

MP4 是容器，能否保留透明度取决于编码和播放 / 剪辑端。某些平台支持 HEVC alpha 等特定方案，但通用 H.264 MP4 不能承载本项目需要的透明通道。因此明确区分：通用 MP4 用不透明背景，透明叠加提供 WebM / MOV，避免生成实际不透明却标为透明的视频。

VP9 WebM 的透明验证必须选择 `libvpx-vp9` 解码器；FFmpeg 原生 VP9 解码路径可能不提供 alpha。ProRes MOV 可直接解码。已经用实际文件验证了两条路径，而不只检查容器元数据。

## HEVC Alpha 实现

FFmpeg 7.0.2 的 `libx265` 接口无法保留 Alpha。后续核对源码发现，x265 4.2 在编译时启用 `ENABLE_ALPHA=ON` 后可编码辅助 Alpha 层；FFmpeg 8.1 的 libx265 接口支持 `yuva420p`，并根据输入格式启用 Alpha，无须手动传 `alpha=1`。其 HEVC 软件解码器也能将辅助层合并成 YUVA。

安装脚本固定源版本与 SHA-256，构建静态 x265 8-bit 库和独立 FFmpeg，保留原有三种格式的编码器选择。启动健康检查和导出前都会使用缓存的真实往返探测：编码 64 × 64 的透明、25%、50%、100% 不透明度色块，再解码 RGBA，验证 Alpha 和直通色值。显式配置的不可用编码器不会被替换，导出返回 503，也不会回退成不透明 HEVC。缓存根据二进制路径、修改时间和大小失效。

输入显式使用 `scale=iw:ih:flags=accurate_rnd+bitexact,format=yuva420p`，随后以 `+yuva420p` 严格要求编码器接受 Alpha 格式。这一点既确保颜色转换，也避免 FFmpeg 自动选取不透明格式。早期无外部汇编的最小构建在默认 swscale 转换中出现色度异常，显式精确转换后通过；最终安装脚本另外自动准备 NASM，启用 x265 / FFmpeg 的汇编优化。x265 用两个池线程和一个帧线程，控制资源消耗。

成品是一个 HEVC 视频流包含颜色和辅助 Alpha 层的 `hvc1` MOV。真实轨迹导出会解码全部帧，检验透明背景、半透明路径、颜色、帧数，并用 ffprobe 确认单流与容器标识。不能仅根据 ffprobe 的流级 `pix_fmt` 判断透明度：探测初始颜色层可能显示 `yuv420p`，实际解码会输出 Alpha。Apple / 剪辑软件兼容性尚未实测；有损 Alpha 也不适合冒充无损中间素材。

用户反馈 PotPlayer / 百度网盘播放时线条明显变粗、标记出现实色光晕。对同一实际文件分别用 FFmpeg 8.1 和旧 FFmpeg 解码，前者输出正确 Alpha，后者所有像素 Alpha 都是 255，完全复现了粗带现象。直通 RGB 在低 Alpha 的辉光区域仍保留高亮原色，因此颜色层不能作为最终画面播放。必须将解码的 RGBA 合成到背景或底片上比较；检查几个均匀色块和流元数据不足以验收显示效果。新增实际导出测试检验细线覆盖面积、辉光的 Alpha 总量、黑 / 灰 / 白底的合成误差，并包含忽略 Alpha 的反例。

## 文件大小预估

前端按最终帧数 × 像素数 × 经验范围，另加容器和首帧开销显示大小区间。ProRes 为帧内编码，估算采用每像素每帧 0.3–1.6 字节；范围覆盖当前 320 × 320 / 25 帧约 1 MB，以及 640 × 640 / 5,845 帧约 3.2 GB 的记录。H.264、VP9 和 HEVC Alpha 使用更小的经验系数；HEVC Alpha 暂取 0.0003–0.012 字节，真实地图使用更高系数。固定镜头有利于帧间压缩，但 CRF 编码和 ProRes 内容差异都使结果难以精确预先计算，这些区间不是保证；任务完成后展示实际文件大小。

## 证据与来源

- [参考项目 PuddingTrackRater](https://github.com/AuncelFan/PuddingTrackRater)，查看 FastAPI、Vite、OpenLayers、`coordtransform` 和 KML 时间读取方式；参考提交 `a033b8b9eb7fd08aceefc563e3a6e6822625d77e`。本实现独立编写，没有引入评分代码。
- [FFmpeg Formats](https://ffmpeg.org/ffmpeg-formats.html#rawvideo)：原始帧输入必须显式给出像素格式、帧率、视频尺寸。
- [FFmpeg Codecs](https://ffmpeg.org/ffmpeg-codecs.html)：`libx264`、`libvpx` 与 `prores_ks` 的编码选项；ProRes 的 `alpha_bits` 可为 0 / 8 / 16。
- [x265 Alpha Encode Options](https://x265.readthedocs.io/en/master/cli.html#alpha-encode-options)：Alpha 功能的构建开关、像素格式与位深限制。
- [FFmpeg 8.1 libx265 接口源码](https://github.com/FFmpeg/FFmpeg/blob/n8.1/libavcodec/libx265.c)：YUVA 输入自动启用辅助 Alpha 层。
- [FFmpeg 8.1 HEVC 解码器](https://github.com/FFmpeg/FFmpeg/blob/n8.1/libavcodec/hevc/hevcdec.c)：辅助 Alpha 层识别和 YUVA 格式输出。
- [MDN MediaRecorder](https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder)：浏览器媒体录制 API；编码容器支持依赖运行环境。
- [MDN canvas.captureStream](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/captureStream)：Canvas 媒体流与帧捕获。
- [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas)：Skia Canvas 2D，预构建原生模块。
- [Remotion license](https://www.remotion.dev/license)：个人和符合条件的小公司可免费使用，更大营利组织等情形需对应许可；这不构成本项目拒绝它的唯一理由，主要原因是本场景无需完整 React 视频编排体系。
- [OpenLayers](https://openlayers.org/en/latest/apidoc/module-ol_View-View.html)：固定地图中心、分辨率与取消 View 动画。

本机原三种格式使用 `imageio-ffmpeg` 所带 FFmpeg 7.0.2，HEVC Alpha 使用自行编译的 FFmpeg 8.1 + x265 4.2。具体测试命令和结果见 [validation.md](validation.md)。

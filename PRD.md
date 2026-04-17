# PodCut · 产品需求文档 v0.2

> 面向播客创作者的智能剪辑工具
> 技术栈：Tauri 2 (desktop) / React + Node.js (web SaaS) · 双模架构

---

## 一、产品定位与目标

PodCut 是一款把播客剪辑从"听音频对稿"变成"看文字做删减"的工具。

**核心价值**：
1. AI 转写 + Speaker 识别 → 生成结构化的对话稿本
2. 在稿本上做删减/重排 → 音频自动跟随，不用手动拖时间轴
3. 一站式从素材到发布（小宇宙等平台）

**双轨目标**：
- **桌面版开源**（Tauri，macOS 优先）：完整本地处理，无 API Key 依赖，方便 fork/二开
- **Web SaaS**（未来）：云端处理，订阅付费，前端代码完全复用，只换后端引擎

---

## 二、架构原则（关键，影响所有技术决策）

### 2.1 引擎抽象层（Engine Abstraction）

所有 AI/媒体处理能力都通过接口抽象，前端 React 不感知底层引擎是本地还是云端：

```
前端 React（UI）
    ↕ Tauri invoke / REST API（统一接口）
引擎适配层
    ├── TranscribeEngine
    │     ├── LocalWhisper（whisper-cli 子进程）     ← 桌面版默认
    │     └── CloudWhisper（AssemblyAI / OpenAI）    ← Web SaaS 版
    ├── DiarizeEngine
    │     ├── SilenceHeuristic（零依赖，精度低）      ← MVP 默认
    │     ├── WhisperXLocal（Python subprocess）      ← 本地进阶
    │     └── AssemblyAI（API，含转写+分离一体）      ← Web SaaS 版
    └── LLMEngine
          ├── OllamaLocal（Qwen 等本地模型）          ← 桌面版默认
          └── ClaudeAPI（claude-3-5-haiku 等）        ← 桌面版备用 / Web 版
```

**为什么这样设计**：
- 桌面版开源者可以只改引擎实现，UI 完全不动
- Web 版只需替换引擎适配层，复用全部前端代码
- 避免单点绑定（不依赖唯一的 whisper-rs 静态库等）

### 2.2 子进程优先，拒绝静态链接 AI 库

whisper-rs / onnxruntime 等 C++ 库直接静态链接到 Tauri 二进制会导致：
- macOS 系统版本兼容性崩溃（SIGABRT in ggml）
- 编译时间极长
- 难以调试

**规则**：所有 AI 推理通过子进程（Command）调用，不静态链接。

### 2.3 Panic 策略

- **Release 版**：`panic = "unwind"`（默认），配合 `catch_unwind` + panic hook 记录日志，不让单个命令的 panic 崩溃整个 app
- 禁止 `panic = "abort"`（会让任何内部错误变成无可诊断的 SIGABRT）

---

## 三、三阶段功能需求

### 第一阶段：粗剪

#### 3.1 导入
- 拖拽或文件选择导入视频（mp4/mov/mkv）和音频（mp3/wav/m4a/flac）
- 导入后显示文件信息；多个文件合并为同一项目
- 工程自动保存到 `~/.podcut/projects/<id>.json`

#### 3.2 音视频分离
- ffmpeg 提取音频为 WAV 16kHz mono（whisper 格式）和 WAV 48kHz stereo（原始质量备用）
- 进度条实时反馈
- 若输入已是音频则跳过

#### 3.3 AI 转写（流式）
- 引擎：whisper-cli 子进程（`brew install whisper-cpp`）
- 模型：large-v3（首次运行自动下载 ~3GB，蓝色进度条提示，不和错误信息混淆）
- 按 600s 切段处理，每段完成后实时 emit 到前端
- 输出：词级时间戳（`--word-thold` 选项），供精准剪辑

#### 3.4 Speaker 识别（Diarization）

**Speaker 合并规则**：
- 同一 Speaker 连续说话合并为一个对话条目
- 例外：若另一 Speaker 在主说话人说话期间插入 **≤3s** 的内容（"嗯""对""是的"等），不打断主说话人的条目，仅在时间轴上标记小图标
- 同一 Speaker 连续发言超过 **5 分钟**，按语义换行（LLM 判断自然停顿点）

**识别引擎（按优先级）**：

| 方案 | 精度 | 依赖 | 适用场景 |
|------|------|------|------|
| WhisperX（Python） | ★★★★ | Python + pip install | 桌面进阶，首次引导安装 |
| 静音分割启发式 | ★★☆ | 无（纯 ffmpeg） | MVP 默认，零配置 |
| AssemblyAI API | ★★★★★ | API Key | Web SaaS |

**MVP 实现（Phase 1）**：静音分割启发式
```
ffmpeg silencedetect → 切出静音段 → 每个静音后开始新 Speaker 条目
→ 默认按 [Speaker 1, Speaker 2, Speaker 1, ...] 交替分配
→ 用户可手动拖拽修正 Speaker 归属
```

**进阶实现（Phase 2）**：WhisperX 集成
```
pip install whisperx
whisperx audio.wav --model large-v2 --diarize --hf_token HF_TOKEN
→ 返回带 speaker 标签的 JSON
```

#### 3.5 语义分段（章节）

由 LLM 分析转写文本后分段，规则：
- 切分点：主持人提出**新方向/新主题**的关键提问
- 输出：章节标题（AI 拟写，可编辑）+ 该章节下的对话列表
- 引擎：OllamaLocal（Qwen2.5-7B，本地）或 Claude API（备用）
- 若无 LLM 可用：按 10 分钟均匀切分，标题为"第 X 段"

#### 3.6 内容编辑

**删减**：
- 整章删除：章节标题右侧叉号，整块标灰（可撤销）
- 单条删除：对话条目右侧叉号
- 词语级删除：选中文字区域 → 点击"删除选中词"

**恢复**：
- 删除内容保留可见（灰色 + 删除线）
- 点击已删内容 → 恢复按钮
- 工具栏"显示/隐藏已删内容"切换

**重排**：
- 对话条目拖拽排序（dnd-kit）
- 章节间拖拽移动

**折返识别**（Phase 2，需 LLM）：
- 检测当前段落中与其他章节主题更相关的内容
- 标记黄色气泡 `↩ 建议移至 §章节名`
- 支持：一键接受 / 拖拽 / 忽略

#### 3.7 静音自动剔除
- ffmpeg silencedetect 检测 >5s 静音段（默认阈值 -40dB）
- 自动标记为删除（灰色），用户可逐条恢复
- 设置中可调整阈值和最短静音时长

---

### 第二阶段：精剪

#### 3.8 多轨道波形视图
- 每个 Speaker 独立一条波形轨道（WaveSurfer.js multitrack 插件）
- 粗剪中标记删除的片段在波形上显示为灰色遮罩
- 点击波形任意位置跳转播放
- 框选区间 → 右键菜单：删除/静音/增益

#### 3.9 背景配乐
- 片头/片尾配乐（内置免版权 BGM 库 + 导入本地文件）
- 自动淡入淡出：
  - 片头：播放 N 秒后淡出（默认 8s）
  - 片尾：最后 M 秒淡入（默认 10s）
  - "闪避"（Ducking）：人声出现前 0.5s 配乐淡至 -20dB，人声结束后 0.5s 恢复
- 技术：ffmpeg filter_complex amix + afade

#### 3.10 敏感词处理
- 用户维护敏感词列表
- 自动定位并替换为"哔"音效（时长匹配）
- 支持手动框选区间 → 替换音效

---

### 第三阶段：导出 & 发布

#### 3.11 音频导出
| 格式 | 选项 |
|------|------|
| MP3 | 128 / 192 / 320 kbps |
| AAC/M4A | 128 / 256 kbps |
| WAV | 无损 16/24/32-bit |
| FLAC | 无损压缩 |

- 嵌入元数据（标题、作者、封面图、章节标记）
- 可选：导出各 Speaker 独立音轨（制作用）
- 可选：导出剪辑决策报告（JSON/SRT）

#### 3.12 工程文件
- 格式：`.podcut`（JSON，可 git 版本管理）
- 包含：原始文件引用、所有编辑操作（删除/排序/重命名）、Speaker 标签、章节划分
- 设计为幂等：相同工程文件 + 相同原始音频 → 相同输出

#### 3.13 小宇宙发布

> **调研结论**：小宇宙无官方公开上传 API，但有成熟的 RSS 自动同步机制。
>
> **详细发现**：
> - 官方创作者后台 `podcaster.xiaoyuzhoufm.com` 仅提供 Web UI，无第三方 API
> - 社区逆向项目 [ultrazg/xyz](https://github.com/ultrazg/xyz) 覆盖 ~45 个只读接口（订阅、播放等），无上传/发布接口，且登录接口已失效
> - **RSS 是唯一可行的程序化发布路径**：
>   - 用户先在小宇宙认领 RSS 订阅源（一次性操作，需人工审核约 24h）
>   - 之后每次往 RSS feed 推新 episode → 小宇宙自动同步，无需任何 API 调用
>   - 注意：音频文件需托管在中国大陆可访问的服务器（推荐喜马拉雅托管，或用 CDN）
>
> **实现方案**：
> 1. **Phase 1 - RSS 生成**：PodCut 导出标准播客 RSS XML（含 enclosure 音频链接、章节标记），用户自行上传音频到喜马拉雅/OSS 并提交 RSS 到小宇宙
> 2. **Phase 2 - 半自动化**：PodCut 内置轻量 RSS 服务器（本地 HTTP），配合音频自动上传到用户指定的 OSS/COS，实现"一键发布"
> 3. **Phase 3（如有官方 API）**：直接对接

---

## 四、UI 规范

### 4.1 布局

```
┌──────────────────────────────────────────────────────────┐
│  ← PodCut  [项目名 可编辑]         粗剪｜精剪｜导出  Cmd+Z  │
├──────────┬───────────────────────────────────┬───────────┤
│  章节导航 │       转写文本 / 波形轨道          │  属性面板  │
│  § 开场  │                                   │  Speaker  │
│  § 主题1 │  [Speaker 1] 文字文字文字文字文字  │  设置     │
│  § 主题2 │  [Speaker 2] 文字文字文字文字      │           │
│  § 结尾  │  [Speaker 1] 文字文字文字文字文字  │           │
│          │                                   │           │
├──────────┴───────────────────────────────────┴───────────┤
│  ▶  0:00 ─────────────────────────────── 2:03:47  🔊 ─── │
└──────────────────────────────────────────────────────────┘
```

### 4.2 Speaker 颜色

| Speaker | 颜色 | 用途 |
|---------|------|------|
| Speaker 1（主持人） | 蓝 #3B82F6 | 默认第一个说话人 |
| Speaker 2 | 橙 #F97316 | |
| Speaker 3 | 绿 #22C55E | |
| Speaker 4 | 紫 #A855F7 | |
| 删除标记 | 灰 + 删除线 | 已删内容 |
| 折返建议 | 黄 #FEF3C7 背景 | |
| 静音段 | 红 #FEE2E2 波形遮罩 | |

### 4.3 交互规则
- 点击转写文字 → 跳转到对应音频时间位置并播放
- 悬停对话条目 → 右侧显示操作按钮（播放该段/删除/移动）
- 所有耗时操作显示进度 + 预估剩余时间
- 撤销/重做：Cmd+Z / Cmd+Shift+Z，历史栈 ≥ 50 步
- 空格键：播放/暂停
- J/K/L：后退/暂停/前进（同 Premiere/FCP 习惯）

---

## 五、数据模型

```typescript
// 工程文件顶层结构
interface Project {
  id: string
  version: number              // 工程文件格式版本
  createdAt: number
  updatedAt: number

  // 原始文件（路径 + 哈希，支持文件移动后重新关联）
  sourceFile: { path: string; hash: string; duration: number }
  audioFile: { path: string }  // 提取的 48kHz stereo WAV

  speakers: Speaker[]
  chapters: Chapter[]
  silences: TimeRange[]        // 检测到的静音段
  music?: MusicConfig          // 配乐设置
  export: ExportConfig
}

interface Speaker {
  id: 's1' | 's2' | 's3' | 's4'
  name: string                 // 显示名，用户可改
  color: string                // HEX
  trackPath?: string           // 分离后的独立音轨（精剪用）
}

interface Chapter {
  id: string
  title: string                // AI 生成，可编辑
  deleted: boolean
  dialogues: Dialogue[]
}

interface Dialogue {
  id: string
  speakerId: string
  startTime: number            // 秒，精确到 ms
  endTime: number
  text: string                 // 完整转写文本
  words: Word[]                // 词级时间戳（from whisper --word-thold）
  deleted: boolean
  // 插话记录（主说话人说话期间的短插话）
  interjections?: Interjection[]
  digressionHint?: { suggestedChapterId: string; reason: string }
}

interface Word {
  text: string
  start: number
  end: number
  deleted: boolean
}

interface Interjection {
  speakerId: string
  start: number
  end: number
  text: string
  // 不单独分段，只在时间轴上标注
}

interface TimeRange { start: number; end: number }
```

---

## 六、开发阶段规划

### Phase 1 ✅ · 核心链路稳定
**目标**：能跑完一个完整的 60 分钟播客的粗剪流程

- [x] 文件导入（拖拽）
- [x] 音频提取（ffmpeg）
- [x] Whisper 转写（流式，子进程，无崩溃）
- [x] 模型下载（蓝色进度条，非报错）
- [x] 修复 Release 崩溃：移除 `panic = "abort"`，改为默认 unwind + panic hook
- [x] 静音检测（ffmpeg silencedetect）
- [x] 基础 Speaker 分配（静音分割启发式）
- [x] 章节分段（LLM，Ollama/Claude）
- [x] 对话条目删除/恢复
- [x] 播放器联动（粗剪 + 精剪，点文字跳时间轴）
- [x] 工程文件保存/加载（Zustand persist）

### Phase 2 ✅ · 粗剪完整体验
- [x] WhisperX Speaker 识别（安装引导）
- [x] 插话合并（≤3s 短插话不分段）
- [x] 折返内容检测（LLM）
- [x] 词语级删除
- [x] 拖拽重排（章节 + 对话条目，dnd-kit）
- [x] 小宇宙 RSS 发布（RSS 2.0 XML 生成 + 章节标记）

### Phase 3 ✅ · 精剪
- [x] 多轨道波形（Canvas 多 speaker 轨道 + 静音可视化）
- [x] 配乐 + 淡入淡出（片头/片尾曲，ducking 参数）
- [x] 敏感词哔音替换（beepMarks）
- [x] 音频导出（MP3/AAC/WAV/FLAC，ffmpeg filter_complex/concat）

### Phase 4 · Web SaaS
- [ ] 引擎适配层（AssemblyAI 接入）
- [ ] Next.js / Remix 前端（复用 React 组件）
- [ ] 用户系统 + 付费订阅
- [ ] 云端工程文件存储

---

## 七、技术约束与决策记录

| 问题 | 决策 | 原因 |
|------|------|------|
| whisper-rs 在 macOS 26.x 崩溃 | 改用 whisper-cli 子进程 | 静态链接 C++ 库兼容性问题 |
| `panic = "abort"` 掩盖真实错误 | 改为默认 unwind + panic hook | 可诊断、可恢复 |
| Speaker 分离需 Python | Phase 1 用静音启发式 | 降低安装摩擦，Phase 2 引入 WhisperX |
| 小宇宙无公开 API | RSS feed 方案 | 等待官方 API 或自建 RSS |
| ffmpeg 不在 GUI 应用 PATH | 硬编码 /opt/homebrew/bin | macOS GUI Bundle 不继承 shell PATH |
| 词级时间戳 | whisper-cli `--word-thold 0.01` | 精剪词语级操作的基础 |
| LLM 章节分析 | Ollama（Qwen2.5-7B）本地优先 | 用户本地已部署，无网络依赖 |

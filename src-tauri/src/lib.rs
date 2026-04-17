use std::path::PathBuf;
use std::process::{Command, Stdio};
use tauri::Emitter;

// ─── 日志宏（同时写 stderr 和 /tmp/podcut_rust.log）─────────────────
macro_rules! plog {
    ($($arg:tt)*) => {{
        let msg = format!("[PodCut] {}", format!($($arg)*));
        eprintln!("{}", msg);
        // 追加写入日志文件（方便生产环境调试）
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true).append(true)
            .open("/tmp/podcut_rust.log")
        {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs()).unwrap_or(0);
            let _ = writeln!(f, "[{}] {}", ts, msg);
        }
    }}
}

// ─── 安全截断（防止在多字节 UTF-8 字符中间切断）────────────────────────
fn trunc(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes { return s; }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) { end -= 1; }
    &s[..end]
}

// ─── 目录管理 ─────────────────────────────────────────────────────────
fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| "/tmp".into())
}

/// ~/.podcut/bin/ — 存放自动下载的 ffmpeg / whisper-cli
fn bin_dir() -> PathBuf {
    let dir = PathBuf::from(home_dir()).join(".podcut").join("bin");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// ~/.podcut/models/ — 存放 Whisper 模型
fn model_dir() -> PathBuf {
    let dir = PathBuf::from(home_dir()).join(".podcut").join("models");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn model_path(name: &str) -> PathBuf {
    model_dir().join(format!("ggml-{name}.bin"))
}

// ─── 工具查找（优先 ~/.podcut/bin/，其次系统路径）─────────────────────

fn find_ffmpeg() -> String {
    // 1. 自动下载的版本
    let bundled = bin_dir().join("ffmpeg");
    if bundled.exists() {
        plog!("ffmpeg: using bundled at {}", bundled.display());
        return bundled.to_string_lossy().into_owned();
    }
    // 2. 系统安装（Homebrew 等）
    for p in &["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"] {
        if std::path::Path::new(p).exists() {
            plog!("ffmpeg: using system at {}", p);
            return p.to_string();
        }
    }
    plog!("ffmpeg: not found");
    bundled.to_string_lossy().into_owned() // 路径待下载后使用
}

fn find_ffmpeg_ok() -> bool {
    std::path::Path::new(&find_ffmpeg()).exists()
}

fn find_whisper_cli() -> Option<String> {
    // 1. 自动下载的版本
    let bundled = bin_dir().join("whisper-cli");
    if bundled.exists() {
        plog!("whisper-cli: using bundled at {}", bundled.display());
        return Some(bundled.to_string_lossy().into_owned());
    }
    // 2. 系统安装（brew install whisper-cpp）
    for p in &[
        "/opt/homebrew/bin/whisper-cli",
        "/usr/local/bin/whisper-cli",
        "/opt/homebrew/bin/whisper",
        "/usr/local/bin/whisper",
    ] {
        if std::path::Path::new(p).exists() {
            plog!("whisper-cli: using system at {}", p);
            return Some(p.to_string());
        }
    }
    // 3. 尝试 which
    if let Ok(out) = Command::new("which").arg("whisper-cli").output() {
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !s.is_empty() && std::path::Path::new(&s).exists() {
            plog!("whisper-cli: found via which: {}", s);
            return Some(s);
        }
    }
    plog!("whisper-cli: not found");
    None
}

// ─── 从 zip 数据中提取指定名称的文件 ─────────────────────────────────
fn extract_from_zip(zip_bytes: &[u8], target_names: &[&str], dest: &PathBuf) -> Result<(), String> {
    use std::io::Read;
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor)
        .map_err(|e| format!("ZIP 解析失败: {e}"))?;

    plog!("ZIP 包含 {} 个文件", archive.len());
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("ZIP 读取条目失败: {e}"))?;
        if entry.is_dir() { continue; }
        let entry_name = entry.name().to_string();
        let basename = entry_name.split('/').last().unwrap_or(&entry_name);
        plog!("  ZIP entry: {}", entry_name);

        if target_names.iter().any(|t| basename == *t) {
            plog!("  → 提取 {} → {}", entry_name, dest.display());
            let mut data = Vec::new();
            entry.read_to_end(&mut data).map_err(|e| format!("读取 ZIP 条目失败: {e}"))?;
            std::fs::write(dest, &data).map_err(|e| format!("写入失败: {e}"))?;

            // 设置可执行权限
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let perms = std::fs::Permissions::from_mode(0o755);
                let _ = std::fs::set_permissions(dest, perms);
            }
            // 移除 macOS 隔离属性（否则系统会阻止运行）
            let _ = Command::new("xattr")
                .args(["-d", "com.apple.quarantine", &dest.to_string_lossy()])
                .output();
            return Ok(());
        }
    }
    Err(format!("ZIP 中未找到目标文件（期望之一：{}）", target_names.join(", ")))
}

// ─── 通用下载+解压工具 ─────────────────────────────────────────────────
// 下载 URL → 解压 zip → 提取 target_names 中的第一个匹配文件 → 写到 dest
async fn download_and_extract(
    app: &tauri::AppHandle,
    tool: &str,
    url: &str,
    target_names: &[&str],
    dest: &PathBuf,
) -> Result<(), String> {
    use futures_util::StreamExt;

    plog!("download_tool[{}]: URL = {}", tool, url);

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .no_gzip().no_brotli().no_deflate()
        .user_agent("Mozilla/5.0 PodCut/1.0")
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败: {e}"))?;

    let resp = client.get(url).send().await
        .map_err(|e| format!("连接失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status}"));
    }
    let total = resp.content_length().unwrap_or(0);
    plog!("download_tool[{}]: total={}B", tool, total);

    let mut zip_bytes = Vec::with_capacity(total as usize);
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断: {e}"))?;
        zip_bytes.extend_from_slice(&chunk);
        if total > 0 {
            let ratio = zip_bytes.len() as f64 / total as f64;
            let _ = app.emit("tool_download_progress", serde_json::json!({
                "tool": tool,
                "downloaded": zip_bytes.len(),
                "total": total,
                "ratio": ratio
            }));
        }
    }
    plog!("download_tool[{}]: downloaded {}B, extracting...", tool, zip_bytes.len());
    extract_from_zip(&zip_bytes, target_names, dest)?;
    plog!("download_tool[{}]: OK → {}", tool, dest.display());
    Ok(())
}

// ─── 检查安装状态 ─────────────────────────────────────────────────────
#[tauri::command]
async fn setup_status() -> serde_json::Value {
    let ffmpeg_ok = find_ffmpeg_ok();
    let whisper_ok = find_whisper_cli().is_some();
    let result = serde_json::json!({
        "ffmpeg_ok": ffmpeg_ok,
        "whisper_ok": whisper_ok,
    });
    plog!("setup_status: {}", result);
    result
}

// ─── 自动下载工具 ─────────────────────────────────────────────────────
// tool: "ffmpeg" | "whisper_cli"
#[tauri::command]
async fn download_tool(app: tauri::AppHandle, tool: String) -> Result<(), String> {
    let is_arm64 = cfg!(target_arch = "aarch64");
    plog!("download_tool: tool={} arch={}", tool, if is_arm64 { "arm64" } else { "x86_64" });

    match tool.as_str() {
        "ffmpeg" => {
            let dest = bin_dir().join("ffmpeg");
            if dest.exists() {
                plog!("ffmpeg already exists, skip");
                return Ok(());
            }
            // evermeet.cx 提供 macOS 静态编译的 ffmpeg（ARM64 + x86_64）
            let url = if is_arm64 {
                "https://evermeet.cx/ffmpeg/get/ffmpeg.zip"
            } else {
                "https://evermeet.cx/ffmpeg/get/ffmpeg.zip"
            };
            download_and_extract(&app, "ffmpeg", url, &["ffmpeg"], &dest).await
                .map_err(|e| {
                    plog!("ffmpeg download failed: {}", e);
                    format!("ffmpeg 下载失败: {e}")
                })?;
            let _ = app.emit("tool_download_complete", serde_json::json!({ "tool": "ffmpeg" }));
            Ok(())
        }
        "whisper_cli" => {
            let dest = bin_dir().join("whisper-cli");
            if dest.exists() {
                plog!("whisper-cli already exists, skip");
                return Ok(());
            }
            // whisper.cpp GitHub Releases 预编译包（BLAS 版本，CPU 推理，稳定）
            // 注意：Metal 版本在 macOS 26.x beta 上有兼容性问题，使用 BLAS 版本更稳
            let arch_str = if is_arm64 { "arm64" } else { "x86_64" };
            // 获取最新 release 信息
            let api_url = "https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest";
            let client = reqwest::Client::builder()
                .user_agent("PodCut/1.0")
                .build()
                .map_err(|e| format!("HTTP 客户端失败: {e}"))?;
            let release: serde_json::Value = client.get(api_url).send().await
                .map_err(|e| format!("获取版本信息失败: {e}"))?
                .json().await
                .map_err(|e| format!("版本 JSON 解析失败: {e}"))?;

            // 找到对应架构的 BLAS 包
            let target_suffix = format!("blas-blas-{arch_str}-macos.zip");
            let asset_url = release["assets"].as_array()
                .and_then(|assets| {
                    assets.iter().find(|a| {
                        a["name"].as_str()
                            .map(|n| n.ends_with(&target_suffix))
                            .unwrap_or(false)
                    })
                })
                .and_then(|a| a["browser_download_url"].as_str())
                .map(|s| s.to_string());

            let url = match asset_url {
                Some(u) => {
                    plog!("whisper-cli: latest release asset: {}", u);
                    u
                }
                None => {
                    // 回退到已知版本
                    let fallback = format!(
                        "https://github.com/ggerganov/whisper.cpp/releases/download/v1.7.5/whisper-blas-blas-{arch_str}-macos.zip"
                    );
                    plog!("whisper-cli: no asset found, using fallback: {}", fallback);
                    fallback
                }
            };

            // whisper-cli 在 zip 里可能叫 "whisper-cli" 或旧版叫 "main"
            download_and_extract(&app, "whisper_cli", &url, &["whisper-cli", "main"], &dest).await
                .map_err(|e| {
                    plog!("whisper-cli download failed: {}", e);
                    format!("whisper-cli 下载失败: {e}")
                })?;
            let _ = app.emit("tool_download_complete", serde_json::json!({ "tool": "whisper_cli" }));
            Ok(())
        }
        other => Err(format!("未知工具: {other}"))
    }
}

// ─── 音频提取 ─────────────────────────────────────────────────────────
#[tauri::command]
async fn extract_audio(input: String, output: String) -> Result<(), String> {
    let ffmpeg = find_ffmpeg();
    plog!("extract_audio: {} → {}", input, output);
    let status = Command::new(&ffmpeg)
        .args(["-i", &input, "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", "-y", &output])
        .stderr(Stdio::piped())
        .status()
        .map_err(|e| format!("ffmpeg 启动失败 ({ffmpeg}): {e}"))?;
    if status.success() { plog!("extract_audio: done"); Ok(()) }
    else { Err(format!("ffmpeg 退出码: {:?}", status.code())) }
}

// ─── 说话人分轨 ────────────────────────────────────────────────────────
// 根据 Qwen 分配的时间戳，用 ffmpeg aeval 滤镜生成两条静音互补的 WAV 轨道。
// segments: [[t_start, t_end], ...] 为该说话人的全部片段（秒）
// 输出：output_path（仅保留该说话人时段，其余静音）
#[tauri::command]
async fn split_audio_track(
    input_path: String,
    segments: Vec<[f64; 2]>,   // [[start, end], ...]
    output_path: String,
) -> Result<(), String> {
    let ffmpeg = find_ffmpeg();
    plog!("split_audio_track: {} segments → {}", segments.len(), output_path);

    if segments.is_empty() {
        // 没有片段 → 输出全静音（与原始等长）
        let status = Command::new(&ffmpeg)
            .args(["-i", &input_path, "-af", "volume=0", "-y", &output_path])
            .stderr(Stdio::piped()).status()
            .map_err(|e| format!("ffmpeg: {e}"))?;
        return if status.success() { Ok(()) }
               else { Err(format!("ffmpeg 退出码: {:?}", status.code())) };
    }

    // 构建 aeval 表达式：在说话人片段内乘以 1，其余乘以 0
    // 格式：between(t,s,e)+between(t,...) 累加，> 0 时保留，否则静音
    // 用 aeval: val(0)*(expr) 实现按采样点静音
    // 注：between() 最多支持几百个，超过时 ffmpeg 会报错 → 分批处理
    const BATCH_SIZE: usize = 200;
    if segments.len() > BATCH_SIZE {
        // 超过批次上限 → 先生成中间文件，再拼接（简化：截断到前 BATCH_SIZE）
        plog!("split_audio_track: too many segments ({}), truncating to {}", segments.len(), BATCH_SIZE);
    }
    let segs = &segments[..segments.len().min(BATCH_SIZE)];

    let expr: String = segs.iter()
        .map(|[s, e]| format!("between(t,{s:.3},{e:.3})"))
        .collect::<Vec<_>>()
        .join("+");

    // aeval 表达式：样本值 × (是否在说话人时段内 > 0)
    let filter = format!("aeval=val(0)*({expr}):c=same");

    let status = Command::new(&ffmpeg)
        .args(["-i", &input_path, "-af", &filter,
               "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1", "-y", &output_path])
        .stderr(Stdio::piped()).status()
        .map_err(|e| format!("ffmpeg: {e}"))?;

    if status.success() { plog!("split_audio_track done: {}", output_path); Ok(()) }
    else { Err(format!("ffmpeg 退出码: {:?}", status.code())) }
}

// ─── 音频导出（合并保留片段 + 音乐 + beep → 目标格式）────────────────
// 多阶段管线：
//   1) concat 保留片段 → speech.wav
//   2) 叠加 beep 音（静音原始段 + 1kHz sine）→ beeped.wav
//   3) 拼接 intro（fade-in）+ speech + outro（fade-out）→ final output
#[tauri::command]
async fn export_audio(
    app: tauri::AppHandle,
    input_path: String,
    segments: Vec<[f64; 2]>,
    format: String,
    quality: String,
    output_path: String,
    // 可选：音乐轨
    intro_path: Option<String>,
    intro_fade_in: Option<f64>,
    intro_fade_out: Option<f64>,
    outro_path: Option<String>,
    outro_fade_in: Option<f64>,
    outro_fade_out: Option<f64>,
    // 可选：beep 标记（[t_start, t_end]，相对于 concat 后的时间线）
    beep_ranges: Option<Vec<[f64; 2]>>,
    // 可选：元数据嵌入
    meta_title: Option<String>,
    meta_artist: Option<String>,
    meta_album: Option<String>,
    // 可选：章节标记 [{title, start_ms, end_ms}]
    chapters: Option<Vec<serde_json::Value>>,
) -> Result<String, String> {
    let ffmpeg = find_ffmpeg();
    plog!("export_audio: {} segments, format={}, quality={}, intro={}, outro={}, beeps={} → {}",
        segments.len(), format, quality,
        intro_path.is_some(), outro_path.is_some(),
        beep_ranges.as_ref().map(|b| b.len()).unwrap_or(0),
        output_path);

    if segments.is_empty() {
        return Err("没有保留的片段可导出".into());
    }

    let tmp_dir = std::env::temp_dir().join(format!("podcut_export_{}", std::process::id()));
    let _ = std::fs::create_dir_all(&tmp_dir);
    let total_segments = segments.len();

    // 构建 codec 参数
    let codec_args: Vec<String> = match format.as_str() {
        "mp3" => {
            let kbps = parse_kbps(&quality);
            vec!["-codec:a".into(), "libmp3lame".into(), "-b:a".into(), format!("{}k", kbps)]
        }
        "aac" => {
            let kbps = parse_kbps(&quality);
            vec!["-codec:a".into(), "aac".into(), "-b:a".into(), format!("{}k", kbps)]
        }
        "wav" => {
            if quality.contains("24-bit") {
                vec!["-codec:a".into(), "pcm_s24le".into(), "-ar".into(), "48000".into()]
            } else {
                vec!["-codec:a".into(), "pcm_s16le".into(), "-ar".into(), "44100".into()]
            }
        }
        "flac" => {
            let ar = if quality.contains("48") { "48000" } else { "44100" };
            vec!["-codec:a".into(), "flac".into(), "-ar".into(), ar.into()]
        }
        _ => return Err(format!("不支持的格式: {format}")),
    };

    // ── 第1步：concat 保留片段 → speech.wav ──
    let speech_wav = tmp_dir.join("speech.wav");
    let speech_str = speech_wav.to_string_lossy().to_string();

    let _ = app.emit("export_progress", serde_json::json!({ "pct": 5, "msg": "合并对话片段…" }));

    // 按批次合并：每批 100 段用 filter_complex，超过则分批 + concat demuxer
    const BATCH: usize = 100;
    if total_segments <= BATCH {
        // 单次 filter_complex
        let mut filter_parts: Vec<String> = Vec::new();
        let mut concat_inputs: Vec<String> = Vec::new();
        for (i, [s, e]) in segments.iter().enumerate() {
            filter_parts.push(format!("[0:a]atrim=start={s:.3}:end={e:.3},asetpts=N/SR/TB[a{i}]"));
            concat_inputs.push(format!("[a{i}]"));
        }
        let concat_str = concat_inputs.join("");
        let filter = format!(
            "{};{}concat=n={total_segments}:v=0:a=1[out]",
            filter_parts.join(";"), concat_str
        );
        let out = Command::new(&ffmpeg)
            .args(["-i", &input_path, "-filter_complex", &filter, "-map", "[out]",
                   "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1", "-y", &speech_str])
            .stderr(Stdio::piped()).stdout(Stdio::piped()).output()
            .map_err(|e| format!("ffmpeg concat 失败: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!("ffmpeg concat 失败: {}", trunc(&stderr, 300)));
        }
    } else {
        // 分批：每批 BATCH 段 → batch_NNN.wav → concat demuxer 合并
        // 比逐段切割快 50-100 倍（5000 段仅需 ~50 次 ffmpeg 而非 5000 次）
        let mut batch_files: Vec<String> = Vec::new();
        for (batch_idx, batch) in segments.chunks(BATCH).enumerate() {
            let batch_path = tmp_dir.join(format!("batch_{batch_idx:03}.wav"));
            let batch_str = batch_path.to_string_lossy().to_string();
            let n = batch.len();
            let mut filter_parts: Vec<String> = Vec::new();
            let mut concat_inputs: Vec<String> = Vec::new();
            for (i, [s, e]) in batch.iter().enumerate() {
                filter_parts.push(format!("[0:a]atrim=start={s:.3}:end={e:.3},asetpts=N/SR/TB[a{i}]"));
                concat_inputs.push(format!("[a{i}]"));
            }
            let filter = format!("{};{}concat=n={n}:v=0:a=1[out]",
                filter_parts.join(";"), concat_inputs.join(""));
            let out = Command::new(&ffmpeg)
                .args(["-i", &input_path, "-filter_complex", &filter, "-map", "[out]",
                       "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1", "-y", &batch_str])
                .stderr(Stdio::piped()).stdout(Stdio::piped()).output()
                .map_err(|e| format!("ffmpeg batch {batch_idx}: {e}"))?;
            if !out.status.success() {
                let stderr = String::from_utf8_lossy(&out.stderr);
                return Err(format!("ffmpeg 批次 {batch_idx} 失败: {}", trunc(&stderr, 300)));
            }
            batch_files.push(batch_str);
            let pct = 5 + ((batch_idx + 1) * BATCH * 30 / total_segments).min(30);
            let _ = app.emit("export_progress", serde_json::json!({ "pct": pct, "msg": format!("合并批次 {}/{}", batch_idx+1, (total_segments + BATCH - 1) / BATCH) }));
        }
        // concat demuxer 合并所有批次
        let list_lines: Vec<String> = batch_files.iter().map(|p| format!("file '{p}'")).collect();
        let list_path = tmp_dir.join("concat_list.txt");
        std::fs::write(&list_path, list_lines.join("\n")).map_err(|e| format!("{e}"))?;
        let out = Command::new(&ffmpeg)
            .args(["-f", "concat", "-safe", "0", "-i", &list_path.to_string_lossy(),
                   "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "1", "-y", &speech_str])
            .stderr(Stdio::piped()).stdout(Stdio::piped()).output()
            .map_err(|e| format!("ffmpeg concat 失败: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!("ffmpeg concat 失败: {}", trunc(&stderr, 300)));
        }
    }

    // beep 范围预处理（后续合并到最终编码步骤，减少一次完整 PCM 读写）
    let beeps = beep_ranges.unwrap_or_default();
    // 构建 beep 滤镜片段（在最终编码时注入，不再生成中间 beeped.wav）
    let beep_filter_expr: Option<String> = if !beeps.is_empty() {
        let _ = app.emit("export_progress", serde_json::json!({ "pct": 45, "msg": format!("准备 {} 处消音…", beeps.len()) }));
        let mute_expr: String = beeps.iter()
            .map(|[s, e]| format!("between(t,{s:.3},{e:.3})"))
            .collect::<Vec<_>>().join("+");
        // speech → mute → amix with sine → [beeped]
        Some(format!(
            "[{{IN}}]volume=enable='{mute_expr}':volume=0[_muted];\
             sine=f=1000:sample_rate=44100,aformat=sample_fmts=s16:channel_layouts=mono[_beep];\
             [_beep]volume=enable='{mute_expr}':volume=0.3[_beep_g];\
             [_muted][_beep_g]amix=inputs=2:duration=first[_beeped]"))
    } else {
        None
    };

    // ── 第2.5步：生成 ffmetadata 文件（元数据 + 章节标记）──
    let ffmeta_path = tmp_dir.join("ffmetadata.txt");
    let has_meta = meta_title.is_some() || meta_artist.is_some() || meta_album.is_some()
        || chapters.as_ref().map(|c| !c.is_empty()).unwrap_or(false);
    if has_meta {
        let mut meta = String::from(";FFMETADATA1\n");
        if let Some(ref t) = meta_title  { meta.push_str(&format!("title={}\n", t.replace('\n', " "))); }
        if let Some(ref a) = meta_artist { meta.push_str(&format!("artist={}\n", a.replace('\n', " "))); }
        if let Some(ref al) = meta_album { meta.push_str(&format!("album={}\n", al.replace('\n', " "))); }
        // 章节标记
        if let Some(ref chaps) = chapters {
            for ch in chaps {
                let title = ch.get("title").and_then(|v| v.as_str()).unwrap_or("Chapter");
                let start_ms = ch.get("start_ms").and_then(|v| v.as_i64()).unwrap_or(0);
                let end_ms = ch.get("end_ms").and_then(|v| v.as_i64()).unwrap_or(start_ms + 1000);
                meta.push_str(&format!(
                    "\n[CHAPTER]\nTIMEBASE=1/1000\nSTART={}\nEND={}\ntitle={}\n",
                    start_ms, end_ms, title.replace('\n', " ")
                ));
            }
        }
        std::fs::write(&ffmeta_path, &meta).map_err(|e| format!("写入 ffmetadata 失败: {e}"))?;
        plog!("export_audio: ffmetadata written ({} bytes)", meta.len());
    }

    // ── 最终步：beep + intro/outro + 编码 → 单次 ffmpeg 输出（省去中间 beeped.wav）──
    let has_intro = intro_path.as_ref().map(|p| !p.is_empty() && std::path::Path::new(p).exists()).unwrap_or(false);
    let has_outro = outro_path.as_ref().map(|p| !p.is_empty() && std::path::Path::new(p).exists()).unwrap_or(false);
    let has_beep = beep_filter_expr.is_some();

    {
        let _ = app.emit("export_progress", serde_json::json!({ "pct": 60, "msg": "编码输出…" }));

        let mut input_args: Vec<String> = Vec::new();
        let mut filter_parts: Vec<String> = Vec::new();
        let mut concat_labels: Vec<String> = Vec::new();
        let mut input_idx: usize = 0;

        // Intro
        if has_intro {
            let intro = intro_path.as_ref().unwrap();
            input_args.extend(["-i".into(), intro.clone()]);
            let fi = intro_fade_in.unwrap_or(3.0);
            let fo = intro_fade_out.unwrap_or(0.0);
            let mut f = format!("[{input_idx}:a]");
            if fi > 0.0 { f.push_str(&format!("afade=t=in:st=0:d={fi:.1},")); }
            if fo > 0.0 {
                let dur = get_file_duration(&ffmpeg, intro).unwrap_or(30.0);
                f.push_str(&format!("afade=t=out:st={:.1}:d={fo:.1},", dur - fo));
            }
            f.push_str("aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=mono[intro]");
            filter_parts.push(f);
            concat_labels.push("[intro]".into());
            input_idx += 1;
        }

        // Speech 输入
        input_args.extend(["-i".into(), speech_str.clone()]);
        let speech_label = format!("{input_idx}:a");

        // 如果有 beep，内联 beep 滤镜；否则直接格式化
        if let Some(ref beep_tmpl) = beep_filter_expr {
            let beep_filter = beep_tmpl.replace("{IN}", &speech_label);
            filter_parts.push(beep_filter);
            filter_parts.push("[_beeped]aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=mono[speech]".into());
        } else {
            filter_parts.push(format!("[{speech_label}]aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=mono[speech]"));
        }
        concat_labels.push("[speech]".into());
        input_idx += 1;

        // Outro
        if has_outro {
            let outro = outro_path.as_ref().unwrap();
            input_args.extend(["-i".into(), outro.clone()]);
            let fi = outro_fade_in.unwrap_or(0.0);
            let fo = outro_fade_out.unwrap_or(5.0);
            let mut f = format!("[{input_idx}:a]");
            if fi > 0.0 { f.push_str(&format!("afade=t=in:st=0:d={fi:.1},")); }
            if fo > 0.0 {
                let dur = get_file_duration(&ffmpeg, outro).unwrap_or(30.0);
                f.push_str(&format!("afade=t=out:st={:.1}:d={fo:.1},", dur - fo));
            }
            f.push_str("aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=mono[outro]");
            filter_parts.push(f);
            concat_labels.push("[outro]".into());
            input_idx += 1;
        }

        // 是否需要 filter_complex
        let needs_filter = has_beep || has_intro || has_outro;
        let mut args = input_args;

        if needs_filter {
            // concat 多个音轨（或仅 beep 处理后的 speech）
            if concat_labels.len() > 1 {
                let n = concat_labels.len();
                let labels = concat_labels.join("");
                filter_parts.push(format!("{labels}concat=n={n}:v=0:a=1[out]"));
            } else {
                // 仅 speech（可能含 beep 滤镜），重命名输出标签
                filter_parts.push("[speech]anull[out]".into());
            }
            let filter = filter_parts.join(";");
            args.extend(["-filter_complex".into(), filter, "-map".into(), "[out]".into()]);
        }

        // 注入 metadata 文件
        if has_meta {
            args.extend(["-i".into(), ffmeta_path.to_string_lossy().into_owned()]);
            args.extend(["-map_metadata".into(), format!("{}", input_idx)]);
        }
        args.extend(codec_args.clone());
        args.extend(["-y".into(), output_path.clone()]);

        let _ = app.emit("export_progress", serde_json::json!({ "pct": 75, "msg": "编码输出…" }));

        let out = Command::new(&ffmpeg)
            .args(&args)
            .stderr(Stdio::piped()).stdout(Stdio::piped()).output()
            .map_err(|e| format!("ffmpeg final 失败: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            plog!("export_audio final FAILED: {}", trunc(&stderr, 500));
            return Err(format!("ffmpeg 最终编码失败: {}", trunc(&stderr, 300)));
        }
    }

    // 清理临时文件
    let _ = std::fs::remove_dir_all(&tmp_dir);

    let file_size = std::fs::metadata(&output_path).map(|m| m.len()).unwrap_or(0);
    let _ = app.emit("export_progress", serde_json::json!({ "pct": 100, "msg": "导出完成" }));
    plog!("export_audio: done, size={}KB", file_size / 1024);

    Ok(serde_json::json!({ "path": output_path, "size": file_size }).to_string())
}

/// 获取音频文件时长（复用 ffmpeg Duration 解析逻辑）
fn get_file_duration(ffmpeg: &str, path: &str) -> Result<f64, String> {
    let out = Command::new(ffmpeg)
        .args(["-i", path])
        .stderr(Stdio::piped()).stdout(Stdio::null()).output()
        .map_err(|e| format!("{e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    for line in stderr.lines() {
        if let Some(pos) = line.find("Duration:") {
            let rest = &line[pos + 9..];
            let ts = rest.trim_start().splitn(2, ',').next().unwrap_or("").trim();
            let parts: Vec<&str> = ts.split(':').collect();
            if parts.len() == 3 {
                let h: f64 = parts[0].parse().unwrap_or(0.0);
                let m: f64 = parts[1].parse().unwrap_or(0.0);
                let s: f64 = parts[2].parse().unwrap_or(0.0);
                return Ok(h * 3600.0 + m * 60.0 + s);
            }
        }
    }
    Err("Duration 未找到".into())
}

/// 从 "256 kbps" 等字符串中解析比特率数值
fn parse_kbps(s: &str) -> u32 {
    s.split_whitespace()
        .next()
        .and_then(|n| n.parse::<u32>().ok())
        .unwrap_or(192)
}

// ─── 获取时长 ─────────────────────────────────────────────────────────
#[tauri::command]
async fn get_audio_duration(path: String) -> Result<f64, String> {
    let ffmpeg = find_ffmpeg();
    let out = Command::new(&ffmpeg)
        .args(["-i", &path])
        .stderr(Stdio::piped()).stdout(Stdio::null())
        .output()
        .map_err(|e| format!("ffmpeg 启动失败 ({ffmpeg}): {e}"))?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    for line in stderr.lines() {
        if let Some(pos) = line.find("Duration:") {
            // 安全切片：Duration: 之后的内容全是 ASCII
            let rest = &line[pos + 9..];
            let ts = rest.trim_start().splitn(2, ',').next().unwrap_or("").trim();
            let parts: Vec<&str> = ts.split(':').collect();
            if parts.len() == 3 {
                let h: f64 = parts[0].parse().unwrap_or(0.0);
                let m: f64 = parts[1].parse().unwrap_or(0.0);
                let s: f64 = parts[2].parse().unwrap_or(0.0);
                let total = h * 3600.0 + m * 60.0 + s;
                plog!("get_audio_duration: {}s", total);
                return Ok(total);
            }
        }
    }
    Err(format!("Duration 未找到. stderr: {}", trunc(&stderr, 400)))
}

// ─── 模型管理 ─────────────────────────────────────────────────────────
#[tauri::command]
async fn check_model(model: String) -> bool {
    let p = model_path(&model);
    let exists = p.exists();
    plog!("check_model: {} → {} ({})", model, exists, p.display());
    exists
}

#[tauri::command]
async fn download_model(app: tauri::AppHandle, model: String) -> Result<(), String> {
    let dest = model_path(&model);
    plog!("download_model: model={} dest={}", model, dest.display());
    if dest.exists() { plog!("model already exists"); return Ok(()); }

    let urls = [
        format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{model}.bin"),
        format!("https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-{model}.bin"),
    ];
    let part = dest.with_extension("bin.part");
    if part.exists() { let _ = std::fs::remove_file(&part); }

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .no_gzip().no_brotli().no_deflate()
        .user_agent("Mozilla/5.0 PodCut/1.0")
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败: {e}"))?;

    use futures_util::StreamExt;
    let mut last_error = String::from("no URL tried");

    for url in &urls {
        plog!("download_model: trying {}", url);
        let resp = match client.get(url).send().await {
            Ok(r) => r,
            Err(e) => { last_error = format!("连接失败: {e}"); continue; }
        };
        let status = resp.status();
        let ct = resp.headers().get("content-type")
            .and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let total = resp.content_length().unwrap_or(0);
        plog!("download_model: HTTP {} ct={} total={}B", status, ct, total);
        if !status.is_success() { last_error = format!("HTTP {status}"); continue; }
        if ct.contains("text/html") { last_error = "URL 返回 HTML".to_string(); continue; }

        let mut file = std::fs::File::create(&part)
            .map_err(|e| format!("创建临时文件失败: {e}"))?;
        let mut downloaded: u64 = 0;
        let mut stream = resp.bytes_stream();
        let mut ok = true;

        while let Some(chunk_r) = stream.next().await {
            match chunk_r {
                Err(e) => { last_error = format!("下载中断: {e}"); ok = false; break; }
                Ok(chunk) => {
                    if let Err(e) = std::io::Write::write_all(&mut file, &chunk) {
                        last_error = format!("写入失败: {e}"); ok = false; break;
                    }
                    downloaded += chunk.len() as u64;
                    if total > 0 {
                        let ratio = downloaded as f64 / total as f64;
                        if downloaded % (20 * 1024 * 1024) < chunk.len() as u64 {
                            plog!("model download: {:.1}% ({}/{}MB)",
                                ratio * 100.0, downloaded / 1024 / 1024, total / 1024 / 1024);
                        }
                        let _ = app.emit("model_download_progress", serde_json::json!({
                            "downloaded": downloaded, "total": total, "ratio": ratio
                        }));
                    }
                }
            }
        }

        if ok {
            drop(file);
            std::fs::rename(&part, &dest).map_err(|e| format!("重命名失败: {e}"))?;
            plog!("download_model: complete! {}B", downloaded);
            return Ok(());
        }
        let _ = std::fs::remove_file(&part);
    }

    Err(format!("所有下载源失败。最后错误：{last_error}"))
}

// ─── 解析 whisper-cli JSON 输出 ───────────────────────────────────────
fn parse_timestamp_ms(s: &str) -> f64 {
    let s = s.replace(',', ".");
    let parts: Vec<&str> = s.split(':').collect();
    match parts.len() {
        3 => parts[0].parse::<f64>().unwrap_or(0.0) * 3600.0
           + parts[1].parse::<f64>().unwrap_or(0.0) * 60.0
           + parts[2].parse::<f64>().unwrap_or(0.0),
        2 => parts[0].parse::<f64>().unwrap_or(0.0) * 60.0
           + parts[1].parse::<f64>().unwrap_or(0.0),
        _ => s.parse().unwrap_or(0.0),
    }
}

/// 单个词的时间戳
#[derive(serde::Serialize, Clone)]
struct WordToken {
    text: String,
    start: f64,
    end: f64,
}

/// 一段转写结果（含词级时间戳）
struct WhisperSegment {
    t0: f64,
    t1: f64,
    text: String,
    words: Vec<WordToken>,
}

fn parse_whisper_json(json_path: &str) -> Result<Vec<WhisperSegment>, String> {
    let data = std::fs::read_to_string(json_path)
        .map_err(|e| format!("读取 JSON 失败 ({json_path}): {e}"))?;
    let v: serde_json::Value = serde_json::from_str(&data)
        .map_err(|e| format!("JSON 解析失败: {e}"))?;
    let arr = v.get("transcription").and_then(|t| t.as_array())
        .ok_or_else(|| "JSON 中无 transcription 数组".to_string())?;
    let mut result = Vec::new();
    for item in arr {
        let text = item.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
        if text.is_empty() { continue; }
        let t0 = item.get("timestamps").and_then(|ts| ts.get("from"))
            .and_then(|s| s.as_str()).map(parse_timestamp_ms).unwrap_or(0.0);
        let t1 = item.get("timestamps").and_then(|ts| ts.get("to"))
            .and_then(|s| s.as_str()).map(parse_timestamp_ms).unwrap_or(t0);
        // 解析词级 tokens（whisper-cli JSON 中 tokens 数组）
        let words = item.get("tokens").and_then(|t| t.as_array())
            .map(|tokens| {
                tokens.iter().filter_map(|tok| {
                    let w = tok.get("text").and_then(|t| t.as_str())?.trim().to_string();
                    if w.is_empty() { return None; }
                    // 跳过特殊 token（[_BEG_] 等）
                    if w.starts_with('[') && w.ends_with(']') { return None; }
                    let ws = tok.get("timestamps").and_then(|ts| ts.get("from"))
                        .and_then(|s| s.as_str()).map(parse_timestamp_ms).unwrap_or(t0);
                    let we = tok.get("timestamps").and_then(|ts| ts.get("to"))
                        .and_then(|s| s.as_str()).map(parse_timestamp_ms).unwrap_or(t1);
                    Some(WordToken { text: w, start: ws, end: we })
                }).collect()
            }).unwrap_or_default();
        result.push(WhisperSegment { t0, t1, text, words });
    }
    plog!("parse_whisper_json: {} segments from {}", result.len(), json_path);
    Ok(result)
}

// ─── 从文件重新探测时长（ffmpeg -i）─────────────────────────────────
fn probe_duration(ffmpeg: &str, path: &str) -> Option<f64> {
    let out = Command::new(ffmpeg).args(["-i", path])
        .stderr(Stdio::piped()).stdout(Stdio::null())
        .output().ok()?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    for line in stderr.lines() {
        if let Some(pos) = line.find("Duration:") {
            let rest = &line[pos + 9..];
            let ts = rest.trim_start().splitn(2, ',').next().unwrap_or("").trim();
            let parts: Vec<&str> = ts.split(':').collect();
            if parts.len() == 3 {
                let h: f64 = parts[0].parse().unwrap_or(0.0);
                let m: f64 = parts[1].parse().unwrap_or(0.0);
                let s: f64 = parts[2].parse().unwrap_or(0.0);
                let total = h * 3600.0 + m * 60.0 + s;
                if total > 0.0 { return Some(total); }
            }
        }
    }
    None
}

// ─── 流式转写（whisper-cli 子进程，无 C++ 静态链接）────────────────────
#[tauri::command]
async fn transcribe_streaming(
    app: tauri::AppHandle,
    audio_path: String,
    total_seconds: f64,
    model: Option<String>,
) -> Result<(), String> {
    let ffmpeg = find_ffmpeg();
    let model_name = model.as_deref().unwrap_or("large-v3-turbo");
    let mpath = model_path(model_name);

    // ── 前置检查 ──────────────────────────────────────────────────────
    let whisper_bin = match find_whisper_cli() {
        Some(b) => b,
        None => {
            let msg = "AI 转写引擎未安装。请重启 PodCut，应用将自动下载。".to_string();
            plog!("ERROR: {}", msg);
            let _ = app.emit("transcription_error", serde_json::json!({ "code": "whisper_not_found", "message": msg }));
            return Err(msg);
        }
    };
    if !std::path::Path::new(&ffmpeg).exists() {
        let msg = "音频处理引擎未安装。请重启 PodCut，应用将自动下载。".to_string();
        let _ = app.emit("transcription_error", serde_json::json!({ "code": "ffmpeg_not_found", "message": msg }));
        return Err(msg);
    }
    if !std::path::Path::new(&audio_path).exists() {
        let msg = format!("音频文件不存在：{audio_path}");
        let _ = app.emit("transcription_error", serde_json::json!({ "code": "audio_not_found", "message": msg }));
        return Err(msg);
    }
    if !mpath.exists() {
        let msg = format!("Whisper 模型未找到：{}", mpath.display());
        let _ = app.emit("transcription_error", serde_json::json!({ "code": "model_not_found", "message": msg }));
        return Err(msg);
    }

    // ── Bug Fix #2: total_seconds 保护 ────────────────────────────────
    // 如果前端传入 0（duration 探测失败），在 Rust 侧重新探测，确保分段正确
    let total_secs = if total_seconds < 1.0 {
        plog!("WARNING: total_seconds={:.1}s 异常（前端探测失败），重新探测…", total_seconds);
        match probe_duration(&ffmpeg, &audio_path) {
            Some(d) => {
                plog!("re-probed duration: {:.1}s", d);
                let _ = app.emit("transcription_progress", serde_json::json!({
                    "processed": 0, "total": d
                }));
                d
            }
            None => {
                let msg = format!("无法获取音频时长，请检查文件格式：{audio_path}");
                let _ = app.emit("transcription_error", serde_json::json!({ "code": "duration_failed", "message": msg }));
                return Err(msg);
            }
        }
    } else {
        total_seconds
    };

    plog!("transcribe_streaming START: audio={} total={:.1}s model={}", audio_path, total_secs, model_name);
    plog!("  whisper_bin = {}", whisper_bin);
    plog!("  mpath = {}", mpath.display());

    const SEGMENT_SECS: f64 = 600.0;         // 每段 10 分钟
    const WHISPER_TIMEOUT_SECS: u64 = 1800;   // 单段最长等待 30 分钟（防卡死）
    const MIN_WAV_BYTES: u64 = 4096;          // WAV 小于 4KB → 视为空段跳过

    let segment_count = ((total_secs / SEGMENT_SECS).ceil() as usize).max(1);
    let mut chunk_counter: u32 = 0;
    let mut consecutive_failures: u32 = 0;

    plog!("segment_count = {} (total={:.1}s, seg={}s)", segment_count, total_secs, SEGMENT_SECS);

    for seg_idx in 0..segment_count {
        let start   = seg_idx as f64 * SEGMENT_SECS;
        let duration = if seg_idx + 1 == segment_count {
            (total_secs - start).max(0.1)   // 最后一段，至少 0.1s
        } else {
            SEGMENT_SECS
        };
        plog!("segment {}/{}: start={:.1}s dur={:.1}s", seg_idx + 1, segment_count, start, duration);

        // ── 1. ffmpeg 切段 ────────────────────────────────────────────
        let seg_wav = format!("/tmp/podcut_seg_{seg_idx:03}.wav");
        let ffmpeg_status = Command::new(&ffmpeg)
            .args(["-ss", &format!("{start:.3}"), "-i", &audio_path,
                   "-t", &format!("{duration:.3}"), "-vn",
                   "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", "-y", &seg_wav])
            .stderr(Stdio::piped()).stdout(Stdio::null())
            .output();

        match &ffmpeg_status {
            Err(e) => {
                // ffmpeg 可执行文件消失 → 后续段也会失败，终止
                let msg = format!("ffmpeg 启动失败: {e}");
                plog!("FATAL: {}", msg);
                let _ = app.emit("transcription_error", serde_json::json!({
                    "code": "ffmpeg_spawn_failed", "message": msg
                }));
                break;
            }
            Ok(out) if !out.status.success() => {
                // Bug Fix #1: 单段 ffmpeg 失败 → 跳过本段，继续后续
                let stderr = String::from_utf8_lossy(&out.stderr);
                plog!("WARN: ffmpeg seg {} failed (code={:?}): {}", seg_idx, out.status.code(), trunc(&stderr, 200));
                let _ = app.emit("transcription_error", serde_json::json!({
                    "code": "ffmpeg_seg_failed",
                    "message": format!("第 {} 段音频切割失败，已跳过：{}", seg_idx + 1, trunc(&stderr, 200))
                }));
                consecutive_failures += 1;
                if consecutive_failures >= 5 {
                    plog!("FATAL: {} consecutive failures, aborting", consecutive_failures);
                    break;
                }
                continue;
            }
            _ => {}
        }

        // Bug Fix #4: 校验 WAV 文件大小，空段跳过
        let wav_bytes = std::fs::metadata(&seg_wav).map(|m| m.len()).unwrap_or(0);
        if wav_bytes < MIN_WAV_BYTES {
            plog!("segment {}: WAV too small ({}B < {}B), skipping — likely past end of file",
                seg_idx + 1, wav_bytes, MIN_WAV_BYTES);
            let _ = std::fs::remove_file(&seg_wav);
            // 已超出文件末尾，后续段也是空的，提前结束
            break;
        }

        // ── 2. whisper-cli 推理 ───────────────────────────────────────
        let out_base = format!("/tmp/podcut_seg_{seg_idx:03}");
        let out_json = format!("{out_base}.json");
        let _ = std::fs::remove_file(&out_json);  // 清除旧结果

        let wb = whisper_bin.clone();
        let mp = mpath.to_string_lossy().to_string();
        let sw = seg_wav.clone();
        let ob = out_base.clone();

        // Bug Fix #4: 加入超时，防止 whisper 卡死某段
        let blocking_task = tokio::task::spawn_blocking(move || {
            Command::new(&wb)
                // Bug Fix #3: 去掉 --no-prints（兼容性差），stdout/stderr 已 piped 不影响
                // Bug Fix: -l auto 自动检测语言，不限中文
                .args(["-m", &mp, "-l", "auto", "-oj", "-of", &ob, "-t", "4", "-f", &sw])
                .stdout(Stdio::piped()).stderr(Stdio::piped())
                .output()
        });

        let whisper_result = tokio::time::timeout(
            std::time::Duration::from_secs(WHISPER_TIMEOUT_SECS),
            blocking_task,
        ).await;

        let whisper_out = match whisper_result {
            Err(_timeout) => {
                // Bug Fix #4: 超时 → 跳过本段，继续
                plog!("WARN: segment {} whisper timeout ({}s), skipping", seg_idx + 1, WHISPER_TIMEOUT_SECS);
                let _ = app.emit("transcription_error", serde_json::json!({
                    "code": "whisper_timeout",
                    "message": format!("第 {} 段转写超时（{}分钟），已跳过", seg_idx + 1, WHISPER_TIMEOUT_SECS / 60)
                }));
                let _ = std::fs::remove_file(&seg_wav);
                consecutive_failures += 1;
                if consecutive_failures >= 5 { break; }
                continue;
            }
            Ok(Err(e)) => {
                // spawn_blocking join 失败（Tokio 内部错误，极罕见）→ 终止
                let msg = format!("内部调度失败: {e}");
                plog!("FATAL: {}", msg);
                let _ = app.emit("transcription_error", serde_json::json!({ "code": "spawn_failed", "message": msg }));
                let _ = std::fs::remove_file(&seg_wav);
                break;
            }
            Ok(Ok(Err(e))) => {
                // whisper 可执行文件消失 → 终止
                let msg = format!("AI 转写引擎启动失败: {e}");
                plog!("FATAL: {}", msg);
                let _ = app.emit("transcription_error", serde_json::json!({ "code": "whisper_spawn_failed", "message": msg }));
                let _ = std::fs::remove_file(&seg_wav);
                break;
            }
            Ok(Ok(Ok(o))) => o,
        };

        let whisper_stderr = String::from_utf8_lossy(&whisper_out.stderr);
        plog!("whisper-cli exit={:?} seg={}", whisper_out.status.code(), seg_idx + 1);
        if !whisper_stderr.is_empty() {
            plog!("whisper stderr: {}", trunc(&whisper_stderr, 400));
        }

        if !whisper_out.status.success() {
            // Bug Fix #1: 单段失败 → 跳过，不终止整体转写
            plog!("WARN: segment {} whisper exit non-zero ({:?}), skipping", seg_idx + 1, whisper_out.status.code());
            let _ = app.emit("transcription_error", serde_json::json!({
                "code": "whisper_seg_failed",
                "message": format!("第 {} 段转写失败（退出码 {:?}），已跳过：{}",
                    seg_idx + 1, whisper_out.status.code(), trunc(&whisper_stderr, 300))
            }));
            let _ = std::fs::remove_file(&seg_wav);
            consecutive_failures += 1;
            if consecutive_failures >= 5 {
                plog!("FATAL: {} consecutive whisper failures, aborting", consecutive_failures);
                break;
            }
            continue;
        }

        consecutive_failures = 0;  // 成功后重置

        // ── 3. 解析 JSON，修正时间戳，emit chunks ───────────────────────
        if !std::path::Path::new(&out_json).exists() {
            plog!("WARN: segment {} JSON not found at {}, skipping", seg_idx + 1, out_json);
            let _ = std::fs::remove_file(&seg_wav);
            continue;
        }

        match parse_whisper_json(&out_json) {
            Err(e) => {
                plog!("WARN: segment {} JSON parse failed: {}", seg_idx + 1, e);
                let _ = app.emit("transcription_error", serde_json::json!({
                    "code": "json_parse_failed",
                    "message": format!("第 {} 段结果解析失败：{}", seg_idx + 1, e)
                }));
            }
            Ok(segs) => {
                plog!("segment {}/{}: {} chunks parsed", seg_idx + 1, segment_count, segs.len());
                for seg in segs {
                    let text = seg.text.trim().to_string();
                    if text.is_empty() { continue; }
                    chunk_counter += 1;
                    plog!("  chunk #{}: [{:.1}–{:.1}s] {} words, {}",
                        chunk_counter, seg.t0 + start, seg.t1 + start,
                        seg.words.len(), trunc(&text, 50));
                    // 修正词级时间戳：加上段起始偏移
                    let words: Vec<serde_json::Value> = seg.words.iter().map(|w| {
                        serde_json::json!({
                            "text": w.text,
                            "start": w.start + start,
                            "end": w.end + start,
                            "deleted": false,
                        })
                    }).collect();
                    let _ = app.emit("transcription_chunk", serde_json::json!({
                        "id": format!("chunk_{chunk_counter:04}"),
                        "text": text,
                        "speaker": "s1",           // 初始占位，finalizeTranscription 时 assignSpeakers 重新分配
                        "t_start": seg.t0 + start,
                        "t_end":   seg.t1 + start,
                        "cut_status": "keep",
                        "words": words,
                    }));
                }
            }
        }

        // ── 4. 进度上报 ───────────────────────────────────────────────
        let processed = (start + duration).min(total_secs);
        let _ = app.emit("transcription_progress", serde_json::json!({
            "processed": processed, "total": total_secs
        }));

        // ── 5. 清理临时文件 ───────────────────────────────────────────
        let _ = std::fs::remove_file(&seg_wav);
        let _ = std::fs::remove_file(&out_json);
    }

    plog!("transcribe_streaming COMPLETE: {} total chunks emitted", chunk_counter);
    let _ = app.emit("transcription_complete", serde_json::Value::Null);
    Ok(())
}

// ─── 静音段检测 ───────────────────────────────────────────────────────
// 返回 [{start: f64, end: f64}] 列表，单位：秒
// 默认：静音阈值 -40dB，最短 2s（短于此不算静音段）
#[tauri::command]
async fn detect_silences(
    audio_path: String,
    noise_db: Option<f64>,   // 默认 -40
    min_dur: Option<f64>,    // 默认 2.0s
) -> Result<serde_json::Value, String> {
    let ffmpeg = find_ffmpeg();
    let noise = noise_db.unwrap_or(-40.0);
    let dur = min_dur.unwrap_or(2.0);
    plog!("detect_silences: path={} noise={}dB min_dur={}s", audio_path, noise, dur);

    let filter = format!("silencedetect=noise={noise}dB:d={dur}");
    let out = Command::new(&ffmpeg)
        .args(["-i", &audio_path, "-af", &filter, "-f", "null", "-"])
        .stderr(Stdio::piped()).stdout(Stdio::null())
        .output()
        .map_err(|e| format!("ffmpeg 启动失败: {e}"))?;

    let stderr = String::from_utf8_lossy(&out.stderr);
    let mut silences: Vec<serde_json::Value> = Vec::new();
    let mut current_start: Option<f64> = None;

    for line in stderr.lines() {
        if line.contains("silence_start:") {
            if let Some(val) = extract_f64_after(line, "silence_start:") {
                current_start = Some(val);
            }
        } else if line.contains("silence_end:") {
            if let (Some(start), Some(end)) = (current_start, extract_f64_after(line, "silence_end:")) {
                plog!("  silence: {:.2}s – {:.2}s (dur {:.2}s)", start, end, end - start);
                silences.push(serde_json::json!({ "start": start, "end": end }));
                current_start = None;
            }
        }
    }

    plog!("detect_silences: found {} silent regions", silences.len());
    Ok(serde_json::json!(silences))
}

fn extract_f64_after(line: &str, marker: &str) -> Option<f64> {
    let pos = line.find(marker)? + marker.len();
    line[pos..].trim().split_whitespace().next()?.parse().ok()
}

// ─── 环境诊断 ─────────────────────────────────────────────────────────
#[tauri::command]
async fn diagnose_env() -> Result<serde_json::Value, String> {
    let ffmpeg = find_ffmpeg();
    let models: Vec<String> = ["tiny", "base", "small", "medium", "large-v3", "large-v3-turbo"]
        .iter().filter(|m| model_path(m).exists()).map(|m| m.to_string()).collect();
    Ok(serde_json::json!({
        "ffmpeg_path": ffmpeg,
        "ffmpeg_ok": find_ffmpeg_ok(),
        "whisper_cli": find_whisper_cli(),
        "models_available": models,
        "bin_dir": bin_dir().to_string_lossy(),
        "model_dir": model_dir().to_string_lossy(),
        "arch": std::env::consts::ARCH,
    }))
}

// ─── Ollama 状态检查 ──────────────────────────────────────────────────
#[tauri::command]
async fn check_ollama() -> Result<bool, String> {
    Ok(reqwest::get("http://localhost:11434/api/tags").await.is_ok())
}

// ─── WhisperX 状态检查 ────────────────────────────────────────────────
// 检查 python3 + whisperx 包是否可用
#[tauri::command]
async fn check_whisperx() -> Result<serde_json::Value, String> {
    let out = Command::new("python3")
        .args(["-c", "import whisperx; print(whisperx.__version__)"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
            plog!("whisperx: found version {}", ver);
            Ok(serde_json::json!({ "available": true, "version": ver }))
        }
        _ => {
            plog!("whisperx: not found");
            Ok(serde_json::json!({ "available": false }))
        }
    }
}

// ─── WhisperX 说话人分离 ──────────────────────────────────────────────
// 调用 whisperx CLI 对音频做说话人标注，返回带 speaker 的段落
#[tauri::command]
async fn diarize_whisperx(
    audio_path: String,
    hf_token: String,
    model: Option<String>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let model_name = model.unwrap_or_else(|| "large-v2".into());
    plog!("diarize_whisperx: audio={} model={}", audio_path, model_name);

    let _ = app.emit("whisperx_status", serde_json::json!({
        "stage": "starting", "message": "WhisperX 说话人分离启动…"
    }));

    // 输出到临时目录
    let tmp_dir = std::env::temp_dir().join("podcut_whisperx");
    let _ = std::fs::create_dir_all(&tmp_dir);

    let mut cmd = Command::new("python3");
    cmd.args([
        "-m", "whisperx",
        &audio_path,
        "--model", &model_name,
        "--diarize",
        "--hf_token", &hf_token,
        "--output_format", "json",
        "--output_dir", &tmp_dir.to_string_lossy(),
        "--language", "zh",
    ]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    plog!("diarize_whisperx: running command");
    let _ = app.emit("whisperx_status", serde_json::json!({
        "stage": "processing", "message": "WhisperX 处理中（可能需要几分钟）…"
    }));

    let output = cmd.output()
        .map_err(|e| format!("WhisperX 启动失败: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        plog!("diarize_whisperx FAILED: {}", trunc(&stderr, 500));
        return Err(format!("WhisperX 失败: {}", trunc(&stderr, 300)));
    }

    // 查找输出 JSON 文件
    let audio_stem = std::path::Path::new(&audio_path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "audio".into());
    let json_path = tmp_dir.join(format!("{}.json", audio_stem));

    if !json_path.exists() {
        // 尝试查找任何 .json 文件
        let found = std::fs::read_dir(&tmp_dir)
            .map_err(|e| format!("读取输出目录失败: {e}"))?
            .filter_map(|e| e.ok())
            .find(|e| e.path().extension().map(|x| x == "json").unwrap_or(false));
        if let Some(f) = found {
            return parse_whisperx_json(&f.path(), &app);
        }
        return Err("WhisperX 输出文件未找到".into());
    }

    parse_whisperx_json(&json_path, &app)
}

fn parse_whisperx_json(
    path: &std::path::Path,
    app: &tauri::AppHandle,
) -> Result<serde_json::Value, String> {
    let content = std::fs::read_to_string(path)
        .map_err(|e| format!("读取 WhisperX JSON 失败: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("解析 WhisperX JSON 失败: {e}"))?;

    // WhisperX JSON 格式: { "segments": [{ "start", "end", "text", "speaker", "words": [...] }] }
    let segments = json.get("segments")
        .and_then(|s| s.as_array())
        .ok_or("WhisperX JSON 缺少 segments 数组")?;

    let mut chunks: Vec<serde_json::Value> = Vec::new();
    // 建立 speaker 映射：WhisperX 输出 SPEAKER_00, SPEAKER_01... → s1, s2...
    let mut speaker_map: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut next_speaker_idx = 1u32;

    for (i, seg) in segments.iter().enumerate() {
        let text = seg.get("text").and_then(|t| t.as_str()).unwrap_or("").trim().to_string();
        if text.is_empty() { continue; }

        let start = seg.get("start").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let end = seg.get("end").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let raw_speaker = seg.get("speaker").and_then(|v| v.as_str()).unwrap_or("SPEAKER_00").to_string();

        let speaker = speaker_map.entry(raw_speaker.clone()).or_insert_with(|| {
            let s = format!("s{}", next_speaker_idx);
            next_speaker_idx += 1;
            s
        }).clone();

        // 解析词级时间戳
        let words: Vec<serde_json::Value> = seg.get("words")
            .and_then(|w| w.as_array())
            .map(|arr| arr.iter().filter_map(|w| {
                let wtext = w.get("word").and_then(|v| v.as_str())?;
                let ws = w.get("start").and_then(|v| v.as_f64()).unwrap_or(start);
                let we = w.get("end").and_then(|v| v.as_f64()).unwrap_or(end);
                Some(serde_json::json!({
                    "text": wtext.trim(),
                    "start": ws,
                    "end": we,
                    "deleted": false,
                }))
            }).collect())
            .unwrap_or_default();

        chunks.push(serde_json::json!({
            "id": format!("chunk_{:04}", i + 1),
            "text": text,
            "speaker": speaker,
            "t_start": start,
            "t_end": end,
            "cut_status": "keep",
            "words": words,
        }));
    }

    plog!("parse_whisperx_json: {} chunks, {} speakers", chunks.len(), speaker_map.len());
    let _ = app.emit("whisperx_status", serde_json::json!({
        "stage": "done",
        "message": format!("WhisperX 完成：{} 段，{} 位说话人", chunks.len(), speaker_map.len())
    }));

    // 清理临时文件
    let _ = std::fs::remove_file(path);

    Ok(serde_json::json!({
        "chunks": chunks,
        "speaker_count": speaker_map.len(),
        "speaker_map": speaker_map.into_iter().collect::<Vec<_>>(),
    }))
}

// ─── Claude API 代理（绕过 WebView CORS 限制） ────────────────────────
#[tauri::command]
async fn call_claude_api(api_key: String, body_json: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", &api_key)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .body(body_json)
        .send()
        .await
        .map_err(|e| format!("Claude API 请求失败: {e}"))?;
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取响应失败: {e}"))?;
    Ok(text)
}

// ─── 入口 ─────────────────────────────────────────────────────────────
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Panic hook：写日志文件，方便诊断
    std::panic::set_hook(Box::new(|info| {
        let msg = format!(
            "[PodCut PANIC] {}\n  at: {}\n",
            info.payload().downcast_ref::<&str>().copied()
                .or_else(|| info.payload().downcast_ref::<String>().map(|s| s.as_str()))
                .unwrap_or("(unknown)"),
            info.location().map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
                .unwrap_or_else(|| "(unknown)".into()),
        );
        eprintln!("{}", msg);
        let _ = std::fs::write("/tmp/podcut_panic.log", &msg);
    }));

    plog!("PodCut starting");
    plog!("  arch     = {}", std::env::consts::ARCH);
    plog!("  HOME     = {}", home_dir());
    plog!("  bin_dir  = {}", bin_dir().display());
    plog!("  ffmpeg   = {} (ok={})", find_ffmpeg(), find_ffmpeg_ok());
    plog!("  whisper  = {:?}", find_whisper_cli());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            setup_status,
            download_tool,
            extract_audio,
            get_audio_duration,
            check_model,
            download_model,
            detect_silences,
            split_audio_track,
            export_audio,
            diagnose_env,
            transcribe_streaming,
            check_ollama,
            check_whisperx,
            diarize_whisperx,
            call_claude_api,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application")
}

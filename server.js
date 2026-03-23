const { execSync, exec } = require("child_process");
// ... (keep your other imports: express, fetch, fs, path, etc.)

// Helper to get video metadata (Duration, Width, Height)
function getMetadata(filePath) {
  const cmd = `ffprobe -v error -select_streams v:0 -show_entries stream=width,height,duration -of csv=p=0 "${filePath}"`;
  const metadata = execSync(cmd).toString().trim().split(",");
  return {
    width: parseInt(metadata[0]),
    height: parseInt(metadata[1]),
    duration: parseFloat(metadata[2])
  };
}

app.post("/merge", async (req, res) => {
  let tmpDir;
  try {
    const sources = req.body.sources; 
    const glitchDuration = 0.5; // Fixed glitch speed
    let outputName = req.body.outputName || `flexible-merge-${Date.now()}.mp4`;

    tmpDir = fs.mkdtempSync(path.join("/tmp/", "merge-"));
    const files = [];
    const inputArgs = [];

    // 1) Download and Probe
    for (let i = 0; i < sources.length; i++) {
      const dest = path.join(tmpDir, `v${i}.mp4`);
      await downloadFile(sources[i], dest);
      const meta = getMetadata(dest);
      files.push({ path: dest, ...meta });
      inputArgs.push(`-i "${dest}"`);
    }

    // 2) Build Dynamic Filter
    // We use the first video's resolution as the master target
    const targetW = files[0].width;
    const targetH = files[0].height;

    let filterComplex = "";
    // Step A: Scale all inputs to match Video 0
    for (let i = 0; i < files.length; i++) {
      filterComplex += `[${i}:v]scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2[v${i}]; `;
    }

    // Step B: Chain XFADE with dynamic offsets
    let lastVideoOut = "[v0]";
    let currentOffset = 0;

    for (let i = 1; i < files.length; i++) {
      // Offset is the cumulative duration of all previous videos MINUS the overlaps
      currentOffset += files[i-1].duration - glitchDuration;
      const nextOut = `[v_mix_${i}]`;
      const isLast = (i === files.length - 1);
      
      filterComplex += `${lastVideoOut}[v${i}]xfade=transition=glitch:duration=${glitchDuration}:offset=${currentOffset}${isLast ? '[vfinal]' : nextOut}; `;
      lastVideoOut = nextOut;
    }

    // Step C: Audio Concat
    let audioIn = "";
    for (let i = 0; i < files.length; i++) audioIn += `[${i}:a]`;
    filterComplex += `${audioIn}concat=n=${files.length}:v=0:a=1[afinal]`;

    // 3) Execute
    const outputPath = path.join(tmpDir, outputName);
    const ffmpegCmd = `ffmpeg -y ${inputArgs.join(" ")} -filter_complex "${filterComplex}" -map "[vfinal]" -map "[afinal]" -c:v libx264 -preset superfast -pix_fmt yuv420p "${outputPath}"`;

    await runCmd(ffmpegCmd);

    // ... (GCS Upload & Signed URL logic remains same)
    
    return res.json({ url: signedUrl, totalDuration: currentOffset + files[files.length-1].duration });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true });
  }
});

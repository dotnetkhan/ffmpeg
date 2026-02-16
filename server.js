const express = require("express");
const fetch = require("node-fetch");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const { Storage } = require("@google-cloud/storage");
const { promisify } = require("util");
const streamPipeline = promisify(require("stream").pipeline);

const app = express();
app.use(express.json());

const BUCKET = process.env.OUTPUT_BUCKET; // set via Cloud Run env
const storage = new Storage();

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  await streamPipeline(res.body, fs.createWriteStream(destPath));
}

function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, (err, stdout, stderr) => {
      if (err) return reject({ err, stdout, stderr });
      resolve({ stdout, stderr });
    });
  });
}

app.post("/merge", async (req, res) => {
  try {
    const sources = req.body.sources;
    let outputName = req.body.outputName || `merged-${Date.now()}.mp4`;

    if (!Array.isArray(sources) || sources.length < 1) {
      return res.status(400).json({ error: "Provide sources: [url1, url2, ...]" });
    }

    const tmpDir = fs.mkdtempSync(path.join("/tmp/", "merge-"));
    const files = [];

    // 1) Download each source
    for (let i = 0; i < sources.length; i++) {
      const url = sources[i];
      const dest = path.join(tmpDir, `input-${i}.mp4`);
      await downloadFile(url, dest);
      files.push(dest);
    }

    // 2) Create concat list file (ffmpeg concat demuxer)
    const listPath = path.join(tmpDir, "list.txt");
    const listContent = files.map(f => `file '${f}'`).join("\n");
    fs.writeFileSync(listPath, listContent);

    // 3) Run ffmpeg concat
    const outputPath = path.join(tmpDir, outputName);
    // -safe 0 allows absolute paths, -c copy is fast but may fail on differing codecs; fallback below
    try {
      await runCmd(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -c copy "${outputPath}"`);
    } catch (firstErr) {
      // fallback: re-encode to ensure compatibility
      await runCmd(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -c:v libx264 -c:a aac "${outputPath}"`);
    }

    // 4) Upload to GCS
    const bucket = storage.bucket(BUCKET);
    const destFile = bucket.file(outputName);
    await bucket.upload(outputPath, { destination: destFile.name });

    // 5) Create signed URL (valid 1 hour)
    const [url] = await destFile.getSignedUrl({
      action: "read",
      expires: Date.now() + 60 * 60 * 1000,
    });

    // cleanup (best effort)
    try { fs.rmSync(tmpDir, { recursive: true }); } catch (e) {}

    return res.json({ url, outputName });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message || e });
  }
});

app.get("/", (req, res) => res.send("FFmpeg merge service"));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));

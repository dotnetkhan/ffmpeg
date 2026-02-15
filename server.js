const express = require("express");
const { exec } = require("child_process");
const app = express();

app.use(express.json());

app.post("/process", (req, res) => {
  exec("ffmpeg -version", (err, stdout) => {
    if (err) return res.status(500).send("Error");
    res.send(stdout);
  });
});

app.listen(process.env.PORT || 8080);

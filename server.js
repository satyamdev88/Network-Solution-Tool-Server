const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { exec } = require("child_process");
const { spawn } = require("child_process");
const net = require("net");
const dgram = require("dgram");

const app = express();
// const port = 3000;
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(bodyParser.json());

let pingProcesses = {};
const pingStats = {};
let currentTracerouteProcess = null;

function getPingOnceCommand(ip) {
  const isWindows = process.platform === "win32";
  return isWindows ? `ping -n 1 ${ip}` : `ping -c 1 ${ip}`;
}

app.post("/ping-once", (req, res) => {
  const ip = req.body.ip;
  if (!ip) return res.status(400).json({ error: "IP address is required" });

  const command = getPingOnceCommand(ip);

  exec(command, (error, stdout, stderr) => {
    console.log("Command:", command);
    console.log("stdout:", stdout);
    console.log("stderr:", stderr);
    console.log("error:", error);
    if (error) {
      return res.status(500).json({ error: stderr || error.message });
    }

    res.send(stdout);
  });
});
app.get("/ping-stream", (req, res) => {
  const ip = req.query.ip;
  const clientId = req.query.id;

  if (!ip || !clientId) return res.status(400).end("IP and ID are required");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const isWindows = process.platform === "win32";
  const args = isWindows ? ["-t", ip] : [ip];
  const ping = spawn("ping", args);

  pingProcesses[clientId] = ping;

  pingStats[clientId] = {
    sent: 0,
    received: 0,
    times: [],
  };

  let buffer = "";

  ping.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      res.write(`data: ${trimmed}\n\n`);
      if (/time[=<]\d+ms/.test(trimmed)) {
        pingStats[clientId].sent += 1;
        pingStats[clientId].received += 1;
        const timeMatch = trimmed.match(/time[=<](\d+)/);
        if (timeMatch) pingStats[clientId].times.push(Number(timeMatch[1]));
      } else if (/Request timed out/.test(trimmed)) {
        pingStats[clientId].sent += 1;
      }
    });
  });

  ping.stderr.on("data", (data) => {
    res.write(`data: Error: ${data.toString()}\n\n`);
  });

  ping.on("close", () => {
    res.end();
  });

  req.on("close", () => {
    if (pingProcesses[clientId]) {
      pingProcesses[clientId].kill();
      delete pingProcesses[clientId];
    }
  });
});

app.post("/ping-stop", (req, res) => {
  const clientId = req.body.id;

  const pingProcess = pingProcesses[clientId];

  if (pingProcess) {
    pingProcess.kill();
    delete pingProcesses[clientId];

    const stats = pingStats[clientId];
    delete pingStats[clientId];

    if (!stats) return res.send("Ping process stopped");

    const { sent, received, times } = stats;
    const lost = sent - received;
    const lossRate = ((lost / sent) * 100).toFixed(2);

    const min = Math.min(...times);
    const max = Math.max(...times);
    const avg = times.reduce((a, b) => a + b, 0) / times.length || 0;

    const summary = `
Ping statistics:
  Packets: Sent = ${sent}, Received = ${received}, Lost = ${lost} (${lossRate}% loss),
  Minimum = ${min}ms, Maximum = ${max}ms, Average = ${avg.toFixed(2)}ms`;

    res.send(summary);
  } else {
    res.status(404).send("No running ping for this ID");
  }
});

// =======================Port Checker==========================
app.get("/check-port", (req, res) => {
  const { ip, port, protocol } = req.query;

  if (!ip || !port || !protocol) {
    return res
      .status(400)
      .json({ error: "IP, port, and protocol are required" });
  }

  if (protocol === "tcp") {
    const socket = new net.Socket();
    socket.setTimeout(3000); // 3 seconds timeout

    socket.on("connect", () => {
      socket.destroy();
      res.json({ ip, port, protocol, status: "open" });
    });

    socket.on("timeout", () => {
      socket.destroy();
      res.json({ ip, port, protocol, status: "closed (timeout)" });
    });

    socket.on("error", () => {
      socket.destroy();
      res.json({ ip, port, protocol, status: "closed" });
    });

    socket.connect(port, ip);
  } else if (protocol === "udp") {
    const client = dgram.createSocket("udp4");
    const message = Buffer.from("ping");

    const timeout = setTimeout(() => {
      client.close();
      res.json({ ip, port, protocol, status: "closed (timeout)" });
    }, 3000);

    client.send(message, 0, message.length, port, ip, (err) => {
      if (err) {
        clearTimeout(timeout);
        client.close();
        return res.json({ ip, port, protocol, status: "closed (error)" });
      }
    });

    client.on("message", () => {
      clearTimeout(timeout);
      client.close();
      res.json({ ip, port, protocol, status: "open" });
    });

    client.on("error", () => {
      clearTimeout(timeout);
      client.close();
      res.json({ ip, port, protocol, status: "closed (error)" });
    });
  } else {
    return res.status(400).json({ error: "Invalid protocol. Use tcp or udp." });
  }
});

// =======================Traceroute Checker==========================
app.get("/traceroute-stream", (req, res) => {
  const ip = req.query.ip;
  if (!ip) return res.status(400).end("IP is required");

  const isWindows = process.platform === "win32";
  const cmd = isWindows ? "tracert" : "traceroute";
  const traceroute = spawn(cmd, [ip]);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  traceroute.stdout.on("data", (data) => {
    const lines = data.toString().split(/\r?\n/);
    lines.forEach((line) => {
      if (line.trim()) {
        res.write(`data: ${line.trim()}\n\n`);
      }
    });
  });

  traceroute.stderr.on("data", (data) => {
    res.write(`data: ERROR: ${data.toString().trim()}\n\n`);
  });

  traceroute.on("close", () => {
    res.write(`data: Traceroute completed\n\n`);
    res.end();
  });

  req.on("close", () => {
    traceroute.kill();
    res.end();
  });
});
app.get("/stop-traceroute", (req, res) => {
  if (currentTracerouteProcess) {
    currentTracerouteProcess.kill();
    currentTracerouteProcess = null;
    res.send({ status: "stopped" });
  } else {
    res.send({ status: "no process running" });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

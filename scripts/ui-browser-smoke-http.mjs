export function sendFixtureFailure(res, error) {
  console.error("UI smoke fixture request failed:", error);
  res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" });
  res.end("fixture request failed");
}

// Generates docs/og-image.png (1200x630) for the GitHub Pages site.
// Uses sharp from the memos website install: run with
//   node scripts/gen-og-image.js
const path = require("path");
const sharp = require(path.join(
  process.env.HOME || process.env.USERPROFILE,
  "memos/website/node_modules/sharp"
));
const fs = require("fs");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="glow" cx="50%" cy="0%" r="75%">
      <stop offset="0%" stop-color="rgba(0,114,245,0.10)"/>
      <stop offset="100%" stop-color="rgba(0,114,245,0)"/>
    </radialGradient>
  </defs>

  <rect width="1200" height="630" fill="#ffffff"/>
  <ellipse cx="600" cy="-60" rx="560" ry="330" fill="url(#glow)"/>

  <!-- brand row -->
  <g transform="translate(400, 84)">
    <text x="0" y="42" font-family="Segoe UI, system-ui, sans-serif" font-size="40" fill="#171717">🔌</text>
    <text x="56" y="42" font-family="Segoe UI, system-ui, sans-serif" font-size="34" font-weight="600" fill="#171717" letter-spacing="-0.5">Universal MCP Toolkit</text>
  </g>

  <!-- headline -->
  <text x="600" y="286" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="64" font-weight="700" fill="#171717" letter-spacing="-2">28 MCP servers.</text>
  <text x="600" y="362" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="64" font-weight="700" fill="#666666" letter-spacing="-2">One CLI.</text>

  <!-- sub -->
  <text x="600" y="428" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="25" fill="#666666">Transport · Registry · Routing — production-ready MCP in one monorepo</text>

  <!-- pills -->
  <g font-family="Consolas, monospace" font-size="20" fill="#4d4d4d">
    <rect x="330" y="478" width="120" height="48" rx="10" fill="none" stroke="rgba(0,0,0,0.15)"/>
    <text x="390" y="509" text-anchor="middle">stdio</text>
    <rect x="466" y="478" width="150" height="48" rx="10" fill="none" stroke="rgba(0,0,0,0.15)"/>
    <text x="541" y="509" text-anchor="middle">http + sse</text>
    <rect x="632" y="478" width="238" height="48" rx="10" fill="none" stroke="rgba(0,0,0,0.15)"/>
    <text x="751" y="509" text-anchor="middle">claude desktop ready</text>
  </g>
</svg>`;

const out = path.join(__dirname, "..", "docs", "og-image.png");
sharp(Buffer.from(svg))
  .png()
  .toFile(out)
  .then((info) => console.log(`wrote ${out} (${info.width}x${info.height}, ${info.size} bytes)`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

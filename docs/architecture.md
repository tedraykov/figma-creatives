# Architecture

```mermaid
flowchart LR
  subgraph Clients
    N8N[n8n workflow]
    UI[Browser UI<br/>public/index.html]
  end

  subgraph Service["Node service (Docker)"]
    SRV[server.js<br/>Express, API key auth]
    CFG[config.js<br/>integrations, projects, API keys]
    REG[integrations/index.js<br/>registry, one adapter per integration]
    LAY[layout.js<br/>planFrame, buildHtml,<br/>listFields, lintFrame]
    REN[render.js<br/>Chromium, semaphore]
    FP[integrations/figma.js + frames.js<br/>Figma frame source, cache]
    SP[integrations/static.js<br/>reads a local folder]
  end

  FIG[(Figma REST API)]
  FS[(samples/<br/>tpl/ratio.json + PNGs)]
  DATA[(DATA_DIR volume<br/>config.json)]
  GD[(Google Drive)]

  UI -- "/, static files (public)" --> SRV
  UI -- "/config /templates /render" --> SRV
  N8N -- "POST /render" --> SRV
  N8N --> GD

  SRV --> CFG
  CFG <--> DATA
  SRV --> REG
  REG -- "project's integration" --> FP
  REG -- "project's integration" --> SP
  REG -- "project's integration" --> CV[integrations/canva.js<br/>autofill + export]
  CV --> CANVA[(Canva Connect API)]
  FP --> FIG
  SP --> FS
  SRV --> LAY
  LAY -- "HTML" --> REN
  REN -- "PNG / JPG / WebP" --> SRV

  SNAP[scripts/snapshot-figma.mjs] -. "one-off copy" .-> FP
  SNAP -.-> FS
```

## Render request

```mermaid
sequenceDiagram
  participant C as Client (n8n / UI)
  participant S as server.js
  participant P as Integration
  participant L as layout.js
  participant R as render.js

  C->>S: POST /render {template, ratio, data}
  S->>P: listTemplates, then getFrames(frame id)
  S->>L: planFrame(frame, data)
  S->>P: exportNodes(static layer ids)
  S->>L: buildHtml(frame, ops, exports)
  S->>R: renderHtml(html, size, scale, format)
  R-->>S: image + report (shrunk text)
  S-->>C: binary image + X-Render-* headers
```

## Integration interface

`parseSource`, `check`, `listTemplates`, `render`, optional `html` for live preview, `clearCache` (see `src/integrations/index.js`).
A request's project decides the integration; with no project given, the default project is used.

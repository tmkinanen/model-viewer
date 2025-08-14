# DSharp Model Viewer

A minimal web app to visualize a DSharp‑like UML project structure. It shows models/submodels, renders class nodes, and draws references. Classes referenced from other models appear as “visiting” with dashed borders. You can drag class boxes in the diagram to rearrange them; the layout is remembered per model during your session. The diagram supports pan/zoom (mouse wheel to zoom, drag background to pan), plus controls: +, −, 100%, Fit, and Arrange. Arrange cycles through a few automatic layouts (Auto/Force, Grid, Circle, Hierarchical). On first open of a model, the view is automatically zoomed to fit.

Classes are colored by Peter Coad’s Object Modeling in Color archetypes: Party/Place/Thing (green), Role (yellow), Description (blue), Moment-Interval (pink). When loading a DSharp _Content export, the viewer reads Class details (…_CLASS_DETAILS.json) and uses the explicit Archetype there; it falls back to a name-based heuristic only if metadata is missing. Visiting classes keep a dashed border but retain their archetype color.

Attributes (lazy): Each class box has a +/− toggle in the top-right. Click + to expand the box and reveal its attributes; click − to collapse. Attributes are parsed from DSharp _Content (Attribute mementos) and rendered on demand. The initial model render avoids drawing attributes to keep the view fast; you can expand only the classes you care about. The diagram re-routes orthogonal edges and adjusts to avoid overlaps when boxes are expanded.

Visiting class logic (DSharp _Content): when associations (with multiplicities) are available, a diagram only shows a visiting class for a visible local class if the local class “holds the foreign key” to a single opposite instance.

Foreign key direction rule:
- The FK is on side A when the multiplicity at the opposite end (B) is 1 or 0..1. In other words, each A points to at most one B, so A carries a (nullable) FK to B. Example: a 0..1 — 1 association means the 0..1 side holds the FK to the 1 side.
- Many-to-many (e.g., * — *) is omitted by default (noise) unless explicitly placed.
- One-to-one (1 — 1 or 0..1 — 0..1) is omitted by default unless explicitly placed.

Practically: we include the opposite end only when the opposite end’s multiplicity is 1/0..1 relative to the local class. Many-to-many and one-to-one associations are omitted by default (unless the visiting class is explicitly placed on the diagram).

## Run locally

Prerequisites:
- Node.js 18+ (tested with v24)

Steps:
1. Install dependencies (none required).
2. Start the static server:

   npm start

3. Open the app in your browser:

   http://localhost:3000

## Loading a project

You have two options (plus a built-in demo):

Note: After loading, no model is opened automatically. The Root level in the tree is expanded so you can see the first level of models; click a model to open its diagram.

1) Load from local folder
- Click “Load Project Folder” and select your project root (requires a Chromium-based browser that supports `webkitdirectory`).
- The viewer looks for:
  - model.json files containing: { name, classes: [{ id, name, refs: [id or "Path/To/Class"] }] }
  - or JSON class files under classes/*.json with { id, name, refs }

2) Load from Azure DevOps Git
- Simplest: Paste your Repo URL, enter Username and PAT in Settings. The app parses org/project/repo from the URL and authenticates with Basic auth built from username:PAT. The PAT is stored only in your browser (localStorage) and sent per request.
- Fast mode: Use local clone (checkbox in Settings, on by default). The server will perform a shallow git clone to a temporary folder and read JSON files from disk. This is much faster for large repos than fetching each file via REST.
- Fields (in Settings):
  - Repo URL: e.g., https://dev.azure.com/Org/Project/_git/Repo
  - Username: your Azure DevOps username (any non-empty value works; it’s combined with the PAT)
  - PAT: your Azure DevOps PAT (scope: Code Read)
  - Branch (optional): defaults to main; you can also use refs/heads/branchName.
  - Use local clone (faster): enabled by default. Requires git on the server PATH.
- Click “Load from DevOps” on the front page. The server loads files either via a fast local clone or via the Azure DevOps REST API (fallback).

Notes:
- Credentials are user-specific and provided in the browser; the server proxies the request using your per-request PAT and does not store it.
- Endpoint used: GET /api/azdo/items?org=...&project=...&repo=...&ref=... with optional header X-AZDO-PAT (raw PAT) or X-AZDO-Auth (e.g., "Basic base64").

Themes:
- Open Settings and choose Theme (DSharp, Light, or Dark). The selection is stored locally and applied immediately.
- You can switch themes anytime; the UI colors, header, and inputs adapt accordingly.

Demo project:
- Click “Load Demo Project” to load the included data_example/DemoDW - Tutorial 10 dataset. It uses the DSharp _Content format and demonstrates the viewer’s parsing and rendering.

Examples:
- Given Azure DevOps repo URL:
  https://dev.azure.com/DSharpFi/Metsa/_git/Metsa
  - Open Settings, paste the URL, enter Username (e.g., DSharpFi) and your PAT, close Settings, click Load from DevOps.
  - Under the hood, the app will call: /api/azdo/items?org=DSharpFi&project=Metsa&repo=Metsa with header X-AZDO-Auth: Basic base64(username:PAT) and method=git when "Use local clone" is enabled.
- curl example using X-AZDO-Auth (username:PAT) with fast local clone:
  USERNAME="DSharpFi"; PAT="YOUR_PAT"; TOKEN=$(printf "%s:%s" "$USERNAME" "$PAT" | base64)
  curl -H "X-AZDO-Auth: Basic $TOKEN" "http://localhost:3000/api/azdo/items?org=DSharpFi&project=Metsa&repo=Metsa&ref=refs/heads/main&method=git"
- curl example with only PAT (server builds Basic token with empty username):
  curl -H "X-AZDO-PAT: YOUR_PAT" "http://localhost:3000/api/azdo/items?org=DSharpFi&project=Metsa&repo=Metsa&ref=refs/heads/develop&path=/data/_Content&method=git"
- JavaScript fetch example in the browser (same origin) using URL parsing on the client:
  const url = 'https://dev.azure.com/DSharpFi/Metsa/_git/Metsa';
  const m = url.match(/^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/);
  const org = m[1], project = m[2], repo = m[3];
  const token = btoa((localStorage.getItem('azdo_user')||'') + ':' + (localStorage.getItem('azdo_pat')||''));
  fetch(`/api/azdo/items?org=${org}&project=${project}&repo=${repo}&ref=refs/heads/main&path=/&method=git`, { headers: { 'X-AZDO-Auth': 'Basic ' + token }})
    .then(r => r.json())
    .then(({ entries }) => {
      console.log(entries.length, 'files');
    });

## Azure DevOps configuration
- Generate a Personal Access Token (PAT) from Azure DevOps
  - Scope: Code (Read) is sufficient
- Client-side (recommended): Paste your PAT in the UI (it’s stored only in your browser’s localStorage). The PAT is sent to the server only to forward your request to Azure DevOps and is not persisted server-side.
- There is no server-side PAT. Each user must provide PAT from the browser.

  Start the server:
  npm start

## Data format assumptions
- Option A: DSharp export in a _Content folder (see data_example). The app parses Memento JSON files with TypeName="Model"/"Submodel"/"Class"/"Association" and Diagram/Shape mementos for original positions.
  - Submodels are organized by ParentId/ParentTypeName (under the Conceptual model) to build a hierarchy like Admin/Finance.
  - Classes (TypeName="Class") belong to a Submodel (by ParentId) and associations create references between classes (From/To.ReferencedElementId).
- Option B: Simple directory-based project where every folder is a model/submodel node.
  - Classes can be provided either in model.json (inline) or as individual files under classes/*.json.
- A class belongs to the model node it’s defined in, but can be referenced across models.
- References can be by class id or by fully-qualified path like Model/Submodel/ClassName.

## Troubleshooting
- Where to see logs?
  - In-app: Open the “Log” panel under the diagram for a timestamped log of Azure DevOps loads (inputs, request URL, requestId, success/error). Use the Clear button to reset.
  - Browser: Open DevTools Console to see the “[AZDO] Load debug” group with detailed diagnostics.
  - Server: Check the server terminal output for lines prefixed with [azdo:<requestId>] to correlate with the browser request.
  - Alerts: Error dialogs now include the requestId to help correlate with server logs.
- Legacy server message: “Server missing AZDO_PAT environment variable” (HTTP 500)
  - Your server is running an outdated build that required a server-side AZDO_PAT. Restart/deploy the current server (no server PAT required) and try again, or temporarily set AZDO_PAT on the server as a workaround. Then retry with Username and PAT from the browser.
- Success with files=0 (nothing shows)
  - The viewer only loads JSON files. Ensure the branch contains model files (e.g., model.json, classes/*.json, or DSharp _Content/*.json). Try specifying the correct Branch (e.g., develop) and retry. The server now fetches JSON contents per file, so large repos are supported.
- “Unexpected token '\ufeff' … is not valid JSON”
  - Some files may include a UTF‑8 BOM. The viewer now strips BOM automatically on both the server fetch path and in the client parser. If you still see this, share the requestId from the alert so we can investigate the file content type returned by Azure DevOps.
- 401: Missing PAT
  - Enter your PAT in the UI (or send X-AZDO-PAT/X-AZDO-Auth headers).
- 404: Repository not found
  - Check org, project, repo values. If you have multiple repos with similar names, try using the repo ID.
- CORS or auth errors
  - Requests are proxied via the Node server; ensure you’re calling the built-in endpoint /api/azdo/items from the same origin.
- Branch value
  - If no branch is provided, the server uses the repository's default branch. You can enter just the branch name (e.g., develop), a full ref (e.g., refs/heads/develop), a tag (refs/tags/v1), or a commit SHA.

## Deploy to Azure

There are several good options. The simplest is Azure App Service (Linux). This app already listens on `process.env.PORT`, so it works on Azure without code changes.

Option A — Azure App Service (Linux) via Azure Portal
- Prerequisites: An Azure subscription and a Resource Group.
- Create an App Service:
  - Runtime stack: Node 18 LTS (or newer)
  - Region and plan: your choice (Linux plan)
- Deploy code:
  - Quick test: Zip Deploy from the Portal under Deployment Center (upload the repo contents) or link your GitHub repo.
  - Startup command: leave empty (App Service will run `npm start`).
- Browse the site: `https://<your-app-name>.azurewebsites.net`

Option B — Azure App Service via GitHub Actions
- In the Azure Portal > App Service > Deployment Center, choose GitHub and let Azure create a workflow. Or add one manually like below.
- Required GitHub secrets: `AZURE_WEBAPP_PUBLISH_PROFILE` (download from App Service > Overview > Get publish profile).
- Example `.github/workflows/deploy.yml`:

  name: Deploy to Azure Web App
  on:
    push:
      branches: [ main ]
  jobs:
    build-and-deploy:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - uses: actions/setup-node@v4
          with:
            node-version: '18'
        - run: npm ci || true
        - uses: azure/webapps-deploy@v3
          with:
            app-name: YOUR_WEBAPP_NAME
            publish-profile: ${{ secrets.AZURE_WEBAPP_PUBLISH_PROFILE }}
            package: .

Option C — Azure DevOps Pipelines to Azure App Service
- Create a service connection to your Azure subscription.
- Minimal `azure-pipelines.yml`:

  trigger:
    - main
  pool:
    vmImage: 'ubuntu-latest'
  steps:
    - task: NodeTool@0
      inputs:
        versionSpec: '18.x'
    - script: |
        npm ci || true
      displayName: 'Install'
    - task: ArchiveFiles@2
      inputs:
        rootFolderOrFile: '$(Build.SourcesDirectory)'
        includeRootFolder: false
        archiveType: 'zip'
        archiveFile: '$(Build.ArtifactStagingDirectory)/site.zip'
        replaceExistingArchive: true
    - task: AzureWebApp@1
      inputs:
        azureSubscription: '<Your Service Connection>'
        appName: '<Your App Service Name>'
        package: '$(Build.ArtifactStagingDirectory)/site.zip'

Option D — Azure App Service for Containers or Azure Container Apps
- A minimal Dockerfile is included. Build and push an image:
  - docker build -t yourregistry.azurecr.io/model-viewer:latest .
  - docker push yourregistry.azurecr.io/model-viewer:latest
- Create an App Service (Docker) or a Container App pointing to that image. No env vars are required for auth; users provide PAT from the browser.

Notes
- Authentication: This app does not require a server-side PAT. Each user enters their Username + PAT in Settings; the browser sends it per request to the server proxy.
- Default port: Azure sets the `PORT` environment variable; the server will bind to it automatically.
- Node version: If needed, set App Service > Configuration > General Settings to Node 18.
- Static Web Apps: Not recommended here because the viewer relies on a server endpoint `/api/azdo/items` for Azure DevOps access.

## Scripts
- start: node index.js

## License
Private/internal use example.

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

You have two options:

1) Load from local folder
- Click “Load Project Folder” and select your project root (requires a Chromium-based browser that supports `webkitdirectory`).
- The viewer looks for:
  - model.json files containing: { name, classes: [{ id, name, refs: [id or "Path/To/Class"] }] }
  - or JSON class files under classes/*.json with { id, name, refs }

2) Load from Azure DevOps Git
- Set an environment variable AZDO_PAT on the server process with a Personal Access Token that has Code (Read) permission.
- Restart the server if needed.
- In the header, fill:
  - Org: your Azure DevOps organization (e.g., myorg)
  - Project: your project name (e.g., MyProject)
  - Repository: repo name (or GUID id)
  - Branch (optional): defaults to main; you can also use refs/heads/branchName.
- Click “Load from DevOps”. The server calls Azure DevOps REST API and returns repository files to the frontend for parsing.

Notes:
- Credentials are never sent to the browser; the server makes the API call using AZDO_PAT.
- Endpoint used: GET /api/azdo/items?org=...&project=...&repo=...&ref=... (server-side only)

## Azure DevOps configuration
- Generate a Personal Access Token (PAT) from Azure DevOps
  - Scope: Code (Read) is sufficient
- Export the PAT before starting the app:

  On macOS/Linux:
  export AZDO_PAT=your_pat_here
  npm start

  On Windows PowerShell:
  $env:AZDO_PAT = "your_pat_here"
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
- 500: Server missing AZDO_PAT environment variable
  - Set AZDO_PAT and restart the server.
- 404: Repository not found
  - Check org, project, repo values. If you have multiple repos with similar names, try using the repo ID.
- CORS or auth errors
  - Requests are proxied via the Node server; ensure you’re calling the built-in endpoint /api/azdo/items from the same origin.
- Branch value
  - The UI defaults to refs/heads/main if no branch is provided; you can enter just the branch name (e.g., develop) or a full ref (e.g., refs/heads/develop).

## Scripts
- start: node index.js

## License
Private/internal use example.

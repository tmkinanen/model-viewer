const http = require('http');
const fs = require('fs');
const path = require('path');

const port = process.env.PORT || 3000;
const root = path.resolve(__dirname);

const mime = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=UTF-8',
  '.ico': 'image/x-icon',
};

const https = require('https');
const os = require('os');
const { exec } = require('child_process');

// In-memory progress store for long-running operations
const _progress = new Map(); // requestId -> { percent, msg, ts }
function setProgress(id, percent, msg){
  if (!id) return;
  const p = Math.max(0, Math.min(100, Math.floor(percent)));
  _progress.set(id, { percent: p, msg: msg || '', ts: Date.now() });
}
function getProgress(id){
  const v = _progress.get(id);
  if (!v) return { percent: 0, msg: '' };
  return v;
}
function clearProgress(id){
  if (!id) return; _progress.delete(id);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(u.pathname);

  // API: Progress polling
  if (pathname === '/api/azdo/progress') {
    const requestId = u.searchParams.get('requestId') || u.searchParams.get('id') || '';
    const body = { requestId, ...getProgress(requestId) };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    return;
  }

  // API: Demo project loader (reads from local data_example/DemoDW - Tutorial 10)
  if (pathname === '/api/demo') {
    try {
      const demoDir = path.join(root, 'data_example', 'DemoDW - Tutorial 10');
      if (!fs.existsSync(demoDir)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Demo directory not found', path: demoDir }));
        return;
      }
      // Recursively collect JSON files
      const entries = [];
      function walk(dir){
        let list;
        try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const ent of list) {
          const full = path.join(dir, ent.name);
          if (ent.isDirectory()) { walk(full); continue; }
          if (/\.json$/i.test(ent.name)) {
            try {
              const rel = path.relative(demoDir, full).split(path.sep).join('/');
              const text = fs.readFileSync(full, 'utf8');
              entries.push({ path: rel, text });
            } catch {}
          }
        }
      }
      walk(demoDir);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entries }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || String(e) }));
    }
    return;
  }

  // API: Azure DevOps Git proxy
  if (pathname === '/api/azdo/items') {
    const requestId = u.searchParams.get('cid') || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
    const org = u.searchParams.get('org');
    const project = u.searchParams.get('project');
    const repo = u.searchParams.get('repo'); // name or id
    const ref = u.searchParams.get('ref') || 'refs/heads/main'; // branch or commit; default main
    const scopePath = u.searchParams.get('path') || '/';
    const method = (u.searchParams.get('method') || '').toLowerCase(); // '', 'git'
    // Authentication: require per-request credentials from the client.
    // Accept either a raw PAT in X-AZDO-PAT or a full Basic header value in X-AZDO-Auth
    const headerPat = req.headers['x-azdo-pat'];
    const headerAuth = req.headers['x-azdo-auth'];

    function log(...args){
      console.log(`[azdo:${requestId}]`, ...args);
    }

    if (!org || !project || !repo) {
      const msg = 'Missing required params: org, project, repo';
      log('400', msg, { org, project, repo });
      res.writeHead(400, { 'Content-Type': 'application/json', 'X-Request-Id': requestId });
      res.end(JSON.stringify({ error: msg, requestId }));
      return;
    }
    let azdoAuthHeader = '';
    if (typeof headerAuth === 'string' && headerAuth.trim()) {
      // Use as-is (should be like: Basic base64)
      azdoAuthHeader = headerAuth.trim();
    } else if (typeof headerPat === 'string' && headerPat.trim()) {
      const pat = headerPat.trim();
      azdoAuthHeader = 'Basic ' + Buffer.from(':' + pat).toString('base64');
    } else {
      const msg = 'Missing Azure DevOps credentials. Provide them via X-AZDO-PAT (raw PAT) or X-AZDO-Auth (e.g., "Basic base64(username:PAT)").';
      log('401', msg, { haveXAzdoPat: !!headerPat, haveXAzdoAuth: !!headerAuth });
      res.writeHead(401, { 'Content-Type': 'application/json', 'X-Request-Id': requestId });
      res.end(JSON.stringify({ error: msg, requestId, details: { haveXAzdoPat: !!headerPat, haveXAzdoAuth: !!headerAuth } }));
      return;
    }

    const auth = azdoAuthHeader.replace(/^Basic\s+/i,'');

    // Log basic diagnostic about auth without leaking secrets
    try {
      const decoded = Buffer.from(auth, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const user = sep >= 0 ? decoded.slice(0, sep) : '';
      const pat = sep >= 0 ? decoded.slice(sep + 1) : '';
      log('Request params', { org, project, repo, ref, scopePath, authType: headerAuth ? 'X-AZDO-Auth' : 'X-AZDO-PAT', hasUsername: !!user, patLength: pat ? pat.length : 0 });
    } catch {
      log('Auth decoding failed (still proceeding)');
    }

    function requestJson(options) {
      return new Promise((resolve, reject) => {
        const req = https.request(options, (resp) => {
          let data = '';
          resp.on('data', (chunk) => (data += chunk));
          resp.on('end', () => {
            const status = resp.statusCode || 0;
            const ctype = (resp.headers && (resp.headers['content-type'] || resp.headers['Content-Type'])) || '';
            if (status >= 200 && status < 300) {
              // Prefer JSON when content-type is JSON; otherwise, try JSON then fall back to raw text
              const isJson = /application\/json/i.test(ctype);
              if (isJson) {
                try { return resolve(JSON.parse(data)); } catch (e) { return reject(e); }
              }
              try { return resolve(JSON.parse(data)); } catch {
                // Non-JSON successful response: return raw body so caller can interpret (e.g., file content)
                return resolve({ __raw: true, body: data });
              }
            } else {
              const bodyPreview = (data || '').slice(0, 512);
              return reject(new Error(`Azure DevOps API error ${status}: ${bodyPreview}`));
            }
          });
        });
        req.on('error', reject);
        req.end();
      });
    }

    async function getRepoId() {
      // If repo looks like a GUID, use it as-is (cannot infer default branch here)
      if (/^[0-9a-fA-F-]{36}$/.test(repo)) return { id: repo, defaultBranch: null };
      const pathRepos = `/` + encodeURIComponent(org) + `/${encodeURIComponent(project)}` + `/` + `_apis/git/repositories?api-version=7.1-preview.1`;
      const opts = {
        method: 'GET',
        hostname: 'dev.azure.com',
        path: pathRepos,
        headers: { Authorization: `Basic ${auth}` }
      };
      log('GET', `https://dev.azure.com${pathRepos}`);
      const json = await requestJson(opts);
      const match = (json.value || []).find(r => r.name === repo);
      if (!match) throw new Error(`Repository not found: ${repo} (org=${org}, project=${project})`);
      return { id: match.id, defaultBranch: match.defaultBranch || null };
    }

    (async () => {
      try {
        setProgress(requestId, 1, 'Starting…');
        setProgress(requestId, 2, 'Resolving repository…');
                const repoInfo = await getRepoId();
        const repoId = typeof repoInfo === 'string' ? repoInfo : repoInfo.id;
        const repoDefaultBranch = typeof repoInfo === 'object' && repoInfo && repoInfo.defaultBranch ? repoInfo.defaultBranch : null;

        // Normalize ref and decide version type
        let version = ref || repoDefaultBranch || 'main';
        let versionType = 'branch';
        if (/^refs\/heads\//i.test(version)) {
          version = version.replace(/^refs\/heads\//i, '');
          versionType = 'branch';
        } else if (/^refs\/tags\//i.test(version)) {
          version = version.replace(/^refs\/tags\//i, '');
          versionType = 'tag';
        } else if (/^[0-9a-f]{40}$/i.test(version)) {
          versionType = 'commit';
        } else {
          versionType = 'branch';
        }
        log('Ref resolution', { providedRef: ref || null, repoDefaultBranch, using: { version, versionType }, method: method || 'rest' });

        // If method=git is requested, try fast local clone strategy
        if (method === 'git') {
                  setProgress(requestId, 5, 'Reading files…');
          // During clone, advance progress slowly from 5% to 50% so the user sees activity
          let tickPct = 5;
          const cloneTicker = setInterval(() => {
            tickPct = Math.min(50, tickPct + 1);
            setProgress(requestId, tickPct, 'Reading files…');
            if (tickPct >= 50) { try { clearInterval(cloneTicker); } catch {} }
          }, 500);
          const t0 = Date.now();
          // Derive username and pat from auth header
          let user = 'pat';
          let pat = '';
          try {
            const decoded = Buffer.from(auth, 'base64').toString('utf8');
            const sep = decoded.indexOf(':');
            user = sep >= 0 ? (decoded.slice(0, sep) || 'pat') : 'pat';
            pat = sep >= 0 ? decoded.slice(sep + 1) : decoded;
          } catch {}
          if (!pat) throw new Error('Missing PAT for git clone');
          const remote = `https://${encodeURIComponent(user)}:${encodeURIComponent(pat)}@dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;
          // Create temp dir
          const base = fs.mkdtempSync(path.join(os.tmpdir(), 'model-viewer-'));
          const cloneDir = path.join(base, 'repo');
          const redactedRemote = remote.replace(/:[^@]*@/, ':***@');
          log('Clone start', { dir: cloneDir, remote: redactedRemote });
          const execAsync = (cmd, opts={}) => new Promise((resolve, reject) => {
            exec(cmd, { ...opts }, (err, stdout, stderr) => {
              if (err) return reject(new Error(stderr || err.message));
              resolve({ stdout, stderr });
            });
          });
          try {
            // Shallow clone
            if (versionType === 'branch' || versionType === 'tag') {
              await execAsync(`git clone --depth=1 --branch ${version} ${remote} "${cloneDir}"`, { timeout: 120000 });
            } else {
              // commit: clone default and fetch that commit shallowly
              await execAsync(`git clone --depth=1 ${remote} "${cloneDir}"`, { timeout: 120000 });
              await execAsync(`git -C "${cloneDir}" fetch --depth=1 origin ${version}`, { timeout: 120000 });
              await execAsync(`git -C "${cloneDir}" checkout ${version}`, { timeout: 120000 });
            }
            const elapsedClone = Date.now() - t0;
            log('Clone done', { ms: elapsedClone });
            try { clearInterval(cloneTicker); } catch {}
            setProgress(requestId, Math.max(55, tickPct), 'Scanning repository…');
            // Walk filesystem and collect JSON files
            const entries = [];
            const rootDir = cloneDir;
            const normScope = (scopePath && scopePath !== '/') ? scopePath.replace(/^\/+/, '') : '';
            const startDir = normScope ? path.join(rootDir, normScope) : rootDir;
            // Log where the clone arrived and what we are going to read
            try {
              const exists = fs.existsSync(startDir);
              let topList = [];
              try { topList = fs.readdirSync(startDir).slice(0, 50); } catch {}
              log('Clone dir ready', { baseDir: base, cloneDir: rootDir, startDir, exists, topEntries: topList.length, sample: topList.slice(0, 10) });
            } catch {}
            // First collect JSON file paths to compute progress
                        const jsonPaths = [];
                        function collect(dir){
                          let list;
                          try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
                          for (const ent of list) {
                            const full = path.join(dir, ent.name);
                            if (ent.isDirectory()) { collect(full); continue; }
                            if (/\.json$/i.test(ent.name)) {
                              jsonPaths.push(full);
                            }
                          }
                        }
                        collect(startDir);
                        setProgress(requestId, 60, 'Reading files…');
                        const total = jsonPaths.length || 1;
                        let processed = 0;
            for (const full of jsonPaths) {
              try {
                const rel = path.relative(rootDir, full).split(path.sep).join('/');
                const text = fs.readFileSync(full, 'utf8');
                entries.push({ path: rel, text });
              } catch {}
              processed++;
              if (processed % 10 === 0 || processed === total) {
                const pct = 60 + Math.floor((processed / total) * 40);
                setProgress(requestId, pct, 'Reading files…');
              }
            }
            try {
              const samplePaths = entries.slice(0, 10).map(e => e.path);
              log('Local read done', { files: entries.length, sample: samplePaths });
            } catch { log('Local read done', { files: entries.length }); }
            setProgress(requestId, 100, 'Done');
            // Cleanup temp dir
            try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
            res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': requestId });
            res.end(JSON.stringify({ entries, requestId }));
            setTimeout(() => clearProgress(requestId), 15000);
            return;
          } catch (cloneErr) {
            // Ensure cleanup and fall back to REST
            try { clearInterval(cloneTicker); } catch {}
            log('Clone failed, falling back to REST', { error: cloneErr.message });
            try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
            // proceed to REST below
          }
        }

        // 1) List items metadata (no content) recursively
        const listParams = new URLSearchParams({
          'api-version': '7.1-preview.1',
          recursionLevel: 'Full',
          scopePath: scopePath || '/',
          versionDescriptor_version: version,
          versionDescriptor_versionType: versionType
        });
        const pathList = `/` + encodeURIComponent(org) + `/${encodeURIComponent(project)}` + `/_apis/git/repositories/${encodeURIComponent(repoId)}/items?` + listParams.toString();
        let opts = {
          method: 'GET',
          hostname: 'dev.azure.com',
          path: pathList,
          headers: { Authorization: `Basic ${auth}` }
        };
        log('GET', `https://dev.azure.com${pathList}`);
        setProgress(requestId, 8, 'Listing repository…');
        const listJson = await requestJson(opts);
        const allItems = Array.isArray(listJson.value) ? listJson.value : [];
        // Determine files more robustly: consider gitObjectType === 'blob' OR isFolder === false (some responses omit isFolder)
        function isFileItem(it){
          if (!it || typeof it !== 'object') return false;
          const t = (it.gitObjectType || it.gitObjectTypeName || '').toString().toLowerCase();
          if (t === 'blob') return true;
          if (t === 'tree') return false;
          if (typeof it.isFolder === 'boolean') return it.isFolder === false;
          // Fallback: treat as file if it has a size or contentMetadata
          if (typeof it.size === 'number' && it.size >= 0) return true;
          if (it.contentMetadata && typeof it.contentMetadata === 'object') return true;
          return false;
        }
        function getItemPath(it){
          return (it && (it.path || it.relativePath || '')) || '';
        }
        const fileItems = allItems.filter(it => isFileItem(it));
        const candidateItems = fileItems.filter(it => /\.json$/i.test(getItemPath(it)));
        // Diagnostics: distribution of gitObjectType
        const typeCounts = allItems.reduce((acc, it) => {
          const t = ((it && it.gitObjectType) || (it && it.gitObjectTypeName) || (it && typeof it.isFolder === 'boolean' ? (it.isFolder ? 'tree' : 'blob') : 'unknown')).toString().toLowerCase();
          acc[t] = (acc[t] || 0) + 1; return acc;
        }, {});
        log('List counts', { total: allItems.length, files: fileItems.length, jsonCandidates: candidateItems.length, typeCounts });
        setProgress(requestId, 12, 'Fetching files…');

        // 2) Fetch content for candidates concurrently
        async function fetchFileContent(itemPath) {
          const fp = `/` + encodeURIComponent(org) + `/${encodeURIComponent(project)}` + `/_apis/git/repositories/${encodeURIComponent(repoId)}/items?` + new URLSearchParams({
            'api-version': '7.1-preview.1',
            path: itemPath,
            includeContent: 'true',
            versionDescriptor_version: version,
            versionDescriptor_versionType: versionType
          }).toString();
          const o = {
            method: 'GET',
            hostname: 'dev.azure.com',
            path: fp,
            headers: { Authorization: `Basic ${auth}` }
          };
          const j = await requestJson(o);
          // Two possibilities:
          // 1) JSON item wrapper: { path, content, ... }
          // 2) Raw body (non-JSON): { __raw: true, body: '...' } from requestJson fallback
          if (j && j.__raw) {
            log('Non-JSON content received for file (treating as raw text)', { path: itemPath, bytes: (j.body && j.body.length) || 0 });
            return { path: String(itemPath).replace(/^\//, ''), text: j.body };
          }
          const content = j && (j.content || (Array.isArray(j.value) && j.value[0] && j.value[0].content));
          if (typeof content === 'string') {
            return { path: (j.path || itemPath).replace(/^\//, ''), text: content };
          }
          return null;
        }
        const concurrency = 8;
        const entries = [];
        for (let i = 0; i < candidateItems.length; i += concurrency) {
          const slice = candidateItems.slice(i, i + concurrency);
          const results = await Promise.all(slice.map(it => fetchFileContent(getItemPath(it))));
          for (const r of results) if (r) entries.push(r);
          const processed = Math.min(i + concurrency, candidateItems.length);
          const pct = 12 + Math.floor((processed / Math.max(1, candidateItems.length)) * 86); // up to ~98%
          setProgress(requestId, pct, 'Fetching files…');
        }
        log('Fetched entries', { count: entries.length });

        setProgress(requestId, 100, 'Done');
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': requestId });
        res.end(JSON.stringify({ entries, requestId }));
        setTimeout(() => clearProgress(requestId), 15000);
      } catch (e) {
        log('500 error', e && e.message ? e.message : e);
        setProgress(requestId, 100, 'Error: ' + (e && e.message ? e.message : 'Failed'));
        res.writeHead(500, { 'Content-Type': 'application/json', 'X-Request-Id': requestId });
        res.end(JSON.stringify({ error: e.message || String(e), requestId }));
        setTimeout(() => clearProgress(requestId), 15000);
      }
    })();
    return;
  }

  // Static files
  let filePath = path.join(root, pathname === '/' ? '/index.html' : pathname);

  // Prevent path traversal
  if(!filePath.startsWith(root)){
    res.writeHead(400); res.end('Bad request'); return;
  }

  fs.stat(filePath, (err, stat) => {
    if(err){
      res.writeHead(404); res.end('Not found'); return;
    }
    if(stat.isDirectory()){
      filePath = path.join(filePath, 'index.html');
    }
    fs.readFile(filePath, (err, data) => {
      if(err){ res.writeHead(404); res.end('Not found'); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
});

server.listen(port, () => {
  console.log(`DSharp Model Viewer running at http://localhost:${port}`);
});

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

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(u.pathname);

  // API: Azure DevOps Git proxy
  if (pathname === '/api/azdo/items') {
    const org = u.searchParams.get('org');
    const project = u.searchParams.get('project');
    const repo = u.searchParams.get('repo'); // name or id
    const ref = u.searchParams.get('ref') || 'refs/heads/main'; // branch or commit; default main
    const scopePath = u.searchParams.get('path') || '/';
    const pat = process.env.AZDO_PAT;
    if (!org || !project || !repo) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing required params: org, project, repo' }));
      return;
    }
    if (!pat) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Server missing AZDO_PAT environment variable' }));
      return;
    }

    const auth = Buffer.from(':' + pat).toString('base64');

    function requestJson(options) {
      return new Promise((resolve, reject) => {
        const req = https.request(options, (resp) => {
          let data = '';
          resp.on('data', (chunk) => (data += chunk));
          resp.on('end', () => {
            if (resp.statusCode && resp.statusCode >= 200 && resp.statusCode < 300) {
              try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            } else {
              reject(new Error(`Azure DevOps API error ${resp.statusCode}: ${data}`));
            }
          });
        });
        req.on('error', reject);
        req.end();
      });
    }

    async function getRepoId() {
      // If repo looks like a GUID, use it as-is
      if (/^[0-9a-fA-F-]{36}$/.test(repo)) return repo;
      const pathRepos = `/` + encodeURIComponent(org) + `/${encodeURIComponent(project)}` + `/` + `_apis/git/repositories?api-version=7.1-preview.1`;
      const opts = {
        method: 'GET',
        hostname: 'dev.azure.com',
        path: pathRepos,
        headers: { Authorization: `Basic ${auth}` }
      };
      const json = await requestJson(opts);
      const match = (json.value || []).find(r => r.name === repo);
      if (!match) throw new Error(`Repository not found: ${repo}`);
      return match.id;
    }

    (async () => {
      try {
        const repoId = await getRepoId();
        // Items API: includeContent true, recursionLevel Full, versionDescriptor for branch
        const params = new URLSearchParams({
          'api-version': '7.1-preview.1',
          includeContent: 'true',
          recursionLevel: 'Full',
          scopePath: scopePath || '/',
          versionDescriptor_version: ref,
          versionDescriptor_versionType: 'branch'
        });
        const pathItems = `/` + encodeURIComponent(org) + `/${encodeURIComponent(project)}` + `/_apis/git/repositories/${encodeURIComponent(repoId)}/items?` + params.toString();
        const opts = {
          method: 'GET',
          hostname: 'dev.azure.com',
          path: pathItems,
          headers: { Authorization: `Basic ${auth}` }
        };
        const json = await requestJson(opts);
        // Map items to simple entries, ignore folders and binaries (contentMetadata.encoding may indicate base64)
        const entries = (json.value || [])
          .filter(it => it.isFolder === false && typeof it.content === 'string')
          .map(it => ({ path: it.path.replace(/^\//, ''), text: it.content }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
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

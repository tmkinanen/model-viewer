/* DSharp Model Viewer - Frontend SPA
 Assumptions (can be adapted to real DSharp format):
 - Project is a folder tree; each directory is a Model/Submodel node.
 - Classes:
    Option A: model.json contains { name, classes: [{ id, name, refs: [classId or "Path/To/Class"] }], submodels: [names] }
    Option B: classes/*.json each with { id, name, refs: [...] }
 - A class belongs to the directory (model) where it is defined (homeModelPath).
 - When rendering a model's diagram: show its own classes, plus visiting classes that are referenced by its classes but whose homeModelPath differs.
*/

(function(){
  const folderInput = document.getElementById('folderInput');
  const treeEl = document.getElementById('tree');
  const svg = document.getElementById('svg');
  const modelHeader = document.getElementById('modelHeader');
  const demoBtn = document.getElementById('demoBtn');
  const azUrl = document.getElementById('azUrl');
  const azUser = document.getElementById('azUser');
  const azOrg = document.getElementById('azOrg');
  const azProject = document.getElementById('azProject');
  const azRepo = document.getElementById('azRepo');
  const azRef = document.getElementById('azRef');
  const azPat = document.getElementById('azPat');
  const azUseGit = document.getElementById('azUseGit');
  const azLoadBtn = document.getElementById('azLoadBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const themeSelect = document.getElementById('themeSelect');
  const loadingEl = document.getElementById('loading');
  const loadingMsgEl = loadingEl?.querySelector('.msg');
  const logEl = document.getElementById('log');
  const logClearBtn = document.getElementById('logClearBtn');

  let project = null; // { modelsByPath, classesById, classesByFQN }
  let rootPath = '';
  // Session-scoped saved layouts: modelPath -> { classId -> {x,y} }
  const layouts = new Map();
  // Expanded tree nodes (paths); start empty so nodes are collapsed initially
  const expanded = new Set();
  // Per-model zoom/pan state: modelPath -> { x, y, scale, fitted }
  const zoomStates = new Map();
  // Per-model arrange state: modelPath -> { index }
  const arrangeStates = new Map();
  // Per-model expanded attributes state: modelPath -> Set<classId>
  const expandedAttrs = new Map();

  // Prefill saved creds if available (stored only in this browser)
  try { if (azPat) azPat.value = localStorage.getItem('azdo_pat') || ''; } catch {}
  try { if (azUser) azUser.value = localStorage.getItem('azdo_user') || ''; } catch {}
  try { if (azUrl) azUrl.value = localStorage.getItem('azdo_url') || ''; } catch {}
  try { if (azRef) azRef.value = localStorage.getItem('azdo_ref') || ''; } catch {}
  try { if (azUseGit) azUseGit.checked = (localStorage.getItem('azdo_use_git') || 'true') === 'true'; } catch {}
  // Theme init
  (function(){
    const saved = (()=>{ try { return localStorage.getItem('theme') || 'dsharp'; } catch { return 'dsharp'; } })();
    applyTheme(saved);
    if (themeSelect) themeSelect.value = saved;
  })();

  // Settings toggle
  settingsBtn?.addEventListener('click', () => {
    if (!settingsPanel) return;
    const visible = settingsPanel.style.display !== 'none';
    settingsPanel.style.display = visible ? 'none' : 'block';
  });

  // Theme apply/persist
  function applyTheme(name){
    const t = (name || 'dsharp').toLowerCase();
    try { document.documentElement.setAttribute('data-theme', t); } catch {}
  }
  themeSelect?.addEventListener('change', () => {
    const val = themeSelect.value || 'dsharp';
    applyTheme(val);
    try { localStorage.setItem('theme', val); } catch {}
  });

  // Simple UI logger (privacy-safe)
  function uiLog(message, data){
    if (!logEl) return;
    const ts = new Date().toISOString();
    let line = `[${ts}] ${message}`;
    if (data && typeof data === 'object'){
      try {
        const safe = JSON.stringify(data, (k, v) => {
          if (k.toLowerCase().includes('pat')) return typeof v === 'string' ? `*** (${v.length})` : v;
          if (k.toLowerCase().includes('token')) return '***';
          return v;
        });
        line += ' ' + safe;
      } catch {}
    }
    logEl.textContent += (line + '\n');
    // auto-scroll
    logEl.scrollTop = logEl.scrollHeight;
  }
  function clearLog(){ if (logEl) logEl.textContent = ''; }
  logClearBtn?.addEventListener('click', clearLog);

  // Progress polling for Azure DevOps load
  let _progressTimer = null;
  function startProgressPoll(requestId){
    stopProgressPoll();
    if (!requestId) return;
    _progressTimer = setInterval(async () => {
      try {
        const r = await fetch('/api/azdo/progress?requestId=' + encodeURIComponent(requestId));
        const j = await r.json().catch(()=>null);
        if (j && typeof j.percent === 'number') {
          const msg = j.msg && j.msg.trim() ? j.msg.trim() : 'Loading…';
          updateLoading(msg + ' ' + j.percent + '%');
        }
      } catch {}
    }, 300);
  }
  function stopProgressPoll(){ if (_progressTimer) { clearInterval(_progressTimer); _progressTimer = null; } }

  folderInput.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    try{
      showLoading('Reading project files…');
      rootPath = commonPrefix(files.map(f => f.webkitRelativePath));
      project = await buildProjectFromFiles(files);
      updateLoading('Rendering…');
      // Expand root level and start with no model opened
      expanded.clear();
      try { const rootModel = findRootModelPath(project.modelsByPath); expanded.add(rootModel); } catch {}
      renderTree(project);
      modelHeader.textContent = 'Select a model from the tree…';
      svg.innerHTML = '';
    } finally {
      hideLoading();
    }
  });

  demoBtn.addEventListener('click', async () => {
    try{
      showLoading('Loading demo…');
      // Fetch demo entries from the server (DemoDW - Tutorial 10)
      const resp = await fetch('/api/demo');
      let data;
      try {
        data = await resp.json();
      } catch {
        // Fallback to text if server didn't return JSON
        const text = await resp.text().catch(()=> '');
        data = { error: text || 'Non-JSON response' };
      }
      if (!resp.ok) {
        const status = resp.status;
        const errMsg = (data && data.error) ? data.error : 'Failed to load demo project';
        throw new Error(`${errMsg}${status? ` (HTTP ${status})` : ''}`);
      }
      const entries = (data && data.entries) || [];
      updateLoading('Parsing project…');
      project = await buildProjectFromEntries(entries);
      rootPath = '';
      updateLoading('Rendering…');
      // Expand root level and start with no model opened
      expanded.clear();
      try { const rootModel = findRootModelPath(project.modelsByPath); expanded.add(rootModel); } catch {}
      renderTree(project);
      modelHeader.textContent = 'Select a model from the tree…';
      svg.innerHTML = '';
    } catch(e){
      alert('Demo load failed: ' + (e && e.message ? e.message : String(e)));
    } finally {
      hideLoading();
    }
  });

  azLoadBtn?.addEventListener('click', async () => {
    const url = (azUrl?.value || '').trim();
    const username = (azUser?.value || localStorage.getItem('azdo_user') || '').trim();
    const ref = (azRef?.value || '').trim();
    const pat = (azPat?.value || localStorage.getItem('azdo_pat') || '').trim();

    function parseAzdoRepoUrl(inUrl){
      try{
        const u = new URL(inUrl);
        // Support dev.azure.com URLs
        const host = (u.hostname || '').toLowerCase();
        const parts = u.pathname.split('/').filter(Boolean);
        // Expect .../{org}/{project}/_git/{repo}
        const gitIdx = parts.findIndex(p => p.toLowerCase() === '_git');
        if (host.endsWith('dev.azure.com') && gitIdx >= 0 && gitIdx + 1 < parts.length){
          const org = parts[0];
          const project = parts[1];
          let repo = parts[gitIdx+1] || '';
          repo = repo.replace(/\.git$/i, '');
          return { org, project, repo };
        }
        // Visual Studio legacy: https://{org}.visualstudio.com/{project}/_git/{repo}
        const m = host.match(/^([^.]+)\.visualstudio\.com$/);
        if (m && gitIdx >= 0 && gitIdx + 1 < parts.length){
          const org = m[1];
          const project = parts[0];
          let repo = parts[gitIdx+1] || '';
          repo = repo.replace(/\.git$/i, '');
          return { org, project, repo };
        }
      }catch(e){ /* ignore */ }
      return null;
    }

    const parsed = parseAzdoRepoUrl(url);
    if (!parsed){
      alert('Please paste a valid Azure DevOps Repo URL. Expected format: https://dev.azure.com/{Org}/{Project}/_git/{Repo}');
      return;
    }
    const org = parsed.org;
    const projectName = parsed.project;
    const repo = parsed.repo;
    if(!pat){
      alert('Missing PAT. Enter Username and PAT (stored locally) and try again.');
      return;
    }

    const debug = {
      url,
      parsed: { org, project: projectName, repo },
      ref: ref || '(default main)',
      authType: username && pat ? 'X-AZDO-Auth (Basic username:PAT)' : 'X-AZDO-PAT',
      hasUsername: !!username,
      patLength: pat ? pat.length : 0
    };
    console.groupCollapsed('[AZDO] Load debug');
    console.log('Inputs', debug);
    uiLog('[AZDO] Inputs', debug);

    try{
      showLoading('Fetching from Azure DevOps…');
      const params = new URLSearchParams({ org, project: projectName, repo });
      const cid = 'job-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
      params.set('cid', cid);
      if(ref) params.set('ref', ref);
      if (azUseGit?.checked) params.set('method', 'git');
      const headers = {};
      if (username && pat) {
        const token = btoa(`${username}:${pat}`);
        headers['X-AZDO-Auth'] = 'Basic ' + token;
      } else if (pat) {
        headers['X-AZDO-PAT'] = pat;
      }
      const requestUrl = '/api/azdo/items?' + params.toString();
      console.log('Request', { url: requestUrl, headers: Object.keys(headers) });
      uiLog('[AZDO] Request', { url: requestUrl, headers: Object.keys(headers) });
      startProgressPoll(cid);
      const resp = await fetch(requestUrl, { headers });
      const data = await resp.json().catch(() => ({}));
      const requestId = (resp.headers && resp.headers.get && resp.headers.get('X-Request-Id')) || data.requestId || undefined;
      if(!resp.ok){
        const err = (data && data.error) || 'Failed to load from DevOps';
        console.error('Response error', { status: resp.status, error: err, requestId, details: data && data.details });
        uiLog('[AZDO] Error', { status: resp.status, error: err, requestId, details: data && data.details });
        if (/Server missing AZDO_PAT environment variable/i.test(err)) {
          const ex = new Error('Server is running an outdated build that expects a server-side AZDO_PAT. Please restart/deploy the current server (no server PAT required) and try again, or temporarily set AZDO_PAT on the server as a workaround. Then retry with your Username and PAT.');
          ex.requestId = requestId;
          throw ex;
        }
        if (/Missing Azure DevOps PAT|Missing Azure DevOps credentials/i.test(err)) {
          const ex = new Error('Missing PAT. Enter Username and PAT (stored locally) and try again.');
          ex.requestId = requestId;
          throw ex;
        }
        const ex = new Error(err);
        ex.requestId = requestId;
        throw ex;
      }
      const entries = data.entries || [];
      console.log('Success', { files: entries.length, requestId });
      uiLog('[AZDO] Success', { files: entries.length, requestId });
      if (!entries.length) {
        const msg = 'No JSON files were returned from the repository. Check that the branch exists and contains model files (e.g., model.json, classes/*.json, or _Content/*.json). You can try specifying a different Branch and retry.';
        const ex = new Error(msg);
        ex.requestId = requestId;
        throw ex;
      }
      // Store settings locally on success (optional; can be cleared by user via browser tools)
      try { if (pat) localStorage.setItem('azdo_pat', pat); } catch {}
      try { if (username) localStorage.setItem('azdo_user', username); } catch {}
      try { if (url) localStorage.setItem('azdo_url', url); } catch {}
      try { if (ref) localStorage.setItem('azdo_ref', ref); } catch {}
      try { if (azUseGit) localStorage.setItem('azdo_use_git', azUseGit.checked ? 'true' : 'false'); } catch {}
      updateLoading('Parsing project…');
      project = await buildProjectFromEntries(entries);
      updateLoading('Rendering…');
      // Expand root level and start with no model opened
      expanded.clear();
      try { const rootModel = findRootModelPath(project.modelsByPath); expanded.add(rootModel); } catch {}
      renderTree(project);
      modelHeader.textContent = 'Select a model from the tree…';
      svg.innerHTML = '';
    }catch(e){
      console.error('AZDO load failed', { message: e && e.message, requestId: e && e.requestId });
      uiLog('[AZDO] Load failed', { message: e && e.message, requestId: e && e.requestId });
      const rid = e && e.requestId ? ` (requestId: ${e.requestId})` : '';
      alert('Azure DevOps load failed: ' + (e && e.message ? e.message : String(e)) + rid);
    } finally {
      console.groupEnd?.();
      stopProgressPoll();
      hideLoading();
    }
  });

  function commonPrefix(paths){
    if (!paths.length) return '';
    const partsArr = paths.map(p=>p.split('/'));
    const minLen = Math.min(...partsArr.map(a=>a.length));
    const out=[];
    for(let i=0;i<minLen;i++){
      const x = partsArr[0][i];
      if(partsArr.every(a=>a[i]===x)) out.push(x); else break;
    }
    // If prefix ends with a filename, drop it
    return out.join('/')
  }

  async function buildProjectFromFiles(files){
    // Convert File objects to entries {path, text}
    const entries = [];
    let i = 0;
    for (const f of files) {
      // Read sequentially to keep memory lower; update message occasionally
      const text = await f.text();
      entries.push({ path: f.webkitRelativePath, text });
      i++;
      if (i % 1 === 0) {
        const pct = Math.floor((i / files.length) * 100);
        updateLoading(`Reading files… ${pct}%`);
      }
    }
    return buildProjectFromEntries(entries);
  }

  function stripBOM(s){
    if (typeof s !== 'string') return s;
    // Remove UTF-8 BOM and other zero-width no-breaks at start
    return s.replace(/^\uFEFF/, '');
  }
  function safeParseJson(txt, filePath){
    const cleaned = stripBOM(String(txt));
    try {
      return JSON.parse(cleaned);
    } catch (err) {
      const msg = `Invalid JSON${filePath? ' in '+filePath : ''}: ${err.message}`;
      throw new Error(msg);
    }
  }

  async function buildProjectFromEntries(entries){
    // Normalize virtual filesystem from entries
    updateLoading('Preparing files…');
    const vfs = new Map(); // path -> text
    for(const e of entries){
      if (e && typeof e.path === 'string') vfs.set(e.path, e.text || '');
    }

    // If this looks like a DSharp _Content export, use the specialized parser
    const hasContentFolder = [...vfs.keys()].some(p => /(^|\/)\_?Content\//.test(p));
    if (hasContentFolder) {
      try {
        return buildFromDSharpContent(vfs);
      } catch (err) {
        console.warn('Falling back to generic parser due to _Content parse error:', err);
        // continue to generic folder-based parsing
      }
    }

    // Collect directories
    const dirs = new Set(['']);
    for(const p of vfs.keys()){
      const parts = p.split('/');
      parts.pop();
      let acc='';
      for(const part of parts){
        acc = acc ? acc + '/' + part : part;
        dirs.add(acc);
      }
    }

    // Build models
    const modelsByPath = {};
    for(const dir of dirs){
      modelsByPath[dir] = {
        path: dir,
        name: dir.split('/').filter(Boolean).slice(-1)[0] || 'Root',
        classes: [],
        submodels: [],
      };
    }
    for(const dir of dirs){
      if(!dir) continue;
      const parent = dir.split('/').slice(0,-1).join('/');
      if(modelsByPath[parent]) modelsByPath[parent].submodels.push(dir);
    }

    const classesById = {};
    const classesByFQN = {};

    // model.json files
    for(const [p, txt] of vfs){
      if(p.endsWith('model.json')){
        try{
          const data = safeParseJson(txt, p);
          const dir = p.split('/').slice(0,-1).join('/');
          const model = modelsByPath[dir] || (modelsByPath[dir]={path:dir,name:data.name||dir.split('/').pop()||'Root',classes:[],submodels:[]});
          if(data.name) model.name = data.name;
          if(Array.isArray(data.classes)){
            for(const c of data.classes){
              const id = c.id || makeId(dir + ':' + c.name);
              const cls = { id, name: c.name || id, homeModelPath: dir, refs: Array.isArray(c.refs)? c.refs.slice(): [] };
              classesById[id]=cls;
              classesByFQN[dir + '/' + cls.name] = cls;
              model.classes.push(id);
            }
          }
        }catch(e){ console.warn('Failed to parse', p, e); }
      }
    }
    // classes/*.json files
    for(const [p, txt] of vfs){
      const segs = p.split('/');
      if(segs.length>=2 && segs[segs.length-2]==='classes' && segs[segs.length-1].endsWith('.json')){
        const dir = segs.slice(0,-2).join('/');
        try{
          const c = safeParseJson(txt, p);
          const id = c.id || makeId(dir + ':' + c.name);
          const cls = { id, name: c.name || id, homeModelPath: dir, refs: Array.isArray(c.refs)? c.refs.slice(): [] };
          if(!modelsByPath[dir]) modelsByPath[dir] = { path: dir, name: dir.split('/').pop()||'Root', classes: [], submodels: [] };
          classesById[id]=cls;
          classesByFQN[dir + '/' + cls.name] = cls;
          modelsByPath[dir].classes.push(id);
        }catch(e){ console.warn('Failed to parse class file', p, e); }
      }
    }
    return { modelsByPath, classesById, classesByFQN };
  }

  function buildFromDSharpContent(vfs){
    // vfs: Map<string path, string json>
    // Consider only files under _Content/*.json
    const contentEntries = [...vfs.entries()].filter(([p]) => /(^|\/)\_?Content\//.test(p) && p.endsWith('.json'));
    const elements = new Map(); // id -> obj
    for (const [p, txt] of contentEntries) {
      try {
        const obj = safeParseJson(txt, p);
        if (obj && obj.Id) {
          elements.set(obj.Id, obj);
        }
      } catch (e) {
        // ignore invalid json
      }
    }

    // Collect models and submodels
    const nodeById = new Map();
    for (const obj of elements.values()) {
      if (obj.TypeName === 'Model' || obj.TypeName === 'Submodel' || obj.TypeName === 'Conceptual model') {
        nodeById.set(obj.Id, { id: obj.Id, name: obj.Name || obj.Id, type: obj.TypeName, parentId: obj.ParentId || null });
      }
    }

    // Compute paths for all Submodels under Conceptual model (and nested)
    const pathByNodeId = new Map();

    function buildPath(nodeId){
      if (pathByNodeId.has(nodeId)) return pathByNodeId.get(nodeId);
      const node = nodeById.get(nodeId);
      if (!node) return null;
      // Stop at conceptual model or project
      if (node.type === 'Conceptual model' || node.parentId === 'SYSTEM_PROJECT' || node.parentId === null) {
        const p = node.type === 'Submodel' || node.type === 'Model' ? node.name : '';
        pathByNodeId.set(nodeId, p);
        return p;
      }
      const parent = nodeById.get(node.parentId);
      const parentPath = parent ? buildPath(parent.id) : '';
      const p = parentPath ? (node.name ? parentPath + '/' + node.name : parentPath) : (node.name || '');
      pathByNodeId.set(nodeId, p);
      return p;
    }

    // Prepare modelsByPath structure using only Submodels (models hold multiple submodels, but we visualize submodels tree)
    const modelsByPath = {};
    // include a root
    modelsByPath[''] = { path: '', name: 'Root', classes: [], submodels: [] };

    // First pass: create model entries for each submodel
    for (const n of nodeById.values()) {
      if (n.type !== 'Submodel') continue;
      const path = buildPath(n.id);
      if (path == null || path === '') continue;
      if (!modelsByPath[path]) {
        modelsByPath[path] = { path, name: path.split('/').pop(), classes: [], submodels: [] };
      }
    }
    // Build parent-child links by path
    for (const mPath in modelsByPath) {
      if (!mPath) continue;
      const parentPath = mPath.split('/').slice(0, -1).join('/');
      const p = parentPath; // may be '' for top-level
      if (!modelsByPath[p]) {
        modelsByPath[p] = { path: p, name: p ? p.split('/').pop() : 'Root', classes: [], submodels: [] };
      }
      modelsByPath[p].submodels.push(mPath);
    }

    const classesById = {};
    const classesByFQN = {};

    // Collect class details to extract explicit archetypes (Peter Coad)
    const classDetailsByClassId = new Map(); // classId -> details object
    for (const obj of elements.values()) {
      if (obj.TypeName === 'Class details' && obj.ParentTypeName === 'Class' && obj.ParentId) {
        classDetailsByClassId.set(obj.ParentId, obj);
      }
    }

    function normalizeCoadArchetype(s){
      if (!s || typeof s !== 'string') return null;
      const t = s.trim().toLowerCase();
      if (t.startsWith('party')) return 'ppt';
      if (t === 'role') return 'role';
      if (t.startsWith('moment')) return 'moment';
      if (t === 'description') return 'desc';
      return null;
    }

    // Gather classes and attach to their submodel path
    for (const obj of elements.values()) {
      if (obj.TypeName === 'Class' && obj.ParentTypeName === 'Submodel') {
        const modelPath = buildPath(obj.ParentId);
        const id = obj.Id;
        const name = obj.Name || id;
        const cls = { id, name, homeModelPath: modelPath || '', refs: [] };
        // attach explicit archetype if present in class details
        const det = classDetailsByClassId.get(id);
        const archNorm = normalizeCoadArchetype(det?.Archetype);
        if (archNorm) cls._archMeta = archNorm;
        classesById[id] = cls;
        if (modelPath) classesByFQN[modelPath + '/' + name] = cls;
        // ensure the model exists
        if (!modelsByPath[modelPath]) {
          modelsByPath[modelPath] = { path: modelPath, name: modelPath.split('/').pop() || 'Root', classes: [], submodels: [] };
        }
        modelsByPath[modelPath].classes.push(id);
      }
    }

    // Collect attributes (ElementAttributeMemento) per class
    const attributesByClassId = {};
    for (const obj of elements.values()) {
      if (obj.TypeName === 'Attribute' && obj.ParentTypeName === 'Class') {
        const classId = obj.ParentId;
        if (!attributesByClassId[classId]) attributesByClassId[classId] = [];
        attributesByClassId[classId].push({
          id: obj.Id,
          name: obj.Name || obj.Id,
          multiplicity: obj.Multiplicity || '',
          datatype: normalizeAttrDatatype(obj.DatatypeId, obj.DatatypeTypeName)
        });
      }
    }

    // Build references from Associations and collect canonical association list (with multiplicities)
    const associations = [];
    for (const obj of elements.values()) {
      if (obj.TypeName === 'Association' && obj.From && obj.To) {
        const fromId = obj.From.ReferencedElementId;
        const toId = obj.To.ReferencedElementId;
        const fromNav = obj.From.IsNavigable !== false; // default true
        const toNav = obj.To.IsNavigable !== false;
        const fromMult = obj.From.Multiplicity || '';
        const toMult = obj.To.Multiplicity || '';
        // keep refs for visiting-class discovery
        if (fromNav && classesById[fromId] && classesById[toId]) {
          classesById[fromId].refs.push(toId);
        }
        if (toNav && classesById[toId] && classesById[fromId]) {
          classesById[toId].refs.push(fromId);
        }
        associations.push({ fromId, toId, fromNav, toNav, fromMult, toMult });
      }
    }

    // Sort submodels for consistency
    for (const k in modelsByPath) {
      modelsByPath[k].submodels = (modelsByPath[k].submodels || []).sort();
    }

    // Collect diagrams to map them to submodels (for shape positions)
    const diagrams = new Map(); // diagramId -> { id, parentSubmodelId }
    for (const obj of elements.values()) {
      if (obj.TypeName === 'Diagram' && obj.ParentTypeName === 'Submodel') {
        diagrams.set(obj.Id, { id: obj.Id, parentSubmodelId: obj.ParentId });
      }
    }
    // Build shapesByModelPath: modelPath -> { classId -> { x, y, w, h } }
    const shapesByModelPath = {};
    for (const obj of elements.values()) {
      if (obj.MementoClassname === 'ShapeMemento' && obj.TypeName === 'Shape' && obj.ReferencedElementType === 'Class') {
        const diagramId = obj.ParentId;
        const diagram = diagrams.get(diagramId);
        if (!diagram) continue;
        const submodelId = diagram.parentSubmodelId;
        const modelPath = buildPath(submodelId) || '';
        if (!shapesByModelPath[modelPath]) shapesByModelPath[modelPath] = {};
        const classId = obj.ReferencedElementId || obj.SourceId;
        if (!classId) continue;
        const x = typeof obj.Left === 'number' ? obj.Left : 0;
        const y = typeof obj.Top === 'number' ? obj.Top : 0;
        const w = typeof obj.Width === 'number' ? obj.Width : 0;
        const h = typeof obj.Height === 'number' ? obj.Height : 0;
        shapesByModelPath[modelPath][classId] = { x, y, w, h };
      }
    }

    return { modelsByPath, classesById, classesByFQN, associations, shapesByModelPath, attributesByClassId };
  }

  function makeId(s){
    return 'c_' + hashCode(s);
  }
  function hashCode(str){
    let h=0; for(let i=0;i<str.length;i++){ h=((h<<5)-h)+str.charCodeAt(i); h|=0; } return (h>>>0).toString(36);
  }
  function normalizeAttrDatatype(datatypeId, datatypeTypeName){
    let s = '';
    if (typeof datatypeId === 'string' && datatypeId.trim()) {
      s = datatypeId.trim();
    } else if (typeof datatypeTypeName === 'string' && datatypeTypeName.trim()) {
      // Usually generic like "Attribute datatype"; no specific token – return empty
      s = '';
    }
    if (!s) return '';
    // Split on common separators and take the last non-empty token
    const parts = s.split(/[./\\]/).filter(Boolean);
    const tail = parts.length ? parts[parts.length - 1] : s;
    return String(tail).trim().toLowerCase();
  }

  // Loading overlay helpers
  function showLoading(msg){
    if (!loadingEl) return;
    loadingEl.hidden = false;
    loadingEl.setAttribute('aria-busy','true');
    if (loadingMsgEl && msg) loadingMsgEl.textContent = msg;
  }
  function updateLoading(msg){
    if (loadingMsgEl && msg) loadingMsgEl.textContent = msg;
  }
  function hideLoading(){
    if (!loadingEl) return;
    loadingEl.hidden = true;
    loadingEl.setAttribute('aria-busy','false');
  }

  function renderTree(project){
    const root = findRootModelPath(project.modelsByPath);
    treeEl.innerHTML = '';
    const rootContainer = document.createElement('div');
    treeEl.appendChild(rootContainer);

    // Compute total number of classes in subtree for each model (memoized)
    const totalCountCache = new Map();
    function countClassesRec(p){
      if (totalCountCache.has(p)) return totalCountCache.get(p);
      const m = project.modelsByPath[p];
      if (!m) { totalCountCache.set(p, 0); return 0; }
      let sum = Array.isArray(m.classes) ? m.classes.length : 0;
      const children = m.submodels || [];
      for (const c of children) sum += countClassesRec(c);
      totalCountCache.set(p, sum);
      return sum;
    }

    const buildInto = (path, container)=>{
      const m = project.modelsByPath[path];
      if(!m) return;
      const row = document.createElement('div');
      row.className='tree-node';
      row.dataset.path=path;

      const children = (m.submodels||[]).slice().sort();
      const hasChildren = children.length > 0;

      // Twisty for expand/collapse
      const twisty = document.createElement('span');
      twisty.className = 'twisty';
      twisty.textContent = hasChildren ? (expanded.has(path) ? '▼' : '▶') : '•';
      twisty.title = hasChildren ? (expanded.has(path) ? 'Collapse' : 'Expand') : '';
      twisty.addEventListener('click', (e)=>{
        e.stopPropagation();
        if (!hasChildren) return;
        if (expanded.has(path)) expanded.delete(path); else expanded.add(path);
        renderTree(project);
      });

      // Icon
      const icon = document.createElement('span');
      icon.textContent = path ? '📁' : '🗂️';

      // Name clickable to select model
      const nameSpan = document.createElement('span');
      nameSpan.textContent = m.name;
      nameSpan.addEventListener('click', ()=>selectModel(path));

      // Badge
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = String(countClassesRec(path));

      row.appendChild(twisty);
      row.appendChild(icon);
      row.appendChild(nameSpan);
      row.appendChild(badge);
      container.appendChild(row);

      if (hasChildren) {
        const cont = document.createElement('div');
        cont.className='tree-children';
        cont.style.display = expanded.has(path) ? 'block' : 'none';
        container.appendChild(cont);
        for(const c of children){ buildInto(c, cont); }
      }
    };

    buildInto(root, rootContainer);
  }

  function findRootModelPath(models){
    // The root is the one that is parent of others but has no parent itself
    const keys = Object.keys(models);
    if(keys.includes('')) return '';
    const hasParent = new Set();
    for(const k of keys){
      if(!k) continue;
      const p = k.split('/').slice(0,-1).join('/');
      if(p in models) hasParent.add(k);
    }
    const roots = keys.filter(k=>!k || !hasParent.has(k) && !k.includes('/'));
    return roots.sort()[0] || keys.sort()[0] || '';
  }

  function selectModel(path){
    if(!project) return;
    const model = project.modelsByPath[path];
    if(!model){
      modelHeader.textContent = 'Model not found';
      svg.innerHTML='';
      return;
    }
    // Compute local and visiting classes across this model and all its descendant submodels
    const descPaths = new Set();
    (function collect(p){
      if (!project.modelsByPath[p] || descPaths.has(p)) return;
      descPaths.add(p);
      const children = project.modelsByPath[p].submodels || [];
      for (const c of children) collect(c);
    })(path);

    const localClassIds = [];
    for (const p of descPaths) {
      const m = project.modelsByPath[p];
      if (m && Array.isArray(m.classes)) localClassIds.push(...m.classes);
    }
    const localClasses = localClassIds.map(id => project.classesById[id]).filter(Boolean);

    // If there is an explicit diagram for this model path, restrict visible local classes
    const shapesByModelPath = project.shapesByModelPath || {};
    const diagramShapes = shapesByModelPath[path] || null;
    let visibleLocalClasses = localClasses;
    if (diagramShapes && Object.keys(diagramShapes).length) {
      const shapeIds = new Set(Object.keys(diagramShapes));
      visibleLocalClasses = localClasses.filter(c => shapeIds.has(c.id));
    }

    const visitingMap = new Map(); // clsId -> cls

    // Helper to classify multiplicities
    function isMany(mult){
      if (!mult || typeof mult !== 'string') return false;
      return mult.includes('*');
    }
    function isOneish(mult){
      if (!mult || typeof mult !== 'string') return false;
      const m = mult.trim();
      return m === '1' || m === '1..1' || m === '0..1';
    }

    if (Array.isArray(project.associations) && project.associations.length) {
      // Use associations with multiplicities to decide FK side
      const localSet = new Set(visibleLocalClasses.map(c=>c.id));
      for (const a of project.associations) {
        // If neither end is a visible local class, ignore
        const aSrcIsLocal = localSet.has(a.fromId);
        const aDstIsLocal = localSet.has(a.toId);
        if (!aSrcIsLocal && !aDstIsLocal) continue;

        // If source is local, evaluate whether to include destination
        if (aSrcIsLocal) {
          const other = project.classesById[a.toId];
          if (other && !descPaths.has(other.homeModelPath || '')) {
            const oneOne = isOneish(a.fromMult) && isOneish(a.toMult);
            if (oneOne) {
              // 1-1 both sides: avoid adding by default (unless explicitly placed)
            } else if (isMany(a.toMult) && isMany(a.fromMult)) {
              // many-to-many: skip to reduce noise
            } else if (isOneish(a.toMult)) {
              // Include other if the multiplicity at the OTHER end is one-ish (local holds FK to a single other)
              visitingMap.set(other.id, other);
            } else {
              // Otherwise, do not include
            }
          }
        }
        // If destination is local, evaluate whether to include source
        if (aDstIsLocal) {
          const other = project.classesById[a.fromId];
          if (other && !descPaths.has(other.homeModelPath || '')) {
            const oneOne = isOneish(a.fromMult) && isOneish(a.toMult);
            if (oneOne) {
              // 1-1 both sides: skip unless explicitly placed
            } else if (isMany(a.fromMult) && isMany(a.toMult)) {
              // many-to-many: skip
            } else if (isOneish(a.fromMult)) {
              // Include other if multiplicity at OTHER end (fromMult) is one-ish
              visitingMap.set(other.id, other);
            } else {
              // no-op
            }
          }
        }
      }
    } else {
      // Fallback: use navigability-based refs for generic projects
      for (const cls of visibleLocalClasses) {
        for (const r of (cls.refs || [])) {
          const target = resolveRef(r, path);
          // visiting if target exists and its home path is NOT within descendant set
          if (target && !descPaths.has(target.homeModelPath || '')) {
            visitingMap.set(target.id, target);
          }
        }
      }
    }

    // Also include any classes explicitly placed on the diagram but not local to this model tree
    if (diagramShapes && Object.keys(diagramShapes).length) {
      for (const clsId of Object.keys(diagramShapes)) {
        const c = project.classesById[clsId];
        if (!c) continue;
        const isLocalToTree = descPaths.has(c.homeModelPath || '');
        const isLocalVisible = visibleLocalClasses.some(lc => lc.id === clsId);
        if (!isLocalToTree && !isLocalVisible) {
          visitingMap.set(clsId, c);
        }
      }
    }
    const visitingClasses = [...visitingMap.values()];

    renderModelDiagram(path, model, visibleLocalClasses, visitingClasses);
  }

  function resolveRef(ref, currentModelPath){
    // ref can be an ID or a path like A/B/Class
    if(project.classesById[ref]) return project.classesById[ref];
    if(typeof ref === 'string' && ref.includes('/')){
      const fqn = ref;
      return project.classesByFQN[fqn] || null;
    }
    // Try relative by name within project
    for(const key in project.classesByFQN){
      if(key.endsWith('/'+ref)) return project.classesByFQN[key];
    }
    return null;
  }

  function renderModelDiagram(path, model, localClasses, visitingClasses){
    modelHeader.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <div><strong>Model:</strong> ${model.name} <span style="color:#666">(${path||'Root'})</span></div>
        <div class="legend" style="flex:1 1 auto">
          <span><span class="swatch ppt"></span> Party/Place/Thing</span>
          <span><span class="swatch role"></span> Role</span>
          <span><span class="swatch desc"></span> Description</span>
          <span><span class="swatch moment"></span> Moment-Interval</span>
          <span><span class="swatch visiting"></span> Visiting (dashed)</span>
          <span style="margin-left:auto;color:#666;font-size:12px">Tip: Drag class boxes to rearrange</span>
        </div>
        <div class="zoombar" style="display:flex;gap:6px;align-items:center">
          <button id="zoomOut" class="btn secondary" title="Zoom out">−</button>
          <button id="zoomIn" class="btn secondary" title="Zoom in">+</button>
          <button id="zoomReset" class="btn secondary" title="Reset zoom">100%</button>
          <button id="zoomFit" class="btn" title="Zoom to fit">Fit</button>
          <button id="arrangeBtn" class="btn" title="Arrange (cycle)">Arrange</button>
        </div>
      </div>
    `;
    // Layout
    svg.innerHTML = '';
    ensureDefs(svg);
    // viewport group for pan/zoom
    const vp = createSVG('g', { id: 'vp' });
    svg.appendChild(vp);
    const margin = 20, boxW=180, boxH=60, gapX=40, gapY=40;

    // Initialize view (pan/zoom) for this model
    const view = Object.assign({ x: 0, y: 0, scale: 1, fitted: false }, zoomStates.get(path) || {});
    function applyView(){ vp.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.scale})`); }
    function saveView(){ zoomStates.set(path, { x: view.x, y: view.y, scale: view.scale, fitted: true }); }

    const all = [...localClasses.map(c=>({...c,_visiting:false})), ...visitingClasses.map(c=>({...c,_visiting:true}))];
    // Deduplicate by id keeping visiting true if any
    const byId = new Map();
    for(const c of all){
      if(!byId.has(c.id)) byId.set(c.id, c);
      else if(c._visiting) byId.get(c.id)._visiting=true;
    }
    const nodes = [...byId.values()];

    // Determine archetype for each node (Peter Coad)
    for (const n of nodes) {
      n._arch = determineArchetype(n);
    }

    // Load or initialize layout
    const modelLayout = layouts.get(path) || {};
    const cols = Math.max(1, Math.floor((1200 - margin*2)/(boxW+gapX)));
    let savedCount = 0;
    const shapesByModelPath = project.shapesByModelPath || {};
    const descPathList = [];
    (function collectDesc(p){
      if (!project.modelsByPath[p]) return;
      if (!descPathList.includes(p)) descPathList.push(p);
      const children = project.modelsByPath[p].submodels || [];
      for (const c of children) collectDesc(c);
    })(path);
    nodes.forEach((n,i)=>{
      const saved = modelLayout[n.id];
      if(saved){ n.x = saved.x; n.y = saved.y; savedCount++; }
      else{
        // try shape position from diagram files
        let placed = false;
        // prefer the node's home model diagram
        const homeShapes = shapesByModelPath[n.homeModelPath || ''];
        if (homeShapes && homeShapes[n.id]) {
          n.x = homeShapes[n.id].x;
          n.y = homeShapes[n.id].y;
          savedCount++; placed = true;
        } else {
          // then try any descendant diagram of the selected model
          for (const pth of descPathList) {
            const shp = shapesByModelPath[pth];
            if (shp && shp[n.id]) { n.x = shp[n.id].x; n.y = shp[n.id].y; savedCount++; placed = true; break; }
          }
        }
        if (!placed){
          // temporary grid placement; may be replaced by auto-layout below
          n.x = margin + (i % cols) * (boxW+gapX);
          n.y = margin + Math.floor(i / cols) * (boxH+gapY) + 40; // header space
        }
      }
    });

    // Initialize node heights (support attribute expansion)
    const expSet = expandedAttrs.get(path) || new Set();
    function computeNodeHeight(n){
      const attrs = (project.attributesByClassId && project.attributesByClassId[n.id]) || [];
      if (expSet.has(n.id) && attrs.length){
        const extra = 8 + attrs.length * 16; // padding + line height
        return boxH + extra;
      }
      return boxH;
    }
    for (const n of nodes){ n.h = computeNodeHeight(n); }

    // Measure text to compute per-node width
    function measureTextWidth(text, cls){
      const t = createSVG('text', { x: 0, y: 0, class: cls || 'class-label' });
      t.setAttribute('visibility','hidden');
      t.textContent = text || '';
      // append to vp for accurate measurement
      const parent = svg.querySelector('#vp') || svg;
      parent.appendChild(t);
      const w = (t.getBBox?.().width) || 0;
      parent.removeChild(t);
      return w;
    }
    function computeNodeWidth(n){
      const base = 180;
      let maxText = 0;
      // Class name
      maxText = Math.max(maxText, measureTextWidth(n.name || '', 'class-label'));
      // Subtitle (visiting)
      const subText = n._visiting ? `(from ${n.homeModelPath||'Root'})` : '';
      if (subText) maxText = Math.max(maxText, measureTextWidth(subText, 'class-label'));
      // Attributes if expanded
      const attrs = (project.attributesByClassId && project.attributesByClassId[n.id]) || [];
      if (expSet.has(n.id) && attrs.length){
        for (const a of attrs){
          const line = `${a.name}${a.datatype? ': '+a.datatype:''}`;
          maxText = Math.max(maxText, measureTextWidth(line, 'class-label'));
        }
      }
      const padLeft = 12, padRight = 12, btnSpace = 26; // include room for +/- button
      const required = Math.ceil(maxText + padLeft + Math.max(padRight, btnSpace));
      return Math.max(base, required);
    }
    for (const n of nodes){ n.w = computeNodeWidth(n); }

    // Build links for layout (undirected)
    const nodesByIdMap = Object.fromEntries(nodes.map(n=>[n.id,n]));
    const localSetForLayout = new Set(localClasses.map(c=>c.id));
    const layoutLinks = [];
    if (Array.isArray(project.associations) && project.associations.length) {
      for (const a of project.associations) {
        if (!(localSetForLayout.has(a.fromId) || localSetForLayout.has(a.toId))) continue;
        if (nodesByIdMap[a.fromId] && nodesByIdMap[a.toId]) layoutLinks.push([a.fromId, a.toId]);
      }
    } else {
      const seen = new Set();
      for (const c of localClasses) {
        for (const r of c.refs || []) {
          const t = resolveRef(r, model.path);
          if (!t) continue;
          if (!nodesByIdMap[c.id] || !nodesByIdMap[t.id]) continue;
          const key = [c.id, t.id].sort().join('|');
          if (seen.has(key)) continue; seen.add(key);
          layoutLinks.push([c.id, t.id]);
        }
      }
    }

    // Force-directed auto layout and fit-to-view helpers
    function resolveOverlaps(nodeList){
      // A gentle, bounded pass to reduce rectangle overlaps
      const N = nodeList.length;
      if (N <= 1) return;
      const iterations = 8;
      for (let it = 0; it < iterations; it++){
        let any = false;
        for (let i = 0; i < N; i++){
          for (let j = i+1; j < N; j++){
            const a = nodeList[i], b = nodeList[j];
            const ah = a.h || boxH, bh = b.h || boxH;
            const aw = a.w || boxW, bw = b.w || boxW;
            const ax2 = a.x + aw, ay2 = a.y + ah;
            const bx2 = b.x + bw, by2 = b.y + bh;
            const overlapX = Math.min(ax2, bx2) - Math.max(a.x, b.x);
            const overlapY = Math.min(ay2, by2) - Math.max(a.y, b.y);
            if (overlapX > 0 && overlapY > 0){
              any = true;
              if (overlapX < overlapY){
                const push = overlapX/2 + 1; // small nudge
                if (a.x < b.x){ a.x -= push; b.x += push; } else { a.x += push; b.x -= push; }
              } else {
                const push = overlapY/2 + 1;
                if (a.y < b.y){ a.y -= push; b.y += push; } else { a.y += push; b.y -= push; }
              }
            }
          }
        }
        if (!any) break;
      }
    }

    function autoLayout(nodeList, links){
      const N = nodeList.length;
      if (N === 0) return;
      const center = { x: 600, y: 400 };
      const area = 850 * 600;
      const k = Math.sqrt(area / (N + 1));
      const iterations = Math.min(400, 100 + N * 15);
      let t = k; // temperature
      const cooling = t / iterations;
      // Ensure initial positions
      for (let i = 0; i < N; i++){
        const n = nodeList[i];
        if (typeof n.x !== 'number' || typeof n.y !== 'number'){
          const angle = (2*Math.PI*i)/N;
          n.x = center.x + Math.cos(angle) * 200;
          n.y = center.y + Math.sin(angle) * 200;
        }
      }
      const disp = new Array(N).fill(0).map(()=>({x:0,y:0}));
      const indexById = new Map(nodeList.map((n, i)=>[n.id, i]));

      function repulsiveForce(d){ return (k*k)/(d+0.0001) * 0.9; }
      function attractiveForce(d){ return (d*d)/k * 1.1; }

      for (let iter = 0; iter < iterations; iter++){
        for (let i = 0; i < N; i++){ disp[i].x = 0; disp[i].y = 0; }
        // Repulsion
        for (let i = 0; i < N; i++){
          for (let j = i+1; j < N; j++){
            const ni = nodeList[i], nj = nodeList[j];
            const wi = ni.w || boxW, wj = nj.w || boxW;
            const hi = ni.h || boxH, hj = nj.h || boxH;
            let dx = (ni.x + 0.5*wi) - (nj.x + 0.5*wj);
            let dy = (ni.y + 0.5*hi) - (nj.y + 0.5*hj);
            const dist = Math.hypot(dx, dy) || 0.0001;
            const force = repulsiveForce(dist);
            const ux = dx / dist, uy = dy / dist;
            disp[i].x += ux * force; disp[i].y += uy * force;
            disp[j].x -= ux * force; disp[j].y -= uy * force;
          }
        }
        // Attraction along links
        for (const [a, b] of links){
          const ia = indexById.get(a), ib = indexById.get(b);
          if (ia == null || ib == null) continue;
          const na = nodeList[ia], nb = nodeList[ib];
          const waw = na.w || boxW, wbw = nb.w || boxW;
          const hah = na.h || boxH, hbh = nb.h || boxH;
          let dx = (na.x + 0.5*waw) - (nb.x + 0.5*wbw);
          let dy = (na.y + 0.5*hah) - (nb.y + 0.5*hbh);
          const dist = Math.hypot(dx, dy) || 0.0001;
          const force = attractiveForce(dist);
          const ux = dx / dist, uy = dy / dist;
          disp[ia].x -= ux * force; disp[ia].y -= uy * force;
          disp[ib].x += ux * force; disp[ib].y += uy * force;
        }
        // Gravity to center
        for (let i = 0; i < N; i++){
          const n = nodeList[i];
          const h = n.h || boxH;
          const w = n.w || boxW;
          const cx = n.x + 0.5*w, cy = n.y + 0.5*h;
          const dx = cx - center.x, dy = cy - center.y;
          disp[i].x -= dx * 0.03; disp[i].y -= dy * 0.03;
        }
        // Apply displacements with temperature cap
        for (let i = 0; i < N; i++){
          const n = nodeList[i];
          const d = Math.hypot(disp[i].x, disp[i].y) || 0.0001;
          const ux = disp[i].x / d, uy = disp[i].y / d;
          n.x += ux * Math.min(d, t);
          n.y += uy * Math.min(d, t);
        }
        // Simple collision resolution for rectangles
        for (let i = 0; i < N; i++){
          for (let j = i+1; j < N; j++){
            const a = nodeList[i], b = nodeList[j];
            const ah = a.h || boxH, bh = b.h || boxH;
            const aw = a.w || boxW, bw = b.w || boxW;
            const ax2 = a.x + aw, ay2 = a.y + ah;
            const bx2 = b.x + bw, by2 = b.y + bh;
            const overlapX = Math.min(ax2, bx2) - Math.max(a.x, b.x);
            const overlapY = Math.min(ay2, by2) - Math.max(a.y, b.y);
            if (overlapX > 0 && overlapY > 0){
              // Push apart along the lesser overlap axis
              if (overlapX < overlapY){
                const push = overlapX/2 + 2;
                if (a.x < b.x){ a.x -= push; b.x += push; } else { a.x += push; b.x -= push; }
              } else {
                const push = overlapY/2 + 2;
                if (a.y < b.y){ a.y -= push; b.y += push; } else { a.y += push; b.y -= push; }
              }
            }
          }
        }
        t -= cooling;
        if (t < 0.01) break;
      }
    }

    function fitSvgToContent(nodeList){
      if (!nodeList.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodeList){
        const h = n.h || boxH;
        const w = n.w || boxW;
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x + w > maxX) maxX = n.x + w;
        if (n.y + h > maxY) maxY = n.y + h;
      }
      const padTop = margin; // place content near the top of the SVG
      const pad = margin;
      // shift nodes so they start at padding
      const dx = (minX === Infinity ? 0 : (pad - minX));
      const dy = (minY === Infinity ? 0 : (padTop - minY));
      if (dx !== 0 || dy !== 0){
        for (const n of nodeList){ n.x += dx; n.y += dy; }
        minX += dx; maxX += dx; minY += dy; maxY += dy;
      }
      // Recompute bounds after shifting
      minX = Infinity; minY = Infinity; maxX = -Infinity; maxY = -Infinity;
      for (const n of nodeList){
        const h = n.h || boxH; const w = n.w || boxW;
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x + w > maxX) maxX = n.x + w;
        if (n.y + h > maxY) maxY = n.y + h;
      }
      const width = Math.max(600, (maxX - minX) + pad + margin);
      const height = Math.max(400, (maxY - minY) + pad + margin);
      svg.setAttribute('viewBox', `0 0 ${Math.ceil(width)} ${Math.ceil(height)}`);
    }

    // Automatic layout if some nodes have no saved position
    if (savedCount < nodes.length) {
      autoLayout(nodes, layoutLinks);
    }

    // After positions are set, resolve any residual overlaps even if using saved/shape positions
    resolveOverlaps(nodes);
    // After positions are set, compute bounds and update viewBox to ensure visibility
    fitSvgToContent(nodes);

    // Helper to compute content bounds in content coordinates
    function contentBounds(){
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const n of nodes){
        const h = n.h || boxH;
        const w = n.w || boxW;
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x + w > maxX) maxX = n.x + w;
        if (n.y + h > maxY) maxY = n.y + h;
      }
      if (minX === Infinity) return { minX:0, minY:0, width:0, height:0 };
      return { minX, minY, width: maxX - minX, height: maxY - minY };
    }

    // Zoom utilities
    function zoomAt(pointSvg, factor){
      const newScale = Math.max(0.1, Math.min(8, view.scale * factor));
      const px = pointSvg.x, py = pointSvg.y;
      const cx = (px - view.x) / view.scale;
      const cy = (py - view.y) / view.scale;
      view.x = px - cx * newScale;
      view.y = py - cy * newScale;
      view.scale = newScale;
      applyView(); saveView();
    }
    function zoomToFit(pad=20){
      const b = contentBounds();
      const r = svg.getBoundingClientRect();
      const vw = r.width, vh = r.height;
      if (vw <= 0 || vh <= 0 || b.width === 0 || b.height === 0){
        view.x = 0; view.y = 0; view.scale = 1; applyView(); saveView(); return;
      }
      // Account for the SVG's intrinsic viewBox scaling: one SVG unit is vw/vbWidth pixels
      const vb = svg.viewBox?.baseVal;
      const vbW = vb ? vb.width : (parseFloat(svg.getAttribute('viewBox')?.split(/\s+/)[2]||'1200')||1200);
      const vbH = vb ? vb.height : (parseFloat(svg.getAttribute('viewBox')?.split(/\s+/)[3]||'800')||800);
      const baseScaleX = vbW ? (vw / vbW) : 1;
      const baseScaleY = vbH ? (vh / vbH) : 1;
      // Determine scale in content units so that baseScale * view.scale * content fits into viewport minus padding
      const sx = (vw - pad*2) / (b.width * baseScaleX);
      const sy = (vh - pad*2) / (b.height * baseScaleY);
      const s = Math.max(0.1, Math.min(8, Math.min(sx, sy)));
      // Compute translation in SVG units (pre-baseScale) so that after baseScale and view.scale the padding is achieved
      const px = (pad / baseScaleX) - b.minX * s;
      const py = (pad / baseScaleY) - b.minY * s;
      view.scale = s; view.x = px; view.y = py;
      applyView(); saveView();
    }
    function zoomReset(){ view.scale = 1; view.x = 0; view.y = 0; applyView(); saveView(); }

    // Apply initial view (auto-fit if first open for this model)
    applyView();
    if (!zoomStates.has(path) || zoomStates.get(path)?.fitted === false){
      // Auto-fit on first open for convenience
      zoomToFit(24);
    }

    // Edges: prefer canonical associations (single edge per association with multiplicities)
    const edges = [];
    const nodesById = Object.fromEntries(nodes.map(n=>[n.id,n]));
    const localSet = new Set(localClasses.map(c=>c.id));
    if (Array.isArray(project.associations) && project.associations.length) {
      for (const a of project.associations) {
        const srcNode = nodesById[a.fromId];
        const dstNode = nodesById[a.toId];
        // show an edge only if at least one end is local to this model and both ends are visible
        const isSrcLocal = localSet.has(a.fromId);
        const isDstLocal = localSet.has(a.toId);
        if (!(isSrcLocal || isDstLocal)) continue;
        if (!srcNode || !dstNode) continue;
        edges.push({ src: srcNode, dst: dstNode, fromMult: a.fromMult || '', toMult: a.toMult || '' });
      }
    } else {
      // Fallback: build from refs but dedupe unordered pairs to avoid double lines
      const seenPairs = new Set();
      for (const c of localClasses) {
        for (const r of c.refs || []) {
          const t = resolveRef(r, model.path);
          if (!t) continue;
          const src = nodesById[c.id];
          const dst = nodesById[t.id];
          if (!src || !dst) continue;
          const key = [src.id, dst.id].sort().join('|');
          if (seenPairs.has(key)) continue;
          seenPairs.add(key);
          edges.push({ src, dst, fromMult: '', toMult: '' });
        }
      }
    }

    // Draw edges (no arrows) and multiplicity labels
    const edgeElems = [];
    for (const e of edges) {
      const pathEl = createSVG('path', { class: 'edge' });
      // remove arrow marker to avoid implying direction when showing single association line
      pathEl.setAttribute('marker-end', '');
      const labelSrc = createSVG('text', { class: 'mult' });
      const labelDst = createSVG('text', { class: 'mult' });
      labelSrc.textContent = e.fromMult || '';
      labelDst.textContent = e.toMult || '';
      edgeElems.push({ e, pathEl, labelSrc, labelDst });
      vp.appendChild(pathEl);
      vp.appendChild(labelSrc);
      vp.appendChild(labelDst);
    }
    function attachmentPoint(node, otherCenter) {
      const h = node.h || boxH;
      const w = node.w || boxW;
      const cx = node.x + w/2;
      const cy = node.y + h/2;
      const dx = otherCenter.x - cx;
      const dy = otherCenter.y - cy;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      if (absDx >= absDy) {
        if (dx >= 0) {
          return { x: node.x + w, y: cy, side: 'right', nx: 1, ny: 0 };
        } else {
          return { x: node.x, y: cy, side: 'left', nx: -1, ny: 0 };
        }
      } else {
        if (dy >= 0) {
          return { x: cx, y: node.y + h, side: 'bottom', nx: 0, ny: 1 };
        } else {
          return { x: cx, y: node.y, side: 'top', nx: 0, ny: -1 };
        }
      }
    }

    function labelAnchorForSide(side){
      if (side === 'left') return 'end';
      if (side === 'right') return 'start';
      return 'middle'; // top/bottom
    }

    function computeAttachmentsForAll() {
      // First pass: compute raw attachments for grouping
      const att = edgeElems.map(eo => {
        const { src, dst } = eo.e;
        const centerSrc = { x: src.x + (src.w || boxW)/2, y: src.y + (src.h || boxH)/2 };
        const centerDst = { x: dst.x + (dst.w || boxW)/2, y: dst.y + (dst.h || boxH)/2 };
        const p1 = attachmentPoint(src, centerDst);
        const p2 = attachmentPoint(dst, centerSrc);
        return { eo, p1, p2 };
      });
      // Group by node+side for both ends
      const groups = new Map(); // key -> array of indices
      function keyFor(kind, nodeId, side){ return kind + '|' + nodeId + '|' + side; }
      att.forEach((item, idx) => {
        const { eo, p1, p2 } = item;
        const k1 = keyFor('src', eo.e.src.id, p1.side);
        const k2 = keyFor('dst', eo.e.dst.id, p2.side);
        if (!groups.has(k1)) groups.set(k1, []);
        if (!groups.has(k2)) groups.set(k2, []);
        groups.get(k1).push(idx);
        groups.get(k2).push(idx);
      });
      // Distribute attachments along each side so they don't overlap
      for (const [key, arr] of groups.entries()) {
        const n = arr.length;
        if (n <= 1) continue;
        // key structure: kind|nodeId|side
        const parts = key.split('|');
        const kind = parts[0];
        const nodeId = parts[1];
        const side = parts[2];
        // Determine the node and its bounds from the first item in this group
        const firstItem = att[arr[0]];
        const node = kind === 'src' ? firstItem.eo.e.src : firstItem.eo.e.dst;
        const h = node.h || boxH;
        const w = node.w || boxW;
        const minPad = 12; // keep anchors away from rounded corners and labels
        let minPos, maxPos, axis;
        if (side === 'left' || side === 'right') {
          axis = 'y';
          minPos = node.y + minPad;
          maxPos = node.y + h - minPad;
        } else {
          axis = 'x';
          minPos = node.x + minPad;
          maxPos = node.x + w - minPad;
        }
        const span = Math.max(0, maxPos - minPos);
        // Stable order
        arr.sort((a, b) => a - b);
        arr.forEach((idx, i) => {
          const item = att[idx];
          const t = n > 1 ? (i + 1) / (n + 1) : 0.5; // even spacing; single stays centered
          const pos = minPos + t * span;
          if (kind === 'src') {
            if (axis === 'y') item.p1 = { ...item.p1, y: pos };
            else item.p1 = { ...item.p1, x: pos };
          } else {
            if (axis === 'y') item.p2 = { ...item.p2, y: pos };
            else item.p2 = { ...item.p2, x: pos };
          }
        });
      }
      return att;
    }

    function redrawAllEdges(){
      const att = computeAttachmentsForAll();
      const stub = 16;
      const labelOff = 8;
      for (const { eo, p1, p2 } of att) {
        const p1o = { x: p1.x + p1.nx * stub, y: p1.y + p1.ny * stub };
        const p2o = { x: p2.x + p2.nx * stub, y: p2.y + p2.ny * stub };
        const points = [];
        points.push({ x: p1.x, y: p1.y });
        points.push(p1o);
        if (p1o.x === p2o.x || p1o.y === p2o.y) {
          // direct orthogonal connection between offset points
        } else if (p1.side === 'left' || p1.side === 'right') {
          points.push({ x: p2o.x, y: p1o.y });
        } else {
          points.push({ x: p1o.x, y: p2o.y });
        }
        points.push(p2o);
        points.push({ x: p2.x, y: p2.y });
        const d = points.map((pt, idx) => (idx === 0 ? `M ${pt.x} ${pt.y}` : `L ${pt.x} ${pt.y}`)).join(' ');
        eo.pathEl.setAttribute('d', d);
        // multiplicities at adjusted attachment points
        const { fromMult, toMult } = eo.e;
        if (fromMult) {
          eo.labelSrc.setAttribute('x', p1.x + p1.nx * labelOff);
          eo.labelSrc.setAttribute('y', p1.y + p1.ny * labelOff - 2);
          eo.labelSrc.setAttribute('text-anchor', labelAnchorForSide(p1.side));
          eo.labelSrc.textContent = fromMult;
        } else {
          eo.labelSrc.textContent = '';
        }
        if (toMult) {
          eo.labelDst.setAttribute('x', p2.x + p2.nx * labelOff);
          eo.labelDst.setAttribute('y', p2.y + p2.ny * labelOff - 2);
          eo.labelDst.setAttribute('text-anchor', labelAnchorForSide(p2.side));
          eo.labelDst.textContent = toMult;
        } else {
          eo.labelDst.textContent = '';
        }
      }
    }
    redrawAllEdges();

    // Draw nodes and make them draggable
    for(const n of nodes){
      const g = createSVG('g', { 'data-id': n.id });
      const rect = createSVG('rect', {
        x: n.x, y: n.y, width: n.w || boxW, height: n.h || boxH, rx: 8, ry: 8,
        class: 'class-box' + (n._arch ? (' arch-' + n._arch) : '') + (n._visiting? ' visiting':'')
      });
      const label = createSVG('text', { x: n.x + 12, y: n.y + 24, class: 'class-label' });
      label.textContent = n.name;
      const sub = createSVG('text', { x: n.x + 12, y: n.y + 44, class: 'class-label', fill: '#000' });
      sub.textContent = n._visiting ? `(from ${n.homeModelPath||'Root'})` : '';

      g.appendChild(rect);
      g.appendChild(label);
      g.appendChild(sub);
      
      // Attributes group (initially rendered only if expanded)
      const attrsGroup = createSVG('g', {});
      g.appendChild(attrsGroup);
      
      // Toggle button in top-right
      const btn = createSVG('rect', { x: n.x + (n.w || boxW) - 22, y: n.y + 6, width: 16, height: 16, rx: 3, ry: 3, fill: '#fff', stroke: '#999' });
      const btnTxt = createSVG('text', { x: n.x + boxW - 14, y: n.y + 18, 'text-anchor': 'middle', 'font-size': '12', fill: '#555' });
      const isExpanded = expSet.has(n.id);
      btnTxt.textContent = isExpanded ? '−' : '+';
      g.appendChild(btn);
      g.appendChild(btnTxt);

      function renderAttributes(){
        // Clear old
        while (attrsGroup.firstChild) attrsGroup.removeChild(attrsGroup.firstChild);
        const list = (project.attributesByClassId && project.attributesByClassId[n.id]) || [];
        if (!expSet.has(n.id) || list.length === 0) return;
        const startY = n.y + 64; // below subtitle
        list.forEach((a, i) => {
          const t = createSVG('text', { x: n.x + 12, y: startY + i*16, class: 'class-label', fill: '#000' });
          t.textContent = `${a.name}${a.datatype? ': '+a.datatype:''}`;
          attrsGroup.appendChild(t);
        });
      }

      function updateButton(){
        btn.setAttribute('x', n.x + (n.w || boxW) - 22);
        btn.setAttribute('y', n.y + 6);
        btnTxt.setAttribute('x', n.x + (n.w || boxW) - 14);
        btnTxt.setAttribute('y', n.y + 18);
        btnTxt.textContent = expSet.has(n.id) ? '−' : '+';
      }

      function setExpanded(expand){
        if (expand) expSet.add(n.id); else expSet.delete(n.id);
        const beforeH = n.h || boxH;
        const beforeW = n.w || boxW;
        // recompute size
        n.h = computeNodeHeight(n);
        n.w = computeNodeWidth(n);
        // Update rect size and redraw attrs
        n._el.rect.setAttribute('height', n.h);
        n._el.rect.setAttribute('width', n.w);
        renderAttributes();
        updateButton();
        // If size changed, resolve overlaps and fit, then reroute edges
        if (n.h !== beforeH || n.w !== beforeW){
          resolveOverlaps(nodes);
          fitSvgToContent(nodes);
        }
        redrawAllEdges();
        // Persist expanded state
        expandedAttrs.set(path, expSet);
      }

      // Button events
      function onBtnClick(e){ e.stopPropagation(); setExpanded(!expSet.has(n.id)); }
      btn.addEventListener('click', onBtnClick);
      btnTxt.addEventListener('click', onBtnClick);

      // Initial attrs rendering if expanded
      if (isExpanded){ renderAttributes(); }

      vp.appendChild(g);

      // Store element refs for fast updates
      n._el = { g, rect, label, sub, attrsGroup, btn, btnTxt };
    }

    // Build adjacency: for quick edge updates on drag
    const edgesByNodeId = new Map();
    for (const eo of edgeElems) {
      const { e } = eo;
      if (!edgesByNodeId.has(e.src.id)) edgesByNodeId.set(e.src.id, []);
      if (!edgesByNodeId.has(e.dst.id)) edgesByNodeId.set(e.dst.id, []);
      // Store the full edge object (includes labels) so redrawEdge can move multiplicity labels too
      edgesByNodeId.get(e.src.id).push(eo);
      edgesByNodeId.get(e.dst.id).push(eo);
    }

    // Pointer-based dragging
    let dragState = null; // { id, offsetX, offsetY }

    function svgPointFromEvent(evt){
      // Convert client coordinates to outer SVG coords
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX; pt.y = evt.clientY;
      const svgCtm = svg.getScreenCTM();
      return svgCtm ? pt.matrixTransform(svgCtm.inverse()) : { x: evt.clientX, y: evt.clientY };
    }
    function contentPointFromEvent(evt, view){
      const pSvg = svgPointFromEvent(evt);
      const s = view.scale || 1;
      const x = (pSvg.x - view.x) / s;
      const y = (pSvg.y - view.y) / s;
      return { x, y };
    }

    function onPointerDown(evt){
      evt.stopPropagation();
      const g = evt.currentTarget;
      const id = g.getAttribute('data-id');
      const node = nodesById[id];
      if(!node) return;
      const p = contentPointFromEvent(evt, view);
      dragState = { id, offsetX: p.x - node.x, offsetY: p.y - node.y };
      g.setPointerCapture?.(evt.pointerId);
      evt.preventDefault();
    }
    function onPointerMove(evt){
      if(!dragState) return;
      const node = nodesById[dragState.id];
      const p = contentPointFromEvent(evt, view);
      node.x = p.x - dragState.offsetX;
      node.y = p.y - dragState.offsetY;
      // Update DOM positions
      node._el.rect.setAttribute('x', node.x);
      node._el.rect.setAttribute('y', node.y);
      node._el.label.setAttribute('x', node.x + 12);
      node._el.label.setAttribute('y', node.y + 24);
      node._el.sub.setAttribute('x', node.x + 12);
      node._el.sub.setAttribute('y', node.y + 44);
      // Move attributes if visible
      if (node._el.attrsGroup && node._el.attrsGroup.childNodes.length){
        const startY = node.y + 64;
        const children = Array.from(node._el.attrsGroup.childNodes);
        for (let i=0;i<children.length;i++){
          const t = children[i];
          if (t && t.setAttribute){
            t.setAttribute('x', node.x + 12);
            t.setAttribute('y', startY + i*16);
          }
        }
      }
      // Update toggle button position
      if (node._el.btn && node._el.btnTxt){
        node._el.btn.setAttribute('x', node.x + (node.w || boxW) - 22);
        node._el.btn.setAttribute('y', node.y + 6);
        node._el.btnTxt.setAttribute('x', node.x + (node.w || boxW) - 14);
        node._el.btnTxt.setAttribute('y', node.y + 18);
      }
      // Update edges (recompute groups so connections don't overlap)
      redrawAllEdges();
    }
    function onPointerUp(evt){
      if(!dragState) return;
      const node = nodesById[dragState.id];
      // Persist layout for this model
      const ml = layouts.get(path) || {};
      ml[node.id] = { x: node.x, y: node.y };
      layouts.set(path, ml);
      dragState = null;
    }

    // Clean up old handlers on svg if any
    if(svg._dragHandlers){
      svg.removeEventListener('pointermove', svg._dragHandlers.move);
      svg.removeEventListener('pointerup', svg._dragHandlers.up);
      svg.removeEventListener('wheel', svg._dragHandlers.wheel);
      svg.removeEventListener('pointerdown', svg._dragHandlers.down);
    }
    svg._dragHandlers = { move: onPointerMove, up: onPointerUp };

    // Attach handlers to each group
    for(const n of nodes){
      const g = n._el.g;
      g.style.cursor = 'move';
      g.addEventListener('pointerdown', onPointerDown);
    }
    svg.addEventListener('pointermove', onPointerMove);
    svg.addEventListener('pointerup', onPointerUp);

    // Pan/zoom handlers on background
    let panning = null; // { startX, startY, viewX, viewY }
    function onSvgPointerDown(evt){
      // start panning only if clicking background (svg) or vp, not a node
      if (evt.target === svg || evt.target === vp) {
        const p = svgPointFromEvent(evt);
        panning = { startX: p.x, startY: p.y, viewX: view.x, viewY: view.y };
        svg.setPointerCapture?.(evt.pointerId);
      }
    }
    function onSvgPointerMove(evt){
      if (!panning) return;
      const p = svgPointFromEvent(evt);
      view.x = panning.viewX + (p.x - panning.startX);
      view.y = panning.viewY + (p.y - panning.startY);
      applyView(); saveView();
    }
    function onSvgPointerUp(){ panning = null; }
    function onWheel(evt){
      evt.preventDefault();
      const p = svgPointFromEvent(evt);
      const factor = evt.deltaY < 0 ? 1.1 : 0.9;
      zoomAt(p, factor);
    }
    svg.addEventListener('pointerdown', onSvgPointerDown);
    svg.addEventListener('pointermove', onSvgPointerMove);
    svg.addEventListener('pointerup', onSvgPointerUp);
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg._dragHandlers = { move: onPointerMove, up: onPointerUp, wheel: onWheel, down: onSvgPointerDown };

    // Zoom buttons
    document.getElementById('zoomIn')?.addEventListener('click', ()=>{
      const r = svg.getBoundingClientRect();
      zoomAt({ x: r.width/2, y: r.height/2 }, 1.2);
    });
    document.getElementById('zoomOut')?.addEventListener('click', ()=>{
      const r = svg.getBoundingClientRect();
      zoomAt({ x: r.width/2, y: r.height/2 }, 1/1.2);
    });
    document.getElementById('zoomReset')?.addEventListener('click', ()=>{ zoomReset(); });
    document.getElementById('zoomFit')?.addEventListener('click', ()=>{ zoomToFit(24); });

    // Arrange button (cycles through modes)
    const arrangeBtn = document.getElementById('arrangeBtn');
    if (arrangeBtn) {
      const modes = ['auto', 'grid', 'circle', 'hier'];
      function updateArrangeLabel(idx){ arrangeBtn.textContent = 'Arrange'; arrangeBtn.title = 'Arrange (current: ' + modes[idx] + ')'; }
      const st = arrangeStates.get(path) || { index: -1 };
      if (st.index < 0) { st.index = 0; arrangeStates.set(path, st); }
      updateArrangeLabel(st.index);

      function updateNodeDom(n){
        n._el.rect.setAttribute('x', n.x);
        n._el.rect.setAttribute('y', n.y);
        n._el.rect.setAttribute('width', n.w || boxW);
        n._el.label.setAttribute('x', n.x + 12);
        n._el.label.setAttribute('y', n.y + 24);
        n._el.sub.setAttribute('x', n.x + 12);
        n._el.sub.setAttribute('y', n.y + 44);
        // Move attributes if visible
        if (n._el.attrsGroup && n._el.attrsGroup.childNodes.length){
          const startY = n.y + 64;
          const children = Array.from(n._el.attrsGroup.childNodes);
          for (let i=0;i<children.length;i++){
            const t = children[i];
            if (t && t.setAttribute){
              t.setAttribute('x', n.x + 12);
              t.setAttribute('y', startY + i*16);
            }
          }
        }
        // Update button position
        if (n._el.btn && n._el.btnTxt){
          n._el.btn.setAttribute('x', n.x + (n.w || boxW) - 22);
          n._el.btn.setAttribute('y', n.y + 6);
          n._el.btnTxt.setAttribute('x', n.x + (n.w || boxW) - 14);
          n._el.btnTxt.setAttribute('y', n.y + 18);
        }
      }
      function saveLayout(){
        const ml = layouts.get(path) || {};
        for (const n of nodes){ ml[n.id] = { x: n.x, y: n.y }; }
        layouts.set(path, ml);
      }

      function arrange(mode){
        const N = nodes.length;
        if (N === 0) return;
        if (mode === 'auto'){
          autoLayout(nodes, layoutLinks);
        } else if (mode === 'grid'){
          const cols = Math.max(1, Math.ceil(Math.sqrt(N)));
          const startX = margin, startY = margin;
          for (let i=0;i<N;i++){
            const n = nodes[i];
            const c = i % cols; const r = Math.floor(i / cols);
            n.x = startX + c * (boxW + gapX);
            n.y = startY + r * (boxH + gapY);
          }
        } else if (mode === 'circle'){
          const pad = margin + 40;
          const r = Math.max(80, Math.min(300, 30 + N * 12));
          const cx = pad + r + (Math.max(...nodes.map(nn=>nn.w||boxW)))/2;
          const cy = pad + r + boxH/2;
          for (let i=0;i<N;i++){
            const ang = (2*Math.PI * i) / N;
            const wi = nodes[i].w || boxW;
            const px = cx + r * Math.cos(ang) - wi/2;
            const py = cy + r * Math.sin(ang) - boxH/2;
            nodes[i].x = px; nodes[i].y = py;
          }
        } else if (mode === 'hier'){
          // Simple layered layout based on outgoing edges
          const adj = new Map(); const indeg = new Map();
          for (const n of nodes){ adj.set(n.id, []); indeg.set(n.id, 0); }
          for (const e of edges){
            if (!adj.has(e.src.id) || !adj.has(e.dst.id)) continue;
            adj.get(e.src.id).push(e.dst.id);
            indeg.set(e.dst.id, (indeg.get(e.dst.id) || 0) + 1);
          }
          // pick root: min indegree (fallback first node)
          let root = nodes[0]?.id || null;
          let minIn = Infinity;
          for (const n of nodes){ const d = indeg.get(n.id) ?? 0; if (d < minIn){ minIn = d; root = n.id; } }
          // BFS layers
          const layer = new Map();
          const q = [];
          if (root){ layer.set(root, 0); q.push(root); }
          while(q.length){
            const v = q.shift();
            const L = layer.get(v) || 0;
            for (const w of (adj.get(v) || [])){
              if (!layer.has(w)){ layer.set(w, L+1); q.push(w); }
            }
          }
          // Unreached nodes: place at layer 0+ spread
          for (const n of nodes){ if (!layer.has(n.id)) layer.set(n.id, 0); }
          // group by layer
          const byLayer = new Map();
          for (const n of nodes){ const L = layer.get(n.id)||0; if (!byLayer.has(L)) byLayer.set(L, []); byLayer.get(L).push(n); }
          const sortedLayers = [...byLayer.keys()].sort((a,b)=>a-b);
          const lx = boxW + gapX + 60; const ly = boxH + gapY;
          let xBase = margin, yBase = margin;
          for (const L of sortedLayers){
            const arr = byLayer.get(L);
            arr.sort((a,b)=> (a.name||'').localeCompare(b.name||''));
            for (let i=0;i<arr.length;i++){
              const n = arr[i];
              n.x = xBase + L * lx;
              n.y = yBase + i * ly;
            }
          }
        }
        // Post-process: avoid overlaps and fit
        resolveOverlaps(nodes);
        fitSvgToContent(nodes);
        // Update DOM and edges
        for (const n of nodes){ updateNodeDom(n); }
        redrawAllEdges();
        saveLayout();
        zoomToFit(24);
      }

      arrangeBtn.addEventListener('click', ()=>{
        const state = arrangeStates.get(path) || { index: 0 };
        state.index = (state.index + 1) % modes.length;
        arrangeStates.set(path, state);
        updateArrangeLabel(state.index);
        arrange(modes[state.index]);
      });
    }
  }

  function centerRight(node, w, h){ return { x: node.x + w, y: node.y + h/2 }; }
  function centerLeft(node, w, h){ return { x: node.x, y: node.y + h/2 }; }

  function ensureDefs(svg){
    const defs = createSVG('defs', {});
    const marker = createSVG('marker', { id: 'arrow', viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
    const path = createSVG('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#555' });
    marker.appendChild(path);
    defs.appendChild(marker);
    svg.appendChild(defs);
  }

  function createSVG(tag, attrs){
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for(const k in attrs){ el.setAttribute(k, attrs[k]); }
    return el;
  }

  // Determine Peter Coad archetype from class name and simple heuristics
  // Returns one of: 'ppt' (Party/Place/Thing), 'role', 'desc', 'moment'
  function determineArchetype(cls){
    // Prefer explicit metadata from DSharp Class details if present
    if (cls && cls._archMeta) return cls._archMeta;
    const name = (cls?.name || '').trim();
    const n = name.toLowerCase();
    // If future DSharp metadata provides explicit tags/stereotypes, prefer them here
    // e.g., cls.stereotype or cls.tags

    // Explicit keywords lists (whitelists beat suffix rules)
    const descKeywords = new Set([
      'gender','sex'
    ]);
    const pptKeywords = new Set([
      'customer','account','person','user','employee','company','organization','organisation','vendor','supplier','client','product','item','article','vehicle','asset','document','file','address','city','country','location','place','store','warehouse','department','team','accounting entry','accountingentry','account','orderline','order line'
    ]);
    const momentKeywords = new Set([
      'order','reservation','booking','payment','invoice','shipment','delivery','event','session','transaction','transfer','change','movement','enrollment','enrolment','subscription','hire','visit','interaction','request','response','message','task','activity','assignment','audit','log','record','entry','project'
    ]);
    const descSuffixes = ['type','kind','category','status','spec','specification','description','info','details','rule','policy','plan','option','parameter','setting','template','profile','code','reason'];
    const roleKeywords = new Set(['owner','manager','driver','approver','assignee','reviewer','member','admin','agent','operator','controller','holder','teacher','student','author','editor','membership','project membership']);

    // 1) Descriptions by explicit keywords or suffix
    if(descKeywords.has(n)) return 'desc';
    for(const s of descSuffixes){ if(n===s || n.endsWith(' '+s) || n.endsWith('_'+s) || n.endsWith('-'+s)) return 'desc'; }

    // 2) Moment-Interval by explicit keywords
    if(momentKeywords.has(n)) return 'moment';

    // 3) Party/Place/Thing by explicit keywords (overrides role suffixes like -er)
    if(pptKeywords.has(n)) return 'ppt';

    // 4) Role by explicit words
    if(roleKeywords.has(n)) return 'role';

    // 5) Role by common agentive suffixes, but avoid some common P/PT like 'customer'
    if(/(er|or|ist|ant|ee)s?$/.test(n) && n !== 'customer') return 'role';

    // 6) Default P/PT
    return 'ppt';
  }

  function buildDemoProject(){
    // Construct an in-memory project matching our structures
    const modelsByPath = {
      '': { path: '', name: 'Root', classes: [], submodels: ['Domain', 'UI'] },
      'Domain': { path: 'Domain', name: 'Domain', classes: [], submodels: ['Domain/Orders'] },
      'Domain/Orders': { path: 'Domain/Orders', name: 'Orders', classes: [], submodels: [] },
      'UI': { path: 'UI', name: 'UI', classes: [], submodels: [] },
    };
    const classesById = {};
    const classesByFQN = {};

    function addClass(home, name, refs){
      const id = makeId(home+':'+name);
      const cls = { id, name, homeModelPath: home, refs: refs||[] };
      classesById[id]=cls;
      classesByFQN[home + '/' + name] = cls;
      modelsByPath[home].classes.push(id);
      return cls;
    }

    const Customer = addClass('Domain', 'Customer', ['Domain/Orders/Order']);
    const Order = addClass('Domain/Orders', 'Order', ['UI/OrderView']);
    const OrderLine = addClass('Domain/Orders', 'OrderLine', []);
    const OrderView = addClass('UI', 'OrderView', ['Domain/Orders/Order']);

    return { modelsByPath, classesById, classesByFQN };
  }
})();

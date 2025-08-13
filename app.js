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
  const azOrg = document.getElementById('azOrg');
  const azProject = document.getElementById('azProject');
  const azRepo = document.getElementById('azRepo');
  const azRef = document.getElementById('azRef');
  const azLoadBtn = document.getElementById('azLoadBtn');

  let project = null; // { modelsByPath, classesById, classesByFQN }
  let rootPath = '';
  // Session-scoped saved layouts: modelPath -> { classId -> {x,y} }
  const layouts = new Map();

  folderInput.addEventListener('change', async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    rootPath = commonPrefix(files.map(f => f.webkitRelativePath));
    project = await buildProjectFromFiles(files);
    renderTree(project);
    selectModel(rootPath);
  });

  demoBtn.addEventListener('click', () => {
    project = buildDemoProject();
    rootPath = '';
    renderTree(project);
    const firstModel = Object.keys(project.modelsByPath).sort()[0] || '';
    selectModel(firstModel);
  });

  azLoadBtn?.addEventListener('click', async () => {
    const org = (azOrg?.value || '').trim();
    const projectName = (azProject?.value || '').trim();
    const repo = (azRepo?.value || '').trim();
    const ref = (azRef?.value || '').trim();
    if(!org || !projectName || !repo){
      alert('Please fill Org, Project, and Repository');
      return;
    }
    try{
      const params = new URLSearchParams({ org, project: projectName, repo });
      if(ref) params.set('ref', ref);
      const resp = await fetch('/api/azdo/items?' + params.toString());
      const data = await resp.json();
      if(!resp.ok){ throw new Error(data && data.error || 'Failed to load from DevOps'); }
      const entries = data.entries || [];
      project = await buildProjectFromEntries(entries);
      renderTree(project);
      const firstModel = Object.keys(project.modelsByPath).sort()[0] || '';
      selectModel(firstModel);
    }catch(e){
      console.error(e);
      alert('Azure DevOps load failed: ' + e.message);
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
    for (const f of files) {
      entries.push({ path: f.webkitRelativePath, text: await f.text() });
    }
    return buildProjectFromEntries(entries);
  }

  async function buildProjectFromEntries(entries){
    // Normalize virtual filesystem from entries
    const vfs = new Map(); // path -> text
    for(const e of entries){
      if (e && typeof e.path === 'string') vfs.set(e.path, e.text || '');
    }

    // If this looks like a DSharp _Content export, use the specialized parser
    const hasContentFolder = [...vfs.keys()].some(p => /\/_Content\//.test(p));
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
          const data = JSON.parse(txt);
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
          const c = JSON.parse(txt);
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
    const contentEntries = [...vfs.entries()].filter(([p]) => /\/_Content\//.test(p) && p.endsWith('.json'));
    const elements = new Map(); // id -> obj
    for (const [p, txt] of contentEntries) {
      try {
        const obj = JSON.parse(txt);
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

    return { modelsByPath, classesById, classesByFQN, associations };
  }

  function makeId(s){
    return 'c_' + hashCode(s);
  }
  function hashCode(str){
    let h=0; for(let i=0;i<str.length;i++){ h=((h<<5)-h)+str.charCodeAt(i); h|=0; } return (h>>>0).toString(36);
  }

  function renderTree(project){
    const root = findRootModelPath(project.modelsByPath);
    treeEl.innerHTML = '';
    const rootContainer = document.createElement('div');
    treeEl.appendChild(rootContainer);

    const buildInto = (path, container)=>{
      const m = project.modelsByPath[path];
      if(!m) return;
      const el = document.createElement('div');
      el.className='tree-node';
      el.dataset.path=path;
      el.innerHTML = `${path? '📁' : '🗂️'} <span>${m.name}</span> <span class="badge">${m.classes.length}</span>`;
      el.addEventListener('click', ()=>selectModel(path));
      container.appendChild(el);
      const children = (m.submodels||[]).slice().sort();
      if(children.length){
        const cont = document.createElement('div');
        cont.className='tree-children';
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

    const visitingMap = new Map(); // clsId -> cls
    for (const cls of localClasses) {
      for (const r of (cls.refs || [])) {
        const target = resolveRef(r, path);
        // visiting if target exists and its home path is NOT within descendant set
        if (target && !descPaths.has(target.homeModelPath || '')) {
          visitingMap.set(target.id, target);
        }
      }
    }
    const visitingClasses = [...visitingMap.values()];

    renderModelDiagram(path, model, localClasses, visitingClasses);
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
      <div><strong>Model:</strong> ${model.name} <span style="color:#666">(${path||'Root'})</span></div>
      <div class="legend">
        <span><span class="swatch ppt"></span> Party/Place/Thing</span>
        <span><span class="swatch role"></span> Role</span>
        <span><span class="swatch desc"></span> Description</span>
        <span><span class="swatch moment"></span> Moment-Interval</span>
        <span><span class="swatch visiting"></span> Visiting (dashed)</span>
        <span style="margin-left:auto;color:#666;font-size:12px">Tip: Drag class boxes to rearrange</span>
      </div>
    `;
    // Layout
    svg.innerHTML = '';
    ensureDefs(svg);
    const margin = 20, boxW=180, boxH=60, gapX=40, gapY=40;

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
    nodes.forEach((n,i)=>{
      const saved = modelLayout[n.id];
      if(saved){ n.x = saved.x; n.y = saved.y; savedCount++; }
      else{
        // temporary grid placement; may be replaced by auto-layout below
        n.x = margin + (i % cols) * (boxW+gapX);
        n.y = margin + Math.floor(i / cols) * (boxH+gapY) + 40; // header space
      }
    });

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
            let dx = (ni.x + 0.5*boxW) - (nj.x + 0.5*boxW);
            let dy = (ni.y + 0.5*boxH) - (nj.y + 0.5*boxH);
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
          let dx = (na.x + 0.5*boxW) - (nb.x + 0.5*boxW);
          let dy = (na.y + 0.5*boxH) - (nb.y + 0.5*boxH);
          const dist = Math.hypot(dx, dy) || 0.0001;
          const force = attractiveForce(dist);
          const ux = dx / dist, uy = dy / dist;
          disp[ia].x -= ux * force; disp[ia].y -= uy * force;
          disp[ib].x += ux * force; disp[ib].y += uy * force;
        }
        // Gravity to center
        for (let i = 0; i < N; i++){
          const n = nodeList[i];
          const cx = n.x + 0.5*boxW, cy = n.y + 0.5*boxH;
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
            const ax2 = a.x + boxW, ay2 = a.y + boxH;
            const bx2 = b.x + boxW, by2 = b.y + boxH;
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
        if (n.x < minX) minX = n.x;
        if (n.y < minY) minY = n.y;
        if (n.x + boxW > maxX) maxX = n.x + boxW;
        if (n.y + boxH > maxY) maxY = n.y + boxH;
      }
      const padTop = 40 + margin; // leave room for header area inside view
      const pad = margin;
      // shift nodes so they start at padding
      const dx = (minX === Infinity ? 0 : (pad - minX));
      const dy = (minY === Infinity ? 0 : (padTop - minY));
      if (dx !== 0 || dy !== 0){
        for (const n of nodeList){ n.x += dx; n.y += dy; }
        minX += dx; maxX += dx; minY += dy; maxY += dy;
      }
      const width = Math.max(600, (maxX - minX) + pad + margin);
      const height = Math.max(400, (maxY - minY) + pad + margin);
      svg.setAttribute('viewBox', `0 0 ${Math.ceil(width)} ${Math.ceil(height)}`);
    }

    // Automatic layout if some nodes have no saved position
    if (savedCount < nodes.length) {
      autoLayout(nodes, layoutLinks);
    }

    // After positions are set, compute bounds and update viewBox to ensure visibility
    fitSvgToContent(nodes);

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
      svg.appendChild(pathEl);
      svg.appendChild(labelSrc);
      svg.appendChild(labelDst);
    }
    function attachmentPoint(node, otherCenter) {
      const cx = node.x + boxW/2;
      const cy = node.y + boxH/2;
      const dx = otherCenter.x - cx;
      const dy = otherCenter.y - cy;
      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      // choose dominant axis to exit rectangle
      if (absDx >= absDy) {
        // horizontal attachment
        if (dx >= 0) {
          return { x: node.x + boxW, y: cy, side: 'right', nx: 1, ny: 0 };
        } else {
          return { x: node.x, y: cy, side: 'left', nx: -1, ny: 0 };
        }
      } else {
        // vertical attachment
        if (dy >= 0) {
          return { x: cx, y: node.y + boxH, side: 'bottom', nx: 0, ny: 1 };
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
        const centerSrc = { x: src.x + boxW/2, y: src.y + boxH/2 };
        const centerDst = { x: dst.x + boxW/2, y: dst.y + boxH/2 };
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
      // Apply perpendicular offsets within each group
      const spacing = 6;
      for (const arr of groups.values()) {
        const n = arr.length;
        if (n <= 1) continue;
        // distribute indices around 0
        const mid = (n - 1) / 2;
        arr.sort((a, b) => a - b); // stable
        arr.forEach((idx, i) => {
          const delta = (i - mid) * spacing;
          const item = att[idx];
          // offset p1 perpendicular to its normal
          if (item && item.p1) {
            if (item.p1.side === 'left' || item.p1.side === 'right') {
              item.p1 = { ...item.p1, y: item.p1.y + delta };
            } else {
              item.p1 = { ...item.p1, x: item.p1.x + delta };
            }
          }
          // offset p2 perpendicular to its normal
          if (item && item.p2) {
            if (item.p2.side === 'left' || item.p2.side === 'right') {
              item.p2 = { ...item.p2, y: item.p2.y + delta };
            } else {
              item.p2 = { ...item.p2, x: item.p2.x + delta };
            }
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
        x: n.x, y: n.y, width: boxW, height: boxH, rx: 8, ry: 8,
        class: 'class-box' + (n._arch ? (' arch-' + n._arch) : '') + (n._visiting? ' visiting':'')
      });
      const label = createSVG('text', { x: n.x + 12, y: n.y + 24, class: 'class-label' });
      label.textContent = n.name;
      const sub = createSVG('text', { x: n.x + 12, y: n.y + 44, class: 'class-label', fill: '#555' });
      sub.textContent = n._visiting ? `(from ${n.homeModelPath||'Root'})` : '';

      g.appendChild(rect);
      g.appendChild(label);
      g.appendChild(sub);
      svg.appendChild(g);

      // Store element refs for fast updates
      n._el = { g, rect, label, sub };
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
      const pt = svg.createSVGPoint();
      pt.x = evt.clientX; pt.y = evt.clientY;
      const ctm = svg.getScreenCTM();
      return ctm ? pt.matrixTransform(ctm.inverse()) : { x: evt.clientX, y: evt.clientY };
    }

    function onPointerDown(evt){
      const g = evt.currentTarget;
      const id = g.getAttribute('data-id');
      const node = nodesById[id];
      if(!node) return;
      const p = svgPointFromEvent(evt);
      dragState = { id, offsetX: p.x - node.x, offsetY: p.y - node.y };
      g.setPointerCapture?.(evt.pointerId);
      evt.preventDefault();
    }
    function onPointerMove(evt){
      if(!dragState) return;
      const node = nodesById[dragState.id];
      const p = svgPointFromEvent(evt);
      node.x = p.x - dragState.offsetX;
      node.y = p.y - dragState.offsetY;
      // Update DOM positions
      node._el.rect.setAttribute('x', node.x);
      node._el.rect.setAttribute('y', node.y);
      node._el.label.setAttribute('x', node.x + 12);
      node._el.label.setAttribute('y', node.y + 24);
      node._el.sub.setAttribute('x', node.x + 12);
      node._el.sub.setAttribute('y', node.y + 44);
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

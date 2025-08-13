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

    // Gather classes and attach to their submodel path
    for (const obj of elements.values()) {
      if (obj.TypeName === 'Class' && obj.ParentTypeName === 'Submodel') {
        const modelPath = buildPath(obj.ParentId);
        const id = obj.Id;
        const name = obj.Name || id;
        const cls = { id, name, homeModelPath: modelPath || '', refs: [] };
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
    // Compute local and visiting classes
    const localClasses = model.classes.map(id=>project.classesById[id]).filter(Boolean);
    const visitingMap = new Map(); // clsId -> cls
    for(const cls of localClasses){
      for(const r of cls.refs||[]){
        const target = resolveRef(r, path);
        if(target && target.homeModelPath !== path){
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
        <span><span class="swatch home"></span> Home classes</span>
        <span><span class="swatch visiting"></span> Visiting classes</span>
        <span style="margin-left:auto;color:#666;font-size:12px">Tip: Drag class boxes to rearrange</span>
      </div>
    `;
    // Layout
    svg.innerHTML = '';
    ensureDefs(svg);
    const margin = 24, boxW=180, boxH=60, gapX=40, gapY=40;

    const all = [...localClasses.map(c=>({...c,_visiting:false})), ...visitingClasses.map(c=>({...c,_visiting:true}))];
    // Deduplicate by id keeping visiting true if any
    const byId = new Map();
    for(const c of all){
      if(!byId.has(c.id)) byId.set(c.id, c);
      else if(c._visiting) byId.get(c.id)._visiting=true;
    }
    const nodes = [...byId.values()];

    // Load or initialize layout
    const modelLayout = layouts.get(path) || {};
    const cols = Math.max(1, Math.floor((1200 - margin*2)/(boxW+gapX)));
    nodes.forEach((n,i)=>{
      const saved = modelLayout[n.id];
      if(saved){ n.x = saved.x; n.y = saved.y; }
      else{
        n.x = margin + (i % cols) * (boxW+gapX);
        n.y = margin + Math.floor(i / cols) * (boxH+gapY) + 40; // header space
      }
    });

    // Edges: prefer canonical associations (single edge per association with multiplicities)
    const edges = [];
    const nodesById = Object.fromEntries(nodes.map(n=>[n.id,n]));
    if (Array.isArray(project.associations) && project.associations.length) {
      for (const a of project.associations) {
        const srcNode = nodesById[a.fromId];
        const dstNode = nodesById[a.toId];
        // show an edge only if at least one end is local to this model and both ends are visible
        const isSrcLocal = !!localClasses.find(c=>c.id===a.fromId);
        const isDstLocal = !!localClasses.find(c=>c.id===a.toId);
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
    function redrawEdge(edgeObj){
      const {src, dst, fromMult, toMult} = edgeObj.e;
      const {x:x1,y:y1} = centerRight(src, boxW, boxH);
      const {x:x2,y:y2} = centerLeft(dst, boxW, boxH);
      const midX = (x1 + x2)/2;
      const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
      edgeObj.pathEl.setAttribute('d', d);
      // Position multiplicities slightly outside box edges
      const off = 6;
      if (fromMult) {
        edgeObj.labelSrc.setAttribute('x', x1 + off);
        edgeObj.labelSrc.setAttribute('y', y1 - 6);
        edgeObj.labelSrc.textContent = fromMult;
      } else {
        edgeObj.labelSrc.textContent = '';
      }
      if (toMult) {
        edgeObj.labelDst.setAttribute('x', x2 - off - 10);
        edgeObj.labelDst.setAttribute('y', y2 - 6);
        edgeObj.labelDst.textContent = toMult;
      } else {
        edgeObj.labelDst.textContent = '';
      }
    }
    function redrawAllEdges(){ edgeElems.forEach(redrawEdge); }
    redrawAllEdges();

    // Draw nodes and make them draggable
    for(const n of nodes){
      const g = createSVG('g', { 'data-id': n.id });
      const rect = createSVG('rect', {
        x: n.x, y: n.y, width: boxW, height: boxH, rx: 8, ry: 8,
        class: 'class-box' + (n._visiting? ' visiting':'')
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
      // Update connected edges only
      const related = edgesByNodeId.get(node.id) || [];
      for(const eo of related){ redrawEdge(eo); }
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

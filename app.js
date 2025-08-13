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

  let project = null; // { modelsByPath, classesById, classesByFQN }
  let rootPath = '';

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
    // Normalize vfs
    const vfs = new Map(); // path -> File
    for(const f of files){
      vfs.set(f.webkitRelativePath, f);
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
        classes: [], // class IDs
        submodels: [],
      };
    }
    // Link submodels
    for(const dir of dirs){
      if(!dir) continue;
      const parent = dir.split('/').slice(0,-1).join('/');
      if(modelsByPath[parent]) modelsByPath[parent].submodels.push(dir);
    }

    const classesById = {};
    const classesByFQN = {};

    // Read model.json and classes/*.json
    for(const [path, file] of vfs){
      if(path.endsWith('model.json')){
        try{
          const txt = await file.text();
          const data = JSON.parse(txt);
          const dir = path.split('/').slice(0,-1).join('/');
          const model = modelsByPath[dir] || (modelsByPath[dir]={path:dir,name:data.name||dir.split('/').pop()||'Root',classes:[],submodels:[]});
          if(data.name) model.name = data.name;
          if(Array.isArray(data.classes)){
            for(const c of data.classes){
              const id = c.id || makeId(dir + ':' + c.name);
              const cls = {
                id,
                name: c.name || id,
                homeModelPath: dir,
                refs: Array.isArray(c.refs)? c.refs.slice(): [],
              };
              classesById[id]=cls;
              classesByFQN[dir + '/' + cls.name] = cls;
              model.classes.push(id);
            }
          }
        }catch(e){ console.warn('Failed to parse', path, e); }
      }
    }

    // classes/*.json
    for(const [path, file] of vfs){
      const segs = path.split('/');
      if(segs.length>=2 && segs[segs.length-2]==='classes' && segs[segs.length-1].endsWith('.json')){
        const dir = segs.slice(0,-2).join('/');
        try{
          const txt = await file.text();
          const c = JSON.parse(txt);
          const id = c.id || makeId(dir + ':' + c.name);
          const cls = {
            id,
            name: c.name || id,
            homeModelPath: dir,
            refs: Array.isArray(c.refs)? c.refs.slice(): [],
          };
          if(!modelsByPath[dir]){
            modelsByPath[dir] = { path: dir, name: dir.split('/').pop()||'Root', classes: [], submodels: [] };
          }
          classesById[id]=cls;
          classesByFQN[dir + '/' + cls.name] = cls;
          modelsByPath[dir].classes.push(id);
        }catch(e){ console.warn('Failed to parse class file', path, e); }
      }
    }

    return { modelsByPath, classesById, classesByFQN };
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

    // Simple grid
    const cols = Math.max(1, Math.floor((1200 - margin*2)/(boxW+gapX)));
    nodes.forEach((n,i)=>{
      n.x = margin + (i % cols) * (boxW+gapX);
      n.y = margin + Math.floor(i / cols) * (boxH+gapY) + 40; // leave space for header
    });

    // Edges: from local classes to their refs
    const edges = [];
    for(const c of localClasses){
      for(const r of c.refs||[]){
        const t = resolveRef(r, model.path);
        if(!t) continue;
        const src = nodes.find(n=>n.id===c.id);
        const dst = nodes.find(n=>n.id===t.id);
        // if target not in nodes and is not local/visiting set (unresolvable in this model), skip drawing
        if(!src || !dst) continue;
        edges.push({src, dst});
      }
    }

    // Draw edges first
    for(const e of edges){
      const {x:x1,y:y1} = centerRight(e.src, boxW, boxH);
      const {x:x2,y:y2} = centerLeft(e.dst, boxW, boxH);
      const midX = (x1 + x2)/2;
      const d = `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}`;
      const path = createSVG('path', { d, class: 'edge' });
      svg.appendChild(path);
    }

    // Draw nodes
    for(const n of nodes){
      const g = createSVG('g', {});
      const rect = createSVG('rect', {
        x: n.x, y: n.y, width: boxW, height: boxH, rx: 8, ry: 8,
        class: 'class-box' + (n._visiting? ' visiting':'')
      });
      const label = createSVG('text', {
        x: n.x + 12, y: n.y + 24, class: 'class-label'
      });
      label.textContent = n.name;
      const sub = createSVG('text', {
        x: n.x + 12, y: n.y + 44, class: 'class-label', fill: '#555'
      });
      sub.textContent = n._visiting ? `(from ${n.homeModelPath||'Root'})` : '';

      g.appendChild(rect);
      g.appendChild(label);
      g.appendChild(sub);
      svg.appendChild(g);
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

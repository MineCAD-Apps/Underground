const LAYERS = [
  { key: 'bombeo', color: 0x56d8ff },
  { key: 'electricidad', color: 0xffda58 }
];
const LINE_WIDTH = 3;

export function parseUtilityPolylines(text) {
  const data = JSON.parse(text.replace(/^\uFEFF/, ''));
  const obras = Array.isArray(data) ? data : data?.obras;
  if (!Array.isArray(obras) || !obras.length) {
    throw new Error('El JSON debe contener una lista de obras con vértices 3D.');
  }

  return obras.map((obra, index) => {
    const vertices = obra?.vertices;
    if (!Array.isArray(vertices) || vertices.length < 2 || vertices.some(point =>
      !Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)
    )) {
      throw new Error(`Línea ${index + 1}: se requieren al menos dos vértices [X, Y, Z].`);
    }
    return vertices;
  });
}

export function createUtilityLayers(THREE, sceneGroup, cadToScene) {
  const zoneStates = new WeakMap();
  const wideLines = THREE.LineSegments2 && THREE.LineSegmentsGeometry && THREE.LineMaterial;
  let active = null;

  const layers = LAYERS.map(({ key, color }) => {
    const group = new THREE.Group();
    const style = { color, transparent: true, depthTest: false, depthWrite: false };
    const material = wideLines
      ? new THREE.LineMaterial({ ...style, linewidth: LINE_WIDTH, alphaToCoverage: true })
      : new THREE.LineBasicMaterial(style);
    const toggle = document.getElementById(`utility-${key}`);
    const file = document.getElementById(`utility-${key}-file`);
    const status = document.getElementById(`utility-${key}-status`);
    const layer = { key, group, material, toggle, file, status };
    sceneGroup.add(group);

    toggle.addEventListener('change', () => {
      active.states[key].visible = group.visible = toggle.checked;
    });
    file.addEventListener('change', async () => {
      const source = file.files[0];
      if (!source || !active) return;
      file.value = '';
      const context = active;
      const state = context.states[key];
      const read = ++state.read;
      file.disabled = true;
      status.textContent = 'Leyendo líneas…';
      try {
        const polylines = parseUtilityPolylines(await source.text());
        if (active !== context || read !== state.read) return;
        Object.assign(state, { polylines, visible: true });
        render(layer);
      } catch (error) {
        if (active === context && read === state.read) {
          status.textContent = `No se pudo cargar ${source.name}. ${error.message}`;
        }
      } finally {
        if (active === context && read === state.read) file.disabled = false;
      }
    });
    return layer;
  });

  function render({ key, group, material, toggle, file, status }) {
    for (const line of group.children.slice()) {
      group.remove(line);
      line.geometry.dispose();
    }

    const state = active?.states[key];
    const polylines = state?.polylines;
    file.disabled = !active;
    toggle.disabled = !polylines;
    toggle.checked = group.visible = Boolean(polylines && state.visible);
    status.textContent = polylines ? `${polylines.length} líneas` : '';
    if (!polylines) return;

    const segments = [];
    const previous = new THREE.Vector3();
    const point = new THREE.Vector3();
    // Use the STL transform and offset so CAD service lines share the same scene.
    for (const vertices of polylines) {
      previous.set(...vertices[0]).applyMatrix4(cadToScene).sub(active.origin);
      for (let i = 1; i < vertices.length; i++) {
        point.set(...vertices[i]).applyMatrix4(cadToScene).sub(active.origin);
        if (point.equals(previous)) continue;
        segments.push(previous.x, previous.y, previous.z, point.x, point.y, point.z);
        previous.copy(point);
      }
    }
    if (!segments.length) return;

    const positions = new Float32Array(segments);
    const line = wideLines
      ? new THREE.LineSegments2(new THREE.LineSegmentsGeometry().setPositions(positions), material)
      : new THREE.LineSegments(new THREE.BufferGeometry()
        .setAttribute('position', new THREE.BufferAttribute(positions, 3)), material);
    line.renderOrder = 5;
    group.add(line);
  }

  async function loadConfigured(layer, path, context) {
    const state = context.states[layer.key];
    const read = ++state.read;
    layer.status.textContent = 'Cargando líneas…';
    try {
      const response = await fetch(context.zone.path + path);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const polylines = parseUtilityPolylines(await response.text());
      if (active !== context || read !== state.read) return;
      state.polylines = polylines;
      render(layer);
    } catch (error) {
      if (active === context && read === state.read) {
        layer.status.textContent = `No se pudo cargar ${path}. ${error.message}`;
      }
    }
  }

  return {
    setViewport(width, height) {
      if (!wideLines) return;
      for (const { material } of layers) {
        material.resolution.set(Math.max(1, width), Math.max(1, height));
      }
    },
    setZone(zone, origin) {
      if (zone && !zoneStates.has(zone)) {
        zoneStates.set(zone, Object.fromEntries(LAYERS.map(({ key }) =>
          [key, { polylines: null, visible: false, read: 0 }]
        )));
      }
      active = zone ? { zone, origin, states: zoneStates.get(zone) } : null;
      layers.forEach(layer => {
        render(layer);
        const path = zone?.servicios?.[layer.key];
        if (typeof path === 'string' && path && !active.states[layer.key].polylines) {
          loadConfigured(layer, path, active);
        }
      });
    }
  };
}

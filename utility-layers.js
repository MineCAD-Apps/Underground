const LAYERS = [
  { key: 'bombeo', label: 'Bombeo', color: 0xfff34b },
  { key: 'instalacion-electrica', label: 'Instalación eléctrica', color: 0xff70e8 },
  { key: 'rutas-acarreo', label: 'Rutas de acarreo', color: 0x4dffb0 }
];
const LINE_WIDTH = 4;

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
    ) || vertices.every(point => point.every((value, axis) => value === vertices[0][axis]))) {
      throw new Error(`Línea ${index + 1}: se requieren al menos dos vértices [X, Y, Z].`);
    }
    return vertices;
  });
}

export function createUtilityLayers(THREE, sceneGroup, cadToScene, onVisibilityChange = () => {}) {
  const zoneStates = new WeakMap();
  const wideLines = THREE.LineSegments2 && THREE.LineSegmentsGeometry && THREE.LineMaterial;
  let active = null;

  const status = document.getElementById('network-status');
  const layers = LAYERS.map(({ key, label, color }) => {
    const group = new THREE.Group();
    const style = { color, transparent: true, depthTest: false, depthWrite: false };
    const material = wideLines
      ? new THREE.LineMaterial({ ...style, linewidth: LINE_WIDTH, alphaToCoverage: true })
      : new THREE.LineBasicMaterial(style);
    const toggle = document.getElementById(`utility-${key}`);
    toggle.disabled = true;
    const layer = { key, label, group, material, toggle };
    sceneGroup.add(group);
    toggle.addEventListener('click', async () => {
      if (!active) return;
      const context = active;
      const state = context.states[key];
      if (!state.polylines) {
        toggle.disabled = true;
        toggle.setAttribute('aria-busy', 'true');
        status.textContent = 'Cargando ' + label.toLowerCase() + '…';
        try {
          const response = await fetch(context.zone.path + key + '.json');
          if (!response.ok) throw new Error(response.status === 404 ? 'Falta ' + key + '.json en la carpeta de esta mina.' : 'HTTP ' + response.status);
          const polylines = parseUtilityPolylines(await response.text());
          if (active !== context) return;
          state.polylines = polylines;
        } catch (error) {
          if (active === context) status.textContent = label + '. ' + error.message;
          return;
        } finally {
          if (active === context) {
            toggle.disabled = false;
            toggle.removeAttribute('aria-busy');
          }
        }
      }
      if (active !== context) return;
      state.visible = !state.visible;
      status.textContent = '';
      render(layer);
      notify();
    });
    return layer;
  });

  function render({ key, group, material, toggle }) {
    for (const line of group.children.slice()) {
      group.remove(line);
      line.geometry.dispose();
    }

    const state = active?.states[key];
    const polylines = state?.polylines;
    toggle.disabled = !active;
    toggle.removeAttribute('aria-busy');
    group.visible = Boolean(polylines && state.visible);
    toggle.classList.toggle('active', group.visible);
    toggle.setAttribute('aria-pressed', String(group.visible));
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

  function notify() {
    onVisibilityChange(layers.some(({ group }) => group.visible));
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
          [key, { polylines: null, visible: false }]
        )));
      }
      active = zone ? { zone, origin, states: zoneStates.get(zone) } : null;
      status.textContent = '';
      layers.forEach(render);
      notify();
    }
  };
}

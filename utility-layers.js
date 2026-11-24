const LAYERS = [
  { key: 'bombeo', label: 'Bombeo', color: 0xfff34b },
  { key: 'instalacion-electrica', label: 'Instalación eléctrica', color: 0xff70e8 },
  { key: 'rutas-acarreo', label: 'Rutas de acarreo', color: 0x4dffb0 }
];
const LINE_WIDTH = 4;

export function parseUtilityPolylines(text) {
  return parseUtilityNetwork(text).polylines;
}

export function parseUtilityNetwork(text) {
  const data = JSON.parse(text.replace(/^\uFEFF/, ''));
  const obras = Array.isArray(data) ? data : data?.obras;
  if (!Array.isArray(obras)) {
    throw new Error('El JSON debe contener una lista de obras con vértices 3D.');
  }

  const polylines = obras.map((obra, index) => {
    const vertices = obra?.vertices;
    if (!Array.isArray(vertices) || vertices.length < 2 || vertices.some(point =>
      !Array.isArray(point) || point.length !== 3 || !point.every(Number.isFinite)
    ) || vertices.every(point => point.every((value, axis) => value === vertices[0][axis]))) {
      throw new Error(`Línea ${index + 1}: se requieren al menos dos vértices [X, Y, Z].`);
    }
    return vertices;
  });
  const sourceLabels = Array.isArray(data) ? [] : (data.etiquetas ?? []);
  if (!Array.isArray(sourceLabels)) throw new Error('Las etiquetas deben ser una lista.');
  const etiquetas = sourceLabels.map((label, index) => {
    if (typeof label?.texto !== 'string' || !label.texto.trim() ||
        !Array.isArray(label.posicion) || label.posicion.length !== 3 ||
        !label.posicion.every(Number.isFinite) ||
        (label.prioridad !== undefined && !Number.isFinite(label.prioridad))) {
      throw new Error(`Etiqueta ${index + 1}: se requieren texto y posicion [X, Y, Z].`);
    }
    return label;
  });
  if (!polylines.length && !etiquetas.length) throw new Error('La red no contiene líneas ni etiquetas.');
  return { polylines, etiquetas };
}

export function createUtilityLayers(THREE, sceneGroup, cadToScene, onVisibilityChange = () => {}) {
  const zoneStates = new WeakMap();
  const wideLines = THREE.LineSegments2 && THREE.LineSegmentsGeometry && THREE.LineMaterial;
  let active = null;
  const container = document.getElementById('canvas-container');
  const labelOverlay = document.createElement('div');
  labelOverlay.id = 'network-labels';
  // Keep labels positioned even when an older HTML stylesheet is cached.
  Object.assign(labelOverlay.style, {
    position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', zIndex: '3'
  });
  container.appendChild(labelOverlay);
  const coneAxis = new THREE.Vector3(0, 1, 0);
  const transform = new THREE.Object3D();
  const worldPoint = new THREE.Vector3();
  const cameraPoint = new THREE.Vector3();
  const pathPoint = new THREE.Vector3();
  let viewportHeight = 1;
  let animationTime = 0;
  let lastTimestamp = null;

  const status = document.getElementById('network-status');
  const layers = LAYERS.map(({ key, label, color }) => {
    const group = new THREE.Group();
    const style = { color, transparent: true, depthTest: false, depthWrite: false };
    const material = wideLines
      ? new THREE.LineMaterial({ ...style, linewidth: LINE_WIDTH, alphaToCoverage: true })
      : new THREE.LineBasicMaterial(style);
    const toggle = document.getElementById(`utility-${key}`);
    toggle.disabled = true;
    const layer = { key, label, color, group, material, toggle, paths: [], labels: [], cones: null };
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
          const response = await fetch(context.zone.path + key + '.json', { cache: 'no-store' });
          if (!response.ok) throw new Error(response.status === 404 ? 'Falta ' + key + '.json en la carpeta de esta mina.' : 'HTTP ' + response.status);
          const data = parseUtilityNetwork(await response.text());
          if (active !== context) return;
          Object.assign(state, data);
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

  function render(layer) {
    const { key, group, material, toggle } = layer;
    layer.labels.forEach(({ element }) => element.remove());
    layer.labels = [];
    layer.paths = [];
    if (layer.cones) {
      layer.cones.material.dispose();
      layer.cones = null;
    }
    for (const line of group.children.slice()) {
      group.remove(line);
      line.geometry.dispose();
      if (line.isInstancedMesh) line.dispose();
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
      const path = { segments: [], length: 0 };
      previous.set(...vertices[0]).applyMatrix4(cadToScene).sub(active.origin);
      for (let i = 1; i < vertices.length; i++) {
        point.set(...vertices[i]).applyMatrix4(cadToScene).sub(active.origin);
        if (point.equals(previous)) continue;
        const length = previous.distanceTo(point);
        path.segments.push({
          start: previous.clone(), direction: point.clone().sub(previous).divideScalar(length),
          offset: path.length, length
        });
        path.length += length;
        segments.push(previous.x, previous.y, previous.z, point.x, point.y, point.z);
        previous.copy(point);
      }
      path.count = Math.max(1, Math.min(32, Math.ceil(path.length / 60)));
      layer.paths.push(path);
    }

    if (segments.length) {
      const positions = new Float32Array(segments);
      const line = wideLines
        ? new THREE.LineSegments2(new THREE.LineSegmentsGeometry().setPositions(positions), material)
        : new THREE.LineSegments(new THREE.BufferGeometry()
          .setAttribute('position', new THREE.BufferAttribute(positions, 3)), material);
      line.renderOrder = 5;
      group.add(line);
      const count = layer.paths.reduce((total, path) => total + path.count, 0);
      layer.cones = new THREE.InstancedMesh(
        new THREE.ConeGeometry(0.45, 1.5, 10),
        new THREE.MeshBasicMaterial({ color: layer.color, depthTest: false, depthWrite: false, transparent: true }),
        count
      );
      layer.cones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      layer.cones.frustumCulled = false;
      layer.cones.visible = false;
      layer.cones.renderOrder = 6;
      group.add(layer.cones);
    }
    for (const label of state.etiquetas) {
      const element = document.createElement('div');
      element.className = 'network-label';
      Object.assign(element.style, {
        position: 'absolute', padding: '4px 8px', border: '1px solid', borderRadius: '4px',
        background: 'rgba(5, 14, 24, 0.94)', color: '#f3f8ff', fontSize: '13px',
        lineHeight: '1.35', whiteSpace: 'pre', maxWidth: '300px', overflow: 'hidden',
        textOverflow: 'ellipsis', boxShadow: '0 1px 6px #000'
      });
      element.textContent = label.texto.replace(/%%d/gi, '°').replace(/%%p/gi, '±')
        .replace(/%%c/gi, '⌀').replace(/%%[uok]/gi, '');
      element.style.borderColor = '#' + layer.color.toString(16).padStart(6, '0');
      const horizontal = [1, 4].includes(label.alineacionH) ? 50 : label.alineacionH === 2 ? 100 : 0;
      const vertical = label.alineacionV === 3 ? 0 : label.alineacionV === 2 || label.alineacionH === 4 ? 50 : 100;
      element.style.transform = `translate(-${horizontal}%, -${vertical}%)`;
      element.hidden = true;
      element.style.display = 'none';
      labelOverlay.appendChild(element);
      layer.labels.push({
        element, horizontal, vertical, prioridad: label.prioridad ?? 0,
        position: new THREE.Vector3(...label.posicion).applyMatrix4(cadToScene).sub(active.origin)
      });
    }
  }

  function notify() {
    onVisibilityChange(layers.some(({ group }) => group.visible));
  }

  return {
    update(timestamp, camera) {
      // Freeze when hidden or the browser suspends animation, avoiding a large jump on return.
      if (lastTimestamp !== null && layers.some(layer => layer.group.visible)) {
        animationTime += Math.min(0.1, Math.max(0, (timestamp - lastTimestamp) / 1000));
      }
      lastTimestamp = timestamp;
      camera.updateMatrixWorld(true);
      const labelScale = window.matchMedia('(max-width: 600px), (pointer: coarse)').matches ? 0.6 : 1;
      const labels = layers.flatMap(layer => layer.labels.map(label => ({
        ...label, visible: layer.group.visible
      }))).sort((a, b) => b.prioridad - a.prioridad);
      let rank = labels.length;
      for (const { element, position, horizontal, vertical, visible } of labels) {
        element.style.zIndex = String(rank--);
        element.style.transformOrigin = horizontal + '% ' + vertical + '%';
        element.style.transform = 'translate(-' + horizontal + '%, -' + vertical + '%) scale(' + labelScale + ')';
        worldPoint.copy(position).applyMatrix4(sceneGroup.matrixWorld).project(camera);
        element.hidden = !visible || worldPoint.z < -1 || worldPoint.z > 1 ||
          Math.abs(worldPoint.x) > 1 || Math.abs(worldPoint.y) > 1;
        element.style.display = element.hidden ? 'none' : 'block';
        if (element.hidden) continue;

        const x = (worldPoint.x + 1) * 0.5 * container.clientWidth;
        const y = (1 - worldPoint.y) * 0.5 * container.clientHeight;
        element.style.left = x + 'px';
        element.style.top = y + 'px';
      }
      for (const layer of layers) {
        if (!layer.group.visible || !layer.cones) continue;
        let index = 0;
        for (const path of layer.paths) {
          pathPoint.copy(path.segments[0].start).applyMatrix4(sceneGroup.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
          const pathViewHeight = camera.isOrthographicCamera ? (camera.top - camera.bottom) / camera.zoom :
            2 * Math.max(camera.near, -pathPoint.z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / camera.zoom;
          // Keep cones apart at overview zoom, where overlapping cones can obscure their direction.
          const visibleCount = Math.max(1, Math.min(path.count, Math.floor(path.length * viewportHeight / pathViewHeight / 60)));
          for (let i = 0; i < visibleCount; i++) {
            const speed = Math.min(8, path.length / 5);
            const distance = (i * path.length / visibleCount + animationTime * speed) % path.length;
            let lower = 0;
            let upper = path.segments.length - 1;
            while (lower < upper) {
              const middle = Math.ceil((lower + upper) / 2);
              if (path.segments[middle].offset <= distance) lower = middle;
              else upper = middle - 1;
            }
            const segment = path.segments[lower];
            transform.position.copy(segment.start).addScaledVector(segment.direction, distance - segment.offset);
            transform.quaternion.setFromUnitVectors(coneAxis, segment.direction);
            worldPoint.copy(transform.position).applyMatrix4(sceneGroup.matrixWorld);
            cameraPoint.copy(worldPoint).applyMatrix4(camera.matrixWorldInverse);
            const viewHeight = camera.isOrthographicCamera ? (camera.top - camera.bottom) / camera.zoom :
              2 * Math.max(camera.near, -cameraPoint.z) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) / camera.zoom;
            transform.scale.setScalar(12 * viewHeight / viewportHeight);
            transform.updateMatrix();
            layer.cones.setMatrixAt(index++, transform.matrix);
          }
        }
        layer.cones.instanceMatrix.needsUpdate = true;
        layer.cones.count = index;
        layer.cones.visible = true;
      }
    },
    setViewport(width, height) {
      viewportHeight = Math.max(1, height);
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

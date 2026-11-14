const REQUIRED_COLUMNS = ['truck_id', 'time_s', 'x', 'y', 'z'];
const CSV_ROW = /^(?:"(?:[^"]|"")*"|[^",]*)(?:,(?:"(?:[^"]|"")*"|[^",]*))*$/;
const CSV_FIELD = /,(?:"((?:[^"]|"")*)"|([^",]*))/g;

function readRow(line, number) {
  if (!CSV_ROW.test(line)) throw new Error(`Fila ${number}: CSV mal formado.`);
  return Array.from((',' + line).matchAll(CSV_FIELD), ([, quoted, plain]) =>
    (quoted === undefined ? plain : quoted.replaceAll('""', '"')).trim()
  );
}

export function parseRouteCsv(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const header = readRow(lines[0], 1);
  const columns = REQUIRED_COLUMNS.map(name => header.indexOf(name));
  if (columns.includes(-1) || new Set(header).size !== header.length) {
    throw new Error('El CSV debe incluir las columnas truck_id, time_s, x, y, z sin repetirlas.');
  }

  const trucks = new Map();
  let start = Infinity;
  let end = -Infinity;
  for (let index = 1; index < lines.length; index++) {
    if (!lines[index].trim()) continue;
    const row = readRow(lines[index], index + 1);
    const [id, ...values] = columns.map(column => row[column]);
    const [time, x, y, z] = values.map(Number);
    if (row.length !== header.length || !id || values.some(value => !value) ||
        ![time, x, y, z].every(Number.isFinite) || time < 0) {
      throw new Error(`Fila ${index + 1}: revisa el identificador, el tiempo y las coordenadas.`);
    }

    if (!trucks.has(id)) trucks.set(id, new Map());
    // If a unit reports twice at the same time, use the last reported position.
    trucks.get(id).set(time, { time, x, y, z });
    start = Math.min(start, time);
    end = Math.max(end, time);
  }

  if (!trucks.size) throw new Error('El CSV no contiene posiciones.');

  const tracks = Array.from(trucks, ([id, samples]) => ({
    id,
    samples: Array.from(samples.values()).sort((a, b) => a.time - b.time)
  }));
  return { tracks, start, end };
}

function positionAt(samples, time, target) {
  if (time < samples[0].time || time > samples.at(-1).time) return false;

  let lower = 0;
  let upper = samples.length - 1;
  while (upper - lower > 1) {
    const middle = Math.floor((lower + upper) / 2);
    if (samples[middle].time <= time) lower = middle;
    else upper = middle;
  }

  const a = samples[lower];
  const b = samples[upper];
  target.copy(a.position);
  if (upper !== lower) target.lerp(b.position, (time - a.time) / (b.time - a.time));
  return true;
}

export function createRoutePlayback(THREE, sceneGroup, cadToScene, palette) {
  const file = document.getElementById('route-file');
  const status = document.getElementById('route-status');
  const controls = document.getElementById('route-controls');
  const vehicles = document.getElementById('route-vehicle');
  const timeline = document.getElementById('route-timeline');
  const timeLabel = document.getElementById('route-time');
  const play = document.getElementById('route-play');
  const restart = document.getElementById('route-restart');
  const clear = document.getElementById('route-clear');
  const number = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 2 });

  const layer = new THREE.Group();
  sceneGroup.add(layer);
  let origin = null;
  let tracks = [];
  let duration = 0;
  let elapsed = 0;
  let playing = false;
  let lastFrame = null;
  let pendingRead = 0;

  function setPlaying(value) {
    playing = value;
    lastFrame = null;
    play.textContent = playing ? 'Pausar' : 'Reproducir';
  }

  function showTime(value) {
    elapsed = value;
    timeline.value = value;
    timeLabel.textContent = `${number.format(value)} / ${number.format(duration)} s`;
    const selected = vehicles.value;
    tracks.forEach(({ id, samples, line, marker }) => {
      const show = !selected || selected === id;
      line.visible = show;
      marker.visible = show && positionAt(samples, value, marker.position);
    });
  }

  function removeTracks() {
    setPlaying(false);
    layer.children.slice().forEach(object => {
      layer.remove(object);
      object.geometry.dispose();
      object.material.dispose();
    });
    tracks = [];
    controls.hidden = true;
  }

  function reset() {
    pendingRead++;
    file.value = '';
    status.textContent = '';
    removeTracks();
  }

  function loadTracks(data) {
    removeTracks();
    vehicles.replaceChildren(new Option('Todos', ''));
    tracks = data.tracks.map(({ id, samples }, index) => {
      const color = palette[index % palette.length];
      const points = samples.map(sample => {
        sample.time -= data.start;
        sample.position = new THREE.Vector3(sample.x, sample.y, sample.z)
          .applyMatrix4(cadToScene).sub(origin);
        return sample.position;
      });
      // Underground STL shells can enclose the paths, so draw them over the models.
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, opacity: 0.65 })
      );
      const marker = new THREE.Points(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3()]),
        new THREE.PointsMaterial({
          color, depthTest: false, depthWrite: false, transparent: true, size: 8, sizeAttenuation: false
        })
      );
      line.renderOrder = 10;
      marker.renderOrder = 11;
      layer.add(line, marker);
      vehicles.add(new Option(id, id));
      return { id, samples, line, marker };
    });
    duration = data.end - data.start;
    timeline.max = duration;
    timeline.disabled = play.disabled = restart.disabled = duration === 0;
    controls.hidden = false;
    showTime(0);
  }

  file.addEventListener('change', async () => {
    const source = file.files[0];
    if (!source || !origin) return;
    const request = ++pendingRead;
    file.value = '';
    status.textContent = 'Leyendo posiciones…';
    try {
      const text = await source.text();
      if (request !== pendingRead) return;
      loadTracks(parseRouteCsv(text));
      status.textContent = source.name;
    } catch (error) {
      if (request === pendingRead) status.textContent = error.message;
    }
  });

  vehicles.addEventListener('change', () => showTime(elapsed));
  timeline.addEventListener('input', () => showTime(timeline.valueAsNumber));
  play.addEventListener('click', () => {
    if (!playing && elapsed === duration) showTime(0);
    setPlaying(!playing);
  });
  restart.addEventListener('click', () => {
    setPlaying(false);
    showTime(0);
  });
  clear.addEventListener('click', reset);

  return {
    setOrigin(center) {
      reset();
      origin = center;
      file.disabled = !origin;
    },
    update(timestamp) {
      if (!playing) return;
      if (lastFrame !== null) {
        showTime(Math.min(duration, elapsed + (timestamp - lastFrame) / 1000));
      }
      lastFrame = timestamp;
      if (elapsed === duration) setPlaying(false);
    }
  };
}

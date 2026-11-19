const vertexSource = `
attribute vec2 position;
varying vec2 point;
void main() {
  point = position;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const fragmentSource = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

varying vec2 point;
uniform float seconds;
uniform float dark;
uniform vec2 pointer;

void main() {
  float turn = seconds * .38;
  float angle = atan(point.y, point.x + .00001);
  float outline = .953 + .012 * sin(angle * 3.0 + turn) + .007 * sin(angle * 5.0 - .7 * turn);
  vec2 p = point / outline;
  float distance = length(p);
  if (distance > 1.005) discard;

  float depth = sqrt(max(0.0, 1.0 - dot(p, p)));
  vec3 sphere = vec3(p, depth);
  vec2 fold = p - vec2(.36 + .16 * cos(turn * .78), .28 + .19 * sin(turn * .72));
  vec2 surfaceFlow = fold * exp(-dot(fold, fold) * 6.5) * .93;
  vec3 normal = normalize(sphere + vec3(
    surfaceFlow.x + .095 * sin(p.y * 5.1 - p.x * 2.4 + turn),
    surfaceFlow.y + .115 * sin(p.x * 4.7 + p.y * 2.8 - turn * .88),
    0.0
  ));

  // Broad colour currents beneath the reflective surface.
  float current = sin(3.8 * sphere.x - 2.7 * sphere.y + 1.9 * depth + turn
    + .7 * sin(3.3 * sphere.y + turn * .72));
  float wash = sin(1.8 * sphere.x + 3.3 * sphere.y - depth + turn * .65);
  vec3 ice = vec3(.69, .82, .91);
  vec3 ink = vec3(.20, .38, .53);
  vec3 jade = vec3(.38, .72, .65);
  vec3 lavender = vec3(.61, .60, .78);
  vec3 crema = vec3(.89, .63, .38);
  vec3 pearl = vec3(.96, .94, .84);
  vec3 colour = mix(ice, jade, smoothstep(-.8, .87, current));
  colour = mix(colour, lavender, smoothstep(.2, .96, wash) * .68);
  float amber = smoothstep(.04, .79, p.x * .73 + p.y * .53)
    * smoothstep(-.45, .72, sin(p.x * 3.2 - p.y * 2.9 + turn * .94));
  colour = mix(colour, crema, amber * .92);
  float shade = smoothstep(.05, .89, -p.y * .76 - p.x * .31 + .14 * wash);
  colour = mix(colour, ink, shade * (.57 + .12 * dark));

  vec3 window = normalize(vec3(-.43 + pointer.x * .12, .57 - pointer.y * .12, .77));
  float lighting = max(dot(normal, window), 0.0);
  colour = mix(colour, pearl, pow(lighting, 4.4) * .69);
  float reflection = pow(lighting, 38.0);
  float caustic = pow(max(0.0, dot(normal, normalize(vec3(.63, .24, .79)))), 30.0);
  colour = mix(colour, vec3(1.0, .982, .93), min(1.0, reflection * .91 + caustic * .62));
  float edge = pow(1.0 - depth, 2.45);
  vec3 rim = mix(ice, crema, smoothstep(-.18, .88, p.x));
  colour = mix(colour, rim, edge * (.39 + .25 * lighting));
  colour *= 1.0 - edge * (.12 + .13 * shade + dark * .05);

  // A slight grain keeps smooth tones from banding at display resolution.
  float grain = fract(sin(dot(gl_FragCoord.xy, vec2(41.37, 73.19))) * 15731.27) - .5;
  gl_FragColor = vec4(clamp(colour + grain * .022, 0.0, 1.0), 1.0 - smoothstep(.993, 1.005, distance));
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

function orbRenderer(canvas) {
  const gl = canvas.getContext('webgl', {
    alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'low-power',
  });
  if (!gl || gl.isContextLost()) return null;

  const vertex = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (vertex && fragment && program) {
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
  }
  if (vertex) gl.deleteShader(vertex);
  if (fragment) gl.deleteShader(fragment);
  if (!program || !gl.getProgramParameter(program, gl.LINK_STATUS)) {
    if (program) gl.deleteProgram(program);
    return null;
  }

  gl.useProgram(program);
  const buffer = gl.createBuffer();
  if (!buffer) return null;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const seconds = gl.getUniformLocation(program, 'seconds');
  const dark = gl.getUniformLocation(program, 'dark');
  const pointer = gl.getUniformLocation(program, 'pointer');
  gl.clearColor(0, 0, 0, 0);

  return {
    paint(time, night, x, y) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(seconds, time);
      gl.uniform1f(dark, night ? 1 : 0);
      gl.uniform2f(pointer, x, y);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

function revealSections(hero, reduce) {
  if (reduce.matches) return;
  const observer = new IntersectionObserver(entries => {
    for (const { isIntersecting, target } of entries) {
      if (!isIntersecting) continue;
      observer.unobserve(target);
      if (!reduce.matches) target.classList.add('home-arrival');
    }
  }, { threshold: .14 });
  for (const item of hero.parentElement.querySelectorAll('.editorial-roastery, .editorial-discovery')) {
    observer.observe(item);
  }
}

export function mountOrb(hero) {
  const canvas = hero.querySelector('.orb-canvas');
  const disc = hero.querySelector('.orb-disc');
  const drift = hero.querySelector('.orb-drift');
  const toggle = hero.querySelector('.orb-motion');
  const label = toggle.querySelector('.orb-motion-label');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const night = matchMedia('(prefers-color-scheme: dark)');
  let renderer = orbRenderer(canvas);
  let visible = false;
  let paused = false;
  let frame = 0;
  let lastPaint = 0;
  let time = 1.2;
  let x = 0, y = 0;
  let targetX = 0, targetY = 0;

  revealSections(hero, reduced);
  if (!renderer) return;
  const paint = () => renderer?.paint(time, night.matches, x / 12, y / 12);
  const running = () => renderer && visible && !paused && !reduced.matches && !document.hidden;

  function tick(now) {
    frame = 0;
    if (!running()) return;
    if (now - lastPaint >= 31) {
      time += lastPaint ? Math.min(now - lastPaint, 66) / 1000 : 0;
      lastPaint = now;
      x += (targetX - x) * .12;
      y += (targetY - y) * .12;
      drift.style.setProperty('--orb-x', x.toFixed(2) + 'px');
      drift.style.setProperty('--orb-y', y.toFixed(2) + 'px');
      paint();
    }
    frame = requestAnimationFrame(tick);
  }

  function syncMotion() {
    toggle.hidden = !renderer || reduced.matches;
    toggle.toggleAttribute('data-paused', paused);
    label.textContent = paused ? 'Play motion' : 'Pause motion';
    if (running()) {
      if (!frame) frame = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(frame);
      lastPaint = 0;
      frame = 0;
      if (reduced.matches) {
        x = y = targetX = targetY = 0;
        drift.style.removeProperty('--orb-x');
        drift.style.removeProperty('--orb-y');
        paint();
      }
    }
  }

  function sizeCanvas() {
    const side = Math.max(1, Math.min(620, Math.round(disc.clientWidth * Math.min(devicePixelRatio, 1.4))));
    if (canvas.width !== side || canvas.height !== side) {
      canvas.width = side;
      canvas.height = side;
    }
    paint();
  }

  sizeCanvas();
  disc.classList.add('orb-ready');
  syncMotion();
  new ResizeObserver(sizeCanvas).observe(disc);
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    syncMotion();
  }).observe(disc);

  hero.addEventListener('pointermove', event => {
    if (!running() || event.pointerType === 'touch') return;
    const box = hero.getBoundingClientRect();
    targetX = ((event.clientX - box.left) / box.width - .5) * 24;
    targetY = ((event.clientY - box.top) / box.height - .5) * 18;
  }, { passive: true });
  hero.addEventListener('pointerleave', () => { targetX = targetY = 0; });
  toggle.addEventListener('click', () => { paused = !paused; syncMotion(); });
  document.addEventListener('visibilitychange', syncMotion);
  reduced.addEventListener('change', syncMotion);
  night.addEventListener('change', paint);

  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault();
    renderer = null;
    disc.classList.remove('orb-ready');
    syncMotion();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    renderer = orbRenderer(canvas);
    if (renderer) {
      sizeCanvas();
      disc.classList.add('orb-ready');
    }
    syncMotion();
  });
}

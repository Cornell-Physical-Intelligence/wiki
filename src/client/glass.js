/* One shared WebGL material for every floating surface. The browser samples
   the backdrop; this fragment shader supplies the curved edge lighting and
   subtle internal shade. Render once on open/resize/theme, never a RAF loop. */
(() => {
  const selector = '.toast, .menu, .modal, .palette, .linkpreview, .ed-autocomplete, .findbar';
  const surfaces = new Set(), sizes = new WeakMap();
  const contrast = matchMedia('(prefers-contrast: more)');
  const transparency = matchMedia('(prefers-reduced-transparency: reduce)');
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  let renderer, unavailable = false, queued = false;

  function createRenderer() {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    if (!gl) return null;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault(); renderer = null; unavailable = true;
      for (const el of surfaces) el.style.removeProperty('--glass-shader');
    });
    canvas.addEventListener('webglcontextrestored', () => { unavailable = false; refresh(true); });
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { gl.deleteShader(shader); return null; }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, 'attribute vec2 a; void main(){gl_Position=vec4(a,0.0,1.0);}');
    const fragment = compile(gl.FRAGMENT_SHADER, `
      precision mediump float;
      uniform vec2 size;
      uniform float radius;
      uniform float exponent;
      uniform float dark;
      float roundedBox(vec2 p, vec2 b, float r) {
        vec2 q = abs(p) - b + r;
        vec2 unit = max(q,0.0) / max(r,0.01);
        float norm = pow(pow(unit.x,exponent) + pow(unit.y,exponent),1.0/exponent);
        // Divide by the implicit gradient so the fine rim stays an even
        // width around the same continuous corner used by the CSS surface.
        float gradient = norm > 0.1 ? length(pow(unit,vec2(exponent-1.0))) / pow(norm,exponent-1.0) : 1.0;
        return min(max(q.x,q.y),0.0) + (norm-1.0)*r / max(gradient,0.01);
      }
      void main() {
        vec2 p = gl_FragCoord.xy - size * 0.5;
        float d = roundedBox(p, size * 0.5 - 0.6, radius);
        // Thin opposing highlights describe a rounded lens, with a clear
        // center. No animated noise or broad gray inner ring.
        float rim = exp(-pow((d + 0.85) / 0.8, 2.0));
        float shoulder = exp(-pow((d + 2.8) / 2.2, 2.0));
        vec2 normal = normalize(vec2(
          roundedBox(p + vec2(0.5,0.0),size*0.5-0.6,radius) - d,
          roundedBox(p + vec2(0.0,0.5),size*0.5-0.6,radius) - d) + vec2(0.001));
        float light = dot(normal, normalize(vec2(-0.65,0.76)));
        float specular = pow(abs(light), 5.0);
        float shine = rim * (0.05 + specular * mix(0.24,0.10,dark));
        float shade = shoulder * max(-light,0.0) * mix(0.025,0.035,dark);
        float alpha = shine + shade;
        float tone = shine / max(alpha,0.001);
        gl_FragColor = vec4(vec3(tone), alpha * (1.0-smoothstep(-0.7,0.7,d)));
      }`);
    if (!vertex || !fragment) { if (vertex) gl.deleteShader(vertex); if (fragment) gl.deleteShader(fragment); return null; }
    const program = gl.createProgram();
    gl.attachShader(program, vertex); gl.attachShader(program, fragment); gl.linkProgram(program);
    gl.deleteShader(vertex); gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { gl.deleteProgram(program); return null; }
    gl.useProgram(program);
    const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);
    const attribute = gl.getAttribLocation(program, 'a');
    gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
    return { canvas, gl, size: gl.getUniformLocation(program, 'size'), radius: gl.getUniformLocation(program, 'radius'), exponent: gl.getUniformLocation(program, 'exponent'), dark: gl.getUniformLocation(program, 'dark') };
  }

  function paint(el, force = false) {
    if (!el.isConnected) { surfaces.delete(el); resize.unobserve(el); return; }
    if (contrast.matches || transparency.matches) { el.style.removeProperty('--glass-shader'); return; }
    if (unavailable) return;
    const style = getComputedStyle(el), width = el.clientWidth, height = el.clientHeight;
    if (!width || !height) return;
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && scheme.matches);
    const exponent = CSS.supports('corner-shape', 'superellipse(2)') ? 4 : 2;
    const key = `${width}/${height}/${style.borderRadius}/${exponent}/${dark}`;
    if (!force && sizes.get(el) === key) return;
    try {
      renderer ||= createRenderer();
      if (!renderer) { unavailable = true; return; }
      const { canvas, gl } = renderer;
      const scale = Math.min(devicePixelRatio || 1, 1.5, 1200 / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform2f(renderer.size, canvas.width, canvas.height);
      gl.uniform1f(renderer.radius, Math.min(parseFloat(style.borderRadius) || 14, height / 2) * scale);
      gl.uniform1f(renderer.exponent, exponent);
      gl.uniform1f(renderer.dark, dark ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      el.style.setProperty('--glass-shader', `url("${canvas.toDataURL('image/png')}")`);
      sizes.set(el, key);
    } catch { unavailable = true; }
  }

  const resize = new ResizeObserver((entries) => { for (const { target } of entries) paint(target); });
  function refresh(force = false) {
    document.querySelectorAll(selector).forEach((el) => {
      if (!surfaces.has(el)) { surfaces.add(el); el.classList.add('glass-surface'); resize.observe(el); }
    });
    for (const el of surfaces) paint(el, force);
  }
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; refresh(); });
  }).observe(document.body, { childList: true, subtree: true });
  new MutationObserver(() => refresh(true)).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  for (const preference of [contrast, transparency, scheme]) preference.addEventListener('change', () => refresh(true));
  refresh();
})();

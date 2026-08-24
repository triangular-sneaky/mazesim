/**
 * Video overlay mode. Streams a selected source into a full-viewport <video> element that
 * sits behind the (transparent) 3D canvas, so the maze can be composited over a live view
 * of a real room — or over an uploaded video clip. Owns device enumeration, the source
 * <select>, the file picker, and the stream/file lifecycle; calls `onToggle(on)` so the
 * caller can switch the scene into wireframe/transparent mode.
 *
 * The source <select> offers cameras plus a special "Video file…" entry (value `__file__`)
 * that prompts for a local file and loops it instead of a camera. Camera access requires a
 * secure context (https or localhost); the file source does not.
 *
 * An "adjust" checkbox hands the mouse to the video: while it's on, the maze's orbit
 * controls are locked (via onControlLock) and the wheel zooms / drag pans the video
 * (a CSS transform on the element); double-click resets the framing. While it's off,
 * the mouse drives the maze exactly as before.
 *
 * @param {HTMLVideoElement} videoEl  full-viewport background video element
 * @param {HTMLInputElement} toggleEl  checkbox enabling/disabling the overlay
 * @param {HTMLSelectElement} selectEl  source picker (cameras + "Video file…")
 * @param {(on: boolean) => void} onToggle  notified when the overlay turns on/off
 * @param {HTMLInputElement} [adjustEl]  checkbox: mouse controls the video instead of the maze
 * @param {(lock: boolean) => void} [onControlLock]  called to disable/enable maze controls
 */
const FILE_VALUE = '__file__';

export class VideoMode {
  constructor(videoEl, toggleEl, selectEl, onToggle, adjustEl, onControlLock) {
    this.video = videoEl;
    this.toggle = toggleEl;
    this.select = selectEl;
    this.onToggle = onToggle;
    this.adjust = adjustEl;
    this.onControlLock = onControlLock;
    this.stream = null;
    this.fileUrl = null;

    // Video framing transform (applied while "adjust" pans/zooms the background video).
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this._adjusting = false;
    this._dragging = false;

    // Hidden file input reused for every "Video file…" pick.
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = 'video/*';
    this.fileInput.style.display = 'none';
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = ''; // allow re-picking the same file later
      if (file) this._playFile(file);
    });
    document.body.appendChild(this.fileInput);

    this.toggle.addEventListener('change', () => {
      if (this.toggle.checked) this.enable();
      else this.disable();
    });
    this.select.addEventListener('change', () => {
      // Picking a file works even when the overlay is off — it turns itself on once a
      // file is chosen (see _playFile). Camera switching only matters while already on.
      if (this.select.value === FILE_VALUE) { this._pickFile(); return; }
      if (!this.toggle.checked) return;
      this.start(this.select.value || undefined).catch((e) => console.error(e));
    });

    // "Adjust video" — hand the mouse to the video (zoom/pan) and lock the maze controls.
    if (this.adjust) {
      this.adjust.addEventListener('change', () => this._setAdjust(this.adjust.checked));
      // Listen on the viewport (the transparent canvas over the video bubbles here). These
      // only act while adjusting; otherwise the maze's OrbitControls handle the same events.
      const vp = this.video.parentElement;
      vp.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
      vp.addEventListener('pointerdown', (e) => this._onDown(e));
      vp.addEventListener('dblclick', (e) => this._onDblClick(e));
      window.addEventListener('pointermove', (e) => this._onMove(e));
      window.addEventListener('pointerup', () => { this._dragging = false; });
    }
  }

  /** Turn video-adjust mode on/off: lock/unlock maze controls, set the drag cursor. */
  _setAdjust(on) {
    // Only meaningful while the overlay is showing; refuse to lock the maze over nothing.
    if (on && !document.body.classList.contains('video-mode')) {
      if (this.adjust) this.adjust.checked = false;
      return;
    }
    this._adjusting = on;
    this._dragging = false;
    this.onControlLock?.(on);
    const vp = this.video.parentElement;
    if (vp) vp.style.cursor = on ? 'move' : '';
  }

  _applyTransform() {
    // Generous pan bounds so the video can be pushed right out to (and past) the viewport
    // edges — up to roughly a full viewport of slack on top of the scaled image — while
    // still not being flung irretrievably far. Works when zoomed out (<1) too.
    const w = this.video.clientWidth, h = this.video.clientHeight;
    const maxX = (w * (this.zoom + 1)) / 2;
    const maxY = (h * (this.zoom + 1)) / 2;
    this.panX = Math.min(maxX, Math.max(-maxX, this.panX));
    this.panY = Math.min(maxY, Math.max(-maxY, this.panY));
    this.video.style.transform =
      `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }

  _resetTransform() {
    this.zoom = 1; this.panX = 0; this.panY = 0;
    this.video.style.transform = '';
  }

  _onWheel(e) {
    if (!this._adjusting) return;
    e.preventDefault();
    this.zoom = Math.min(8, Math.max(0.2, this.zoom * Math.exp(-e.deltaY * 0.0015)));
    this._applyTransform();
  }

  _onDown(e) {
    if (!this._adjusting) return;
    e.preventDefault();
    this._dragging = true;
    this._lastX = e.clientX;
    this._lastY = e.clientY;
  }

  _onMove(e) {
    if (!this._dragging) return;
    this.panX += e.clientX - this._lastX;
    this.panY += e.clientY - this._lastY;
    this._lastX = e.clientX;
    this._lastY = e.clientY;
    this._applyTransform();
  }

  _onDblClick(e) {
    if (!this._adjusting) return;
    e.preventDefault();
    this._resetTransform();
  }

  async enable() {
    // File source needs no camera permission — go straight to the picker.
    if (this.select.value === FILE_VALUE) {
      document.body.classList.add('video-mode');
      this.onToggle?.(true);
      this._pickFile();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('This browser has no camera access (needs https or localhost). '
        + 'Pick "Video file…" to overlay onto a clip instead.');
      this.toggle.checked = false;
      return;
    }
    try {
      await this.start(this.select.value || undefined); // prompts for permission
      await this._populateDevices();                    // labels available post-permission
      document.body.classList.add('video-mode');
      this.onToggle?.(true);
    } catch (e) {
      console.error('Camera error:', e);
      alert(`Could not access camera: ${e.message}`);
      this.toggle.checked = false;
    }
  }

  disable() {
    this._stopStream();
    this._clearFile();
    document.body.classList.remove('video-mode');
    this.onToggle?.(false);
    // Hand the mouse back to the maze and clear any zoom/pan framing.
    if (this.adjust) this.adjust.checked = false;
    this._setAdjust(false);
    this._resetTransform();
  }

  /** (Re)acquire a camera stream for the given device id (undefined = default camera). */
  async start(deviceId) {
    this._stopStream();
    this._clearFile(); // switching to a camera drops any file that was playing
    const video = deviceId ? { deviceId: { exact: deviceId } } : true;
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {}); // autoplay may still succeed muted
  }

  /** Open the file dialog (a chosen file is handled by the input's change listener). */
  _pickFile() {
    this.fileInput.click();
  }

  /** Play a chosen local video file, looped, as the background (drops any camera stream). */
  _playFile(file) {
    this._stopStream();
    this._clearFile();
    this.fileUrl = URL.createObjectURL(file);
    this.video.srcObject = null;
    this.video.src = this.fileUrl;
    this.video.loop = true;
    this.video.play().catch(() => {});
    // Make sure the overlay is actually visible, even if we got here without enable()
    // (e.g. a failed camera attempt unchecked the box, or the file was picked while off).
    this.select.value = FILE_VALUE;
    this.toggle.checked = true;
    document.body.classList.add('video-mode');
    this.onToggle?.(true);
  }

  _stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  _clearFile() {
    if (this.fileUrl) {
      URL.revokeObjectURL(this.fileUrl);
      this.fileUrl = null;
    }
    this.video.removeAttribute('src');
    this.video.loop = false;
    this.video.load();
  }

  async _populateDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    const active = this.stream?.getVideoTracks()[0]?.getSettings().deviceId;
    this.select.innerHTML = '';
    cams.forEach((cam, i) => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${i + 1}`;
      if (cam.deviceId === active) opt.selected = true;
      this.select.append(opt);
    });
    // Always keep the file source available at the end of the list.
    const fileOpt = document.createElement('option');
    fileOpt.value = FILE_VALUE;
    fileOpt.textContent = 'Video file…';
    this.select.append(fileOpt);
  }
}

/**
 * Video overlay mode. Streams a selected camera into a full-viewport <video> element that
 * sits behind the (transparent) 3D canvas, so the maze can be composited over a live view
 * of a real room. Owns device enumeration, the source <select>, and the stream lifecycle;
 * calls `onToggle(on)` so the caller can switch the scene into wireframe/transparent mode.
 *
 * Requires a secure context (https or localhost) for getUserMedia.
 *
 * @param {HTMLVideoElement} videoEl  full-viewport background video element
 * @param {HTMLInputElement} toggleEl  checkbox enabling/disabling the overlay
 * @param {HTMLSelectElement} selectEl  camera picker (populated after permission granted)
 * @param {(on: boolean) => void} onToggle  notified when the overlay turns on/off
 */
export class VideoMode {
  constructor(videoEl, toggleEl, selectEl, onToggle) {
    this.video = videoEl;
    this.toggle = toggleEl;
    this.select = selectEl;
    this.onToggle = onToggle;
    this.stream = null;

    this.toggle.addEventListener('change', () => {
      if (this.toggle.checked) this.enable();
      else this.disable();
    });
    // Switching camera only matters while the overlay is on.
    this.select.addEventListener('change', () => {
      if (this.toggle.checked) this.start(this.select.value).catch((e) => console.error(e));
    });
  }

  async enable() {
    if (!navigator.mediaDevices?.getUserMedia) {
      alert('This browser has no camera access (needs https or localhost).');
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
    document.body.classList.remove('video-mode');
    this.onToggle?.(false);
  }

  /** (Re)acquire a stream for the given device id (undefined = default camera). */
  async start(deviceId) {
    this._stopStream();
    const video = deviceId ? { deviceId: { exact: deviceId } } : true;
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {}); // autoplay may still succeed muted
  }

  _stopStream() {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
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
  }
}

/**
 * pinchZoom.js — Native pinch-to-zoom for the Cesium globe on touch devices.
 *
 * Cesium has its own touch handler but it can be unreliable on some browsers.
 * This adds a clean, independent two-finger pinch listener on the cesiumContainer
 * that zooms the camera in/out smoothly using the camera's zoomIn/zoomOut API.
 */

export function initPinchZoom(viewer) {
  const canvas = viewer.scene.canvas;
  if (!canvas) return;

  let lastPinchDist = null;

  function getTouchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function getTouchMidpoint(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      lastPinchDist = getTouchDist(e.touches);
      e.preventDefault();
    }
  }, { passive: false });

  canvas.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || lastPinchDist === null) return;
    e.preventDefault();

    const newDist = getTouchDist(e.touches);
    const delta = newDist - lastPinchDist;
    lastPinchDist = newDist;

    if (Math.abs(delta) < 1) return;

    // Scale zoom amount based on current camera altitude
    const cameraAlt = viewer.camera.positionCartographic?.height ?? 1000000;
    const zoomFactor = Math.max(cameraAlt * 0.012, 100);
    const amount = Math.abs(delta) * zoomFactor / 50;

    if (delta > 0) {
      // Pinch out = zoom in (fingers spreading apart)
      viewer.camera.zoomIn(amount);
    } else {
      // Pinch in = zoom out (fingers coming together)
      viewer.camera.zoomOut(amount);
    }
  }, { passive: false });

  canvas.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) {
      lastPinchDist = null;
    }
  }, { passive: true });

  canvas.addEventListener('touchcancel', () => {
    lastPinchDist = null;
  }, { passive: true });
}

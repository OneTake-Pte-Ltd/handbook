// Resizes a picture in the browser with a canvas, so uploads stay small.

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("This file doesn't look like a picture."));
    };
    img.src = url;
  });
}

// Center-crops to a square and scales to size x size. Returns a JPEG Blob.
export async function squareImage(file, size = 256) {
  const img = await loadImage(file);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - side) / 2;
  const sy = (img.naturalHeight - side) / 2;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size, size);
  context.imageSmoothingQuality = "high";
  context.drawImage(img, sx, sy, side, side, 0, 0, size, size);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The picture could not be prepared."))), "image/jpeg", 0.88);
  });
}

// Scales an image down so its longest side is at most maxSide pixels. Small
// images are returned unchanged (keeping PNG transparency and GIF animation).
export async function fitImage(file, maxSide = 2400, maxBytes = 9 * 1024 * 1024) {
  if (file.type === "image/gif" || file.type === "image/svg+xml") return file;
  const img = await loadImage(file);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  if (longest <= maxSide && file.size <= maxBytes) return file;
  const scale = Math.min(1, maxSide / longest);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The picture could not be prepared."))), "image/webp", 0.86);
  });
}

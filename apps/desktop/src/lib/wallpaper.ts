function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("hosty-desktop", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("wallpapers");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("Your browser could not open wallpaper storage."));
  });
}
export async function readWallpaper(userId: string): Promise<Blob | null> {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction("wallpapers").objectStore("wallpapers").get(userId);
      request.onsuccess = () => resolve(request.result instanceof Blob ? request.result : null);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}
export async function saveWallpaper(userId: string, image: File) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(image.type) || image.size > 12 * 1024 * 1024)
    throw new Error("Choose a JPEG, PNG or WebP image up to 12 MB.");
  const db = await database();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction("wallpapers", "readwrite");
      transaction.objectStore("wallpapers").put(image, userId);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(new Error("Your browser could not save this wallpaper."));
      transaction.onabort = () => reject(new Error("Wallpaper storage was interrupted."));
    });
  } finally { db.close(); }
}

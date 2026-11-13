/** Browser-only upload preparation; no paid call or persistent original copy. */
export async function prepareStudioPhoto(file: File): Promise<File> {
  if (file.size <= 3 * 1024 * 1024) return file;
  if (file.size > 15 * 1024 * 1024 || !["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Обери фото до 15 МБ або PDF до 3 МБ.");
  if (typeof createImageBitmap !== "function") throw new Error("Цей браузер не зміг зменшити фото. Обери зображення до 3 МБ.");
  const image = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    const ratio = Math.min(1, 2800 / Math.max(image.width, image.height)); const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.width * ratio)); canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext("2d"); if (!context) throw new Error("Не вдалося підготувати фото. Обери зображення до 3 МБ.");
    context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size > 3 * 1024 * 1024) throw new Error("Фото все ще завелике. Обери ближчий кадр однієї сторінки.");
    return new File([blob], "page.jpg", { type: "image/jpeg" });
  } finally { image.close(); }
}

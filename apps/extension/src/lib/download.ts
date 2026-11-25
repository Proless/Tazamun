/** Save text as a file from an extension page, without the `downloads` permission. */
export function downloadText(document: Document, fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.style.display = 'none';
  document.body.append(link);
  link.click();
  link.remove();
  // Firefox starts the download asynchronously; revoking at once can cancel it.
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
}

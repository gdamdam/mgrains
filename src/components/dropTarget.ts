// Pure drag-and-drop validation for audio file drops. The component owns the
// DOM events and the actual decode; this module only decides whether a drop is
// acceptable and tracks the nested enter/leave depth so the overlay can't stick.
//
// Philosophy on file typing: browsers report audio MIME types inconsistently
// (empty, application/octet-stream, video/* for audio-only containers, …), so
// we never reject on a missing/odd MIME. We reject only when we are confident a
// file is NOT audio; everything else passes through to the authoritative check,
// AudioEngine.decodeFile(), which either decodes or fails with a real error.

export type DropFileInfo = { name: string; type: string; isDirectory?: boolean }

export type DropValidation = { ok: true; index: number } | { ok: false; error: string }

// Container/extension families that can legitimately carry audio.
const AUDIO_EXTENSIONS = new Set([
  'wav', 'wave', 'mp3', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'mp4',
  'aac', 'aif', 'aiff', 'aifc', 'webm', 'weba', 'caf',
])

// Extensions we are confident are not decodable audio.
const NON_AUDIO_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico',
  'pdf', 'txt', 'json', 'csv', 'md', 'xml', 'html',
  'zip', 'gz', 'tar', 'rar', '7z', 'dmg', 'exe',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'mov', 'mkv', 'avi', 'wmv',
])

function extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

// True unless we are confident the file is not audio. Lenient by design.
export function looksLikeAudio(info: DropFileInfo): boolean {
  const type = info.type.toLowerCase()
  const ext = extension(info.name)
  if (type.startsWith('audio/') || type === 'application/ogg') return true
  if (type.startsWith('image/') || type.startsWith('text/')) return false
  // Concrete non-audio application/* (pdf, zip, json…): reject unless the
  // extension says audio. octet-stream is generic binary — defer to extension.
  if (type.startsWith('application/') && type !== 'application/octet-stream') {
    return AUDIO_EXTENSIONS.has(ext)
  }
  // video/* is common for audio-only webm/ogg/mp4; trust a known audio extension.
  if (type.startsWith('video/')) return AUDIO_EXTENSIONS.has(ext)
  if (NON_AUDIO_EXTENSIONS.has(ext)) return false
  return true
}

// Accept exactly one audio file; reject empty, multiple, directories, non-audio.
export function validateDrop(files: readonly DropFileInfo[]): DropValidation {
  if (files.length === 0) return { ok: false, error: 'No file found — drop an audio file.' }
  if (files.length > 1) return { ok: false, error: 'Drop just one audio file at a time.' }
  const [file] = files
  if (file.isDirectory) return { ok: false, error: "Folders can't be loaded — drop a single audio file." }
  if (!looksLikeAudio(file)) return { ok: false, error: `“${file.name}” doesn't look like an audio file.` }
  return { ok: true, index: 0 }
}

// The transfer carries files (as opposed to dragged text/links) — only then
// should the app preventDefault and show the drop overlay.
export function transferHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false
  return Array.from(types).includes('Files')
}

// Nested enter/leave depth counter: dragenter/leave fire per child element, so a
// naive boolean flickers and can leave the overlay stuck. Counting keeps it stable.
export function dragEnter(depth: number): number {
  return depth + 1
}

export function dragLeave(depth: number): number {
  return Math.max(0, depth - 1)
}

export function isOverlayVisible(depth: number): boolean {
  return depth > 0
}

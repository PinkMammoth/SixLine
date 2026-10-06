// Platform adapter: Electron preload bridge when available, plain-browser fallback otherwise.
export interface OpenedFile {
  path: string | null;
  name: string;
  bytes: Uint8Array;
}
export interface FileFilter {
  name: string;
  extensions: string[];
}

interface Bridge {
  openFile(filters: FileFilter[]): Promise<OpenedFile | null>;
  readFile(path: string): Promise<OpenedFile>;
  saveFile(o: { path?: string | null; data: Uint8Array; defaultName: string; filters: FileFilter[] }): Promise<string | null>;
  initialFile(): Promise<string | null>;
  onOpenPath(cb: (path: string) => void): void;
}

const bridge = (window as any).host as Bridge | undefined;

export const isDesktop = !!bridge;

export async function openFile(filters: FileFilter[]): Promise<OpenedFile | null> {
  if (bridge) return bridge.openFile(filters);
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = filters.flatMap((f) => f.extensions.map((e) => '.' + e)).join(',');
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { path: null, name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) } : null);
    };
    input.click();
  });
}

export async function saveFile(path: string | null, data: Uint8Array, defaultName: string, filters: FileFilter[]): Promise<string | null> {
  if (bridge) return bridge.saveFile({ path, data, defaultName, filters });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data as BlobPart]));
  a.download = defaultName;
  a.click();
  URL.revokeObjectURL(a.href);
  return defaultName;
}

export async function initialFile(): Promise<OpenedFile | null> {
  const p = bridge && (await bridge.initialFile());
  return p ? bridge!.readFile(p) : null;
}

/** Files opened from the OS while the app is running (e.g. double-clicking a .tabproj). */
export function onOpenFile(cb: (f: OpenedFile) => void) {
  bridge?.onOpenPath(async (p) => cb(await bridge.readFile(p)));
}

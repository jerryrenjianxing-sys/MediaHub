export type Theme = 'system' | 'light' | 'dark';
export type Page = 'connect' | 'tools' | 'projects' | 'assets' | 'activity' | 'settings';
export type Orientation = 'landscape' | 'portrait';
export interface Tool {
  id: string; name: string; description?: string; kind: 'external' | 'component';
  status: string; installedVersion?: string; availableVersion?: string;
  installPath?: string; dataPaths?: string[]; management: 'original' | 'platform';
  downloadBytes?: number; entryUrl?: string; error?: string | { message?: string };
  canInstall?: boolean; canUpdate?: boolean;
}
export interface Project { id: string; name: string; path: string; orientation?: Orientation; createdAt?: string; }
export interface FileRecord {
  id: string; name: string; path: string; sourcePath?: string; projectId?: string;
  toolId?: string; taskId?: string; createdAt?: string; mimeType?: string;
}
export interface Task {
  id: string; toolId?: string; capabilityId?: string; projectId?: string;
  state: string; progress?: { phase?: string; percent?: number; message?: string };
  result?: unknown; error?: string | { message?: string }; createdAt?: string; updatedAt?: string;
  type?: string; label?: string;
}
export interface Snapshot {
  version: string; workspace?: string | { path?: string }; tools: Tool[]; projects: Project[];
  assets: FileRecord[]; artifacts: FileRecord[]; tasks: Task[]; operations?: Task[];
  connection?: Record<string, unknown>; settings?: Record<string, unknown>;
  updates?: Record<string, unknown>; platformUpdate?: Record<string, unknown>; platformUpdates?: Record<string, unknown>;
}
export interface Bounds { x: number; y: number; width: number; height: number; }
export interface Bridge {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onChanged(callback: (snapshot: unknown) => void): () => void;
  selectWorkspace(): Promise<unknown>; importAssets(projectId?: string): Promise<unknown>;
  openArtifact(id: string): Promise<void>; showInFolder(kind: 'project' | 'asset' | 'artifact', id: string): Promise<void>;
  copyConnection(): Promise<void>; downloadSkill(): Promise<void>;
  openStudio(projectId: string, bounds: Bounds): Promise<void>; setStudioBounds(bounds: Bounds): void;
  closeStudio(): Promise<void>;
}
declare global { interface Window { mediaHub?: Bridge } }

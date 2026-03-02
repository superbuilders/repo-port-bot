export interface PackageJson {
  workspaces?: { packages?: string[] } | string[];
}

export interface PackageInfo {
  name: string;
  dir: string;
  path: string;
}

export interface CreateOptions {
  /** Package name (will prompt if not provided) */
  name?: string;
  /** Explicit workspace directory (e.g. "packages/") */
  packagesDir?: string;
  /** Skip intro/outro messages */
  silent?: boolean;
}

export interface RemoveOptions {
  /** Package name to remove (will prompt if not provided) */
  name?: string;
  /** Skip confirmation prompt */
  force?: boolean;
  /** Skip intro/outro messages */
  silent?: boolean;
}

export interface CleanOptions {
  /** Also clean node_modules */
  all?: boolean;
  /** Skip confirmation prompts */
  skipConfirm?: boolean;
  /** Skip intro/outro messages */
  silent?: boolean;
}

export interface ListPackageInfo {
  path: string;
  name: string;
  version: string;
  private: string;
}

export interface ListOptions {
  /** Skip console output and just return data */
  silent?: boolean;
}

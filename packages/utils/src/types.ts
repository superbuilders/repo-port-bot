export interface SourceFileOptions {
  directory?: string;
  exclude?: (filePath: string) => boolean;
}

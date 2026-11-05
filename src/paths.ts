import { fileURLToPath } from 'node:url';
// Both src/ and dist/ live directly below the project root.
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const nativeExecutable = fileURLToPath(new URL('../build/NotifyPaul.exe', import.meta.url));

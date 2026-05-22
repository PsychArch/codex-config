import { constants } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";

export async function readTextIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function atomicWriteFile(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const mode = await existingMode(path);
  const tempPath = join(directory, `.${Date.now()}-${process.pid}.tmp`);
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode });
    await chmod(tempPath, mode);
    await rename(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function existingMode(path: string): Promise<number> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return 0o600;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

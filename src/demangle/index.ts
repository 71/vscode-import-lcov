import * as vscode from "vscode";
import wasmPath from "./demangle.wasm";

/**
 * Loads the function `demangle()` which demangles a mangled C++ symbol.
 */
export async function loadDemangle(extensionContext: vscode.ExtensionContext) {
  const wasmUri = vscode.Uri.joinPath(
    extensionContext.extensionUri,
    "out",
    wasmPath,
  );
  const wasmBytes = await vscode.workspace.fs.readFile(wasmUri);
  const { instance } = await WebAssembly.instantiate(wasmBytes);
  const exports = instance.exports as {
    mangled_buffer(): number;
    mangled_buffer_len(): number;
    demangled_buffer(): number;
    demangle(len: number): number;
    memory: WebAssembly.Memory;
  };

  return function demangle(mangled: string): string {
    if (mangled.length === 0) {
      throw new Error("demangle() must be called with a non-empty string");
    }

    const mangledBytes = new TextEncoder().encode(mangled);
    const mangledBytesInMemory = new Uint8Array(
      exports.memory.buffer,
      exports.mangled_buffer(),
      exports.mangled_buffer_len(),
    );
    const mangledLen = Math.min(
      mangledBytes.length,
      mangledBytesInMemory.length,
    );

    for (let i = 0; i < mangledLen; i++) {
      mangledBytesInMemory[i] = mangledBytes[i];
    }

    const demangledLen = exports.demangle(mangledLen);

    if (demangledLen === 0) {
      return mangled;
    }

    const demangledBytes = new Uint8Array(
      exports.memory.buffer,
      exports.demangled_buffer(),
      demangledLen,
    );
    return new TextDecoder().decode(demangledBytes);
  };
}

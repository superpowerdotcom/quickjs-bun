import assert from "node:assert/strict";
import { ptr, read } from "bun:ffi";
import { isTaggedIntAtom, newCell, readCString, untagAtomInt } from "./internal";
import { JSValue } from "./value";
import type { JSContext } from "./context";

export class JSAtom {
  #disposed = false;

  constructor(
    readonly vm: JSContext,
    readonly value: number,
    readonly owned: boolean,
  ) {}

  dup(): JSAtom {
    assert(!this.#disposed, "QuickJS atom is disposed");
    if (isTaggedIntAtom(this.value)) return new JSAtom(this.vm, this.value, false);
    return new JSAtom(this.vm, this.vm.native.JS_DupAtom(this.vm.ctx, this.value), true);
  }

  toValue(): JSValue {
    assert(!this.#disposed, "QuickJS atom is disposed");
    if (isTaggedIntAtom(this.value)) return this.vm.newString(String(untagAtomInt(this.value)));
    const out = newCell();
    this.vm.native.qjs_bun_atom_to_value(this.vm.ctx, this.value, out);
    return this.vm.resultValue(out);
  }

  toStringValue(): JSValue {
    assert(!this.#disposed, "QuickJS atom is disposed");
    if (isTaggedIntAtom(this.value)) return this.vm.newString(String(untagAtomInt(this.value)));
    const out = newCell();
    this.vm.native.qjs_bun_atom_to_string(this.vm.ctx, this.value, out);
    return this.vm.resultValue(out);
  }

  toString(): string {
    assert(!this.#disposed, "QuickJS atom is disposed");
    if (isTaggedIntAtom(this.value)) return String(untagAtomInt(this.value));
    const size = new Uint8Array(8);
    const text = this.vm.native.JS_AtomToCStringLen(this.vm.ctx, ptr(size), this.value);
    assert(text !== null, "QuickJS atom string is null");
    return readCString(this.vm, text, Number(read.u64(ptr(size))));
  }

  dispose(): void {
    if (!this.owned || this.#disposed) return;
    if (isTaggedIntAtom(this.value)) {
      this.#disposed = true;
      return;
    }
    this.vm.native.JS_FreeAtom(this.vm.ctx, this.value);
    this.#disposed = true;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

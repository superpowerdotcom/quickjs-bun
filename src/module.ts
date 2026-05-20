import assert from "node:assert/strict";
import { ptr, type Pointer } from "bun:ffi";
import { QuickJSAtom } from "./ffi";
import { JSAtom } from "./atom";
import { encoder, newCell } from "./internal";
import type { JSContext } from "./context";
import type { HostValue } from "./types";
import { JSValue } from "./value";

export class JSModule {
  constructor(
    readonly vm: JSContext,
    readonly ptr: Pointer,
  ) {}

  addExport(name: string): void {
    if (this.vm.native.JS_AddModuleExport(this.vm.ctx, this.ptr, encoder.encode(`${name}\0`)) < 0) {
      throw this.vm.getException();
    }
  }

  addExports(names: readonly string[]): void {
    for (const name of names) this.addExport(name);
  }

  setExport(name: string, value: JSValue): void {
    this.vm.assertSameVM(value);
    const ownedValue = value.dupCell();
    if (
      this.vm.native.qjs_bun_set_module_export(
        this.vm.ctx,
        this.ptr,
        encoder.encode(`${name}\0`),
        ptr(ownedValue),
      ) < 0
    ) {
      throw this.vm.getException();
    }
  }

  setExports(values: Record<string, HostValue>): void {
    for (const [name, value] of Object.entries(values)) {
      using handle = this.vm.newValue(value);
      this.setExport(name, handle);
    }
  }

  getNameAtom(): JSAtom {
    const atom = this.vm.native.JS_GetModuleName(this.vm.ctx, this.ptr);
    assert(atom !== QuickJSAtom.NULL, "JS_GetModuleName returned null");
    return new JSAtom(this.vm, atom, true);
  }

  getImportMeta(): JSValue {
    const out = newCell();
    this.vm.native.qjs_bun_get_import_meta(this.vm.ctx, this.ptr, out);
    return this.vm.resultValue(out);
  }

  getNamespace(): JSValue {
    const out = newCell();
    this.vm.native.qjs_bun_get_module_namespace(this.vm.ctx, this.ptr, out);
    return this.vm.resultValue(out);
  }

  getPrivateValue(): JSValue {
    const out = newCell();
    this.vm.native.qjs_bun_get_module_private_value(this.vm.ctx, this.ptr, out);
    return this.vm.resultValue(out);
  }

  setPrivateValue(value: JSValue): void {
    this.vm.assertSameVM(value);
    const ownedValue = value.dupCell();
    if (
      this.vm.native.qjs_bun_set_module_private_value(this.vm.ctx, this.ptr, ptr(ownedValue)) < 0
    ) {
      throw this.vm.getException();
    }
  }
}

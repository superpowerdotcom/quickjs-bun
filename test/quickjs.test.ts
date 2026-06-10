import { afterAll, afterEach, expect, test } from "bun:test";
import { CString, ptr, read, toArrayBuffer } from "bun:ffi";
import {
  JSValue,
  QuickJS,
  JSRuntime,
  JSException,
  QUICKJS_DEFAULT_STACK_SIZE,
  QUICKJS_VALUE_CELL_BYTES,
  QUICKJS_VERSION_TEXT,
  QuickJSAtom,
  QuickJSCFunction,
  QuickJSEvalFlags,
  QuickJSParseJsonFlags,
  QuickJSPromiseState,
  QuickJSPropertyFlags,
  QuickJSReadObjectFlags,
  QuickJSStripFlags,
  QuickJSTypedArray,
  QuickJSValueTag,
  QuickJSWriteObjectFlags,
  type Deferred,
  type JSContext,
  type JSContextOptions,
  type JSRuntimeOptions,
} from "../index";

const runtimes: JSRuntime[] = [];
const library = new QuickJS();
const quickJSNative = library.native;
const encoder = new TextEncoder();
const valueCell = () => new Uint8Array(QUICKJS_VALUE_CELL_BYTES);
const readU64 = (cell: Uint8Array) => read.u64(ptr(cell));
interface TestVMOptions extends Omit<JSRuntimeOptions, "library">, JSContextOptions {
  library?: QuickJS;
}

function vm(options: TestVMOptions = {}): JSContext {
  const { intrinsics, library: optionLibrary, timeoutMs, ...runtimeOptions } = options;
  const runtime = new JSRuntime({ ...runtimeOptions, library: optionLibrary ?? library });
  const context = runtime.createContext({ intrinsics, timeoutMs });
  runtimes.push(runtime);
  return context;
}

afterAll(() => {
  library.close();
});

afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

test("reports the vendored QuickJS version", () => {
  expect(QUICKJS_VERSION_TEXT).toBe("2025-09-13");
});

test("exposes raw QuickJS bindings and constants to Bun", () => {
  const source = encoder.encode("export const value = 1;\0");
  expect(quickJSNative.JS_DetectModule(source, source.length - 1)).toBe(1);
  expect(typeof quickJSNative.qjs_bun_eval).toBe("function");
  expect(typeof quickJSNative.qjs_bun_write_object).toBe("function");
  expect(typeof quickJSNative.qjs_bun_new_c_function).toBe("function");
  expect(typeof quickJSNative.qjs_bun_value_is_nan).toBe("function");
  expect(QuickJSCFunction.GENERIC).toBe(0);
  expect(QuickJSAtom.NULL).toBe(0);
  expect(QUICKJS_DEFAULT_STACK_SIZE).toBe(1024 * 1024);
  expect(QUICKJS_VALUE_CELL_BYTES).toBe(16);
  expect(QuickJSValueTag.FIRST).toBe(-9);
  expect(QuickJSPropertyFlags.HAS_SHIFT).toBe(8);
  expect(QuickJSEvalFlags.COMPILE_ONLY).toBe(1 << 5);
  expect(QuickJSWriteObjectFlags.BYTECODE).toBe(1 << 0);
});

test("disposes with raw runtime opaque values", () => {
  const instance = vm();
  const opaque = new Uint8Array(8);
  quickJSNative.JS_SetRuntimeOpaque(instance.ptr, ptr(opaque));
  instance.dispose();
});

test("does not overwrite raw context opaque values for host functions", () => {
  const instance = vm();
  const opaque = new Uint8Array(8);
  quickJSNative.JS_SetContextOpaque(instance.ctx, ptr(opaque));
  using fn = instance.newFunction(() => 42);
  instance.setGlobal("host", fn);
  using result = instance.evalCode("host()");
  expect(result.toNumber()).toBe(42);
  expect(quickJSNative.JS_GetContextOpaque(instance.ctx)).toBe(ptr(opaque));
});

test("creates independent contexts on one runtime", () => {
  using runtime = new JSRuntime({ library });
  using left = runtime.createContext();
  using right = runtime.createContext();
  const opaque = new Uint8Array(8);

  left.evalCode("globalThis.value = 1").dispose();
  right.evalCode("globalThis.value = 2").dispose();
  runtime.setOpaque(ptr(opaque));
  left.setOpaque(ptr(opaque));

  using leftValue = left.evalCode("value");
  using rightValue = right.evalCode("value");
  expect(leftValue.toNumber()).toBe(1);
  expect(rightValue.toNumber()).toBe(2);
  expect(left.ptr).toBe(left.ctx);
  expect(left.runtime.ptr).toBe(runtime.ptr);
  expect(runtime.getOpaque()).toBe(ptr(opaque));
  expect(left.getOpaque()).toBe(ptr(opaque));
  expect(runtime.memoryUsage().memoryUsedSize > 0n).toBe(true);
});

test("registers simple native classes and class prototypes", () => {
  using runtime = new JSRuntime({ library });
  const classId = runtime.registerClass("Box");
  expect(runtime.isRegisteredClass(classId)).toBe(true);

  using context = runtime.createContext();
  using prototype = context.newValue({ kind: "box" });
  context.setClassProto(classId, prototype);

  using object = context.newObjectClass(classId);
  expect(object.classId).toBe(classId);
  expect(object.isLiveObject()).toBe(true);
  using inherited = object.getProp("kind");
  expect(inherited.toString()).toBe("box");

  const opaque = new Uint8Array(8);
  object.setOpaque(ptr(opaque));
  expect(object.getOpaque(classId)).toBe(ptr(opaque));
  expect(object.getOpaque2(classId)).toBe(ptr(opaque));
  expect(object.getAnyOpaque()).toEqual({ classId, pointer: ptr(opaque) });

  using classProto = context.getClassProto(classId);
  expect(classProto.strictEquals(prototype)).toBe(true);
  using objectProto = context.newObjectProto(prototype);
  using protoKind = objectProto.getProp("kind");
  expect(protoKind.toString()).toBe("box");
  using objectProtoClass = context.newObjectProtoClass(prototype, classId);
  expect(objectProtoClass.classId).toBe(classId);
});

test("loads host source modules through a runtime module loader", () => {
  using runtime = new JSRuntime({ library });
  const requested: Array<{ attributes: unknown; name: string }> = [];
  runtime.setModuleLoader((name, context, attributes) => {
    requested.push({ attributes: context.dump(attributes), name });
    if (name === "/app/dep.js") return "export const answer = 42;";
    if (name === "/app/typed.js") return "export default import.meta.url;";
  });

  using context = runtime.createContext();
  context
    .evalCode('import { answer } from "./dep.js"; globalThis.answer = answer;', {
      filename: "/app/main.js",
      flags: QuickJSEvalFlags.TYPE_MODULE,
    })
    .dispose();
  using answer = context.getGlobal("answer");
  expect(answer.toNumber()).toBe(42);
  context
    .evalCode('import url from "./typed.js" with { type: "text" }; globalThis.typedUrl = url;', {
      filename: "/app/typed-main.js",
      flags: QuickJSEvalFlags.TYPE_MODULE,
    })
    .dispose();
  using typedUrl = context.getGlobal("typedUrl");
  expect(typedUrl.toString()).toBe("file:///app/typed.js");
  expect(requested).toEqual([
    { attributes: undefined, name: "/app/dep.js" },
    { attributes: { type: "text" }, name: "/app/typed.js" },
  ]);

  runtime.setModuleLoader(null);
  expect(() =>
    context.evalCode('import "/app/missing.js";', {
      filename: "/app/other.js",
      flags: QuickJSEvalFlags.TYPE_MODULE,
    }),
  ).toThrow("could not load module");
});

test("executes compiled global and module code", () => {
  using runtime = new JSRuntime({ library });
  runtime.setModuleLoader((name) => {
    if (name === "/app/dep.js") return "export const answer = 41;";
  });

  using context = runtime.createContext();
  using globalCode = context.compileCode("globalThis.globalAnswer = 40 + 2");
  context.evalFunction(globalCode).dispose();
  using globalAnswer = context.getGlobal("globalAnswer");
  expect(globalAnswer.toNumber()).toBe(42);

  using moduleCode = context.compileCode(
    'import { answer } from "./dep.js"; globalThis.moduleAnswer = answer + 1;',
    {
      filename: "/app/main.js",
      flags: QuickJSEvalFlags.TYPE_MODULE,
    },
  );
  context.evalFunction(moduleCode).dispose();
  using moduleAnswer = context.getGlobal("moduleAnswer");
  expect(moduleAnswer.toNumber()).toBe(42);
});

test("defines host C modules with explicit exports", () => {
  using runtime = new JSRuntime({ library });
  using context = runtime.createContext();
  const initialized: string[] = [];
  const module = context.newCModule("host:math/native", (mod) => {
    initialized.push(mod.getNameAtom().toString());
    using privateValue = mod.getPrivateValue();
    mod.setExports({
      answer: 42,
      extra: { ok: true },
      label: privateValue,
    });
  });
  module.addExports(["answer", "label", "extra"]);
  using label = context.newString("native");
  module.setPrivateValue(label);
  runtime.setModuleLoader((name, loaderContext) => {
    expect(loaderContext).toBe(context);
    if (name === "host:math") return module;
  });

  context
    .evalCode(
      'import { answer, label, extra } from "host:math"; globalThis.hostModule = { answer, label, extraOk: extra.ok };',
      { filename: "/app/main.js", flags: QuickJSEvalFlags.TYPE_MODULE },
    )
    .dispose();
  using result = context.getGlobal("hostModule");
  expect(context.dump(result)).toEqual({ answer: 42, label: "native", extraOk: true });
  expect(initialized).toEqual(["host:math/native"]);

  using namespace = module.getNamespace();
  using namespaceAnswer = namespace.getProp("answer");
  expect(namespaceAnswer.toNumber()).toBe(42);
  using meta = module.getImportMeta();
  expect(meta.type).toBe("object");
});

test("tracks host promise rejections per runtime", () => {
  using runtime = new JSRuntime({ library });
  using context = runtime.createContext();
  const events: Array<{ handled: boolean; message: string }> = [];
  runtime.setPromiseRejectionTracker(({ isHandled, reason }) => {
    events.push({ handled: isHandled, message: reason.toError().message });
  });

  context.evalCode("globalThis.rejected = Promise.reject(new Error('boom'))").dispose();
  expect(events).toEqual([{ handled: false, message: "boom" }]);

  context.evalCode("rejected.catch(() => {})").dispose();
  runtime.executePendingJobs();
  expect(events).toEqual([
    { handled: false, message: "boom" },
    { handled: true, message: "boom" },
  ]);

  runtime.setPromiseRejectionTracker(null);
});

test("enqueues host jobs into the QuickJS job queue", () => {
  using runtime = new JSRuntime({ library });
  using context = runtime.createContext();
  const seen: number[] = [];
  using value = context.newNumber(41);

  context.enqueueJob((arg) => {
    seen.push(arg.toNumber());
    using next = context.newNumber(arg.toNumber() + 1);
    context.setGlobal("jobValue", next);
  }, value);

  expect(seen).toEqual([]);
  expect(runtime.hasPendingJob()).toBe(true);
  expect(runtime.executePendingJob()).toBe(true);
  expect(seen).toEqual([41]);
  using jobValue = context.getGlobal("jobValue");
  expect(jobValue.toNumber()).toBe(42);
  expect(runtime.hasPendingJob()).toBe(false);

  context.enqueueJob(() => {
    throw new Error("job boom");
  });
  try {
    runtime.executePendingJob();
    throw new Error("expected job to throw");
  } catch (error) {
    expect(error).toMatchObject({ message: "job boom" });
    if (error instanceof JSException) error.dispose();
  }
});

test("creates raw contexts and adds selected intrinsics", () => {
  using runtime = new JSRuntime({ library });
  using context = runtime.createContext({ intrinsics: ["eval"] });

  using before = context.evalCode("typeof JSON + ':' + typeof Promise + ':' + typeof Date");
  expect(before.toString()).toBe("undefined:undefined:undefined");

  context.addIntrinsics(["json", "promise"]);
  using after = context.evalCode("typeof JSON + ':' + typeof Promise + ':' + typeof Date");
  expect(after.toString()).toBe("object:function:undefined");
});

test("exposes runtime limits and memory controls", () => {
  using runtime = new JSRuntime({ library, memoryBytes: 1024 * 1024, stackBytes: 64 * 1024 });
  runtime.setGCThreshold(0);
  runtime.setCanBlock(false);
  runtime.setStripInfo(QuickJSStripFlags.SOURCE);
  runtime.updateStackTop();
  expect(runtime.getStripInfo()).toBe(QuickJSStripFlags.SOURCE);

  using context = runtime.createContext();
  runtime.setRuntimeInfo("quickjs-bun test runtime");
  runtime.setGCThreshold(0);
  runtime.setCanBlock(false);
  runtime.setMaxStackSize(0);
  runtime.setMaxStackSize(64 * 1024);
  runtime.setStripInfo(QuickJSStripFlags.DEBUG);
  expect(runtime.getStripInfo()).toBe(QuickJSStripFlags.DEBUG);
  expect(() => context.evalCode("{ function f(){ return f() + 1 } f() }")).toThrow(
    "stack overflow",
  );
  expect(() =>
    context.evalCode(
      "const items = []; while (true) items.push(new Array(1000).fill('x').join(''))",
    ),
  ).toThrow();
  runtime.runGC();
  expect(runtime.memoryUsedBytes() > 0n).toBe(true);
  expect(runtime.dumpMemoryUsage()).toContain("QuickJS memory usage");
  expect(runtime.dumpMemoryUsage()).toContain("JSObject classes");
});

test("exposes raw JSValue bridge helpers", () => {
  const instance = vm();
  using text = instance.newString("answer");
  const atom = quickJSNative.qjs_bun_value_to_atom(instance.ctx, text.ptr);
  expect(atom).toBeGreaterThan(0);
  quickJSNative.JS_FreeAtom(instance.ctx, atom);

  const sizeCell = new Uint8Array(8);
  using value = instance.evalCode("({ answer: 42 })");
  expect(quickJSNative.qjs_bun_get_class_id(value.ptr)).toBeGreaterThan(0);
  const bytes = quickJSNative.qjs_bun_write_object(
    instance.ctx,
    sizeCell,
    value.ptr,
    QuickJSWriteObjectFlags.REFERENCE,
  );
  if (bytes === null) throw new Error("JS_WriteObject returned null");

  try {
    const size = Number(readU64(sizeCell));
    const copy = new Uint8Array(toArrayBuffer(bytes, 0, size));
    const out = valueCell();
    quickJSNative.qjs_bun_read_object(
      instance.ctx,
      copy,
      copy.length,
      QuickJSReadObjectFlags.REFERENCE,
      out,
    );
    using decoded = new JSValue(instance, out, true);
    expect(instance.dump(decoded)).toEqual({ answer: 42 });
  } finally {
    quickJSNative.js_free(instance.ctx, bytes);
  }

  const out = valueCell();
  quickJSNative.qjs_bun_new_int32(instance.ctx, 42, out);
  using number = new JSValue(instance, out, true);
  expect(number.toNumber()).toBe(42);
  expect(quickJSNative.qjs_bun_is_number(number.ptr)).toBe(1);
  expect(quickJSNative.qjs_bun_value_get_norm_tag(number.ptr)).toBe(QuickJSValueTag.INT);

  const floatOut = valueCell();
  quickJSNative.qjs_bun_new_float64(instance.ctx, 1.5, floatOut);
  using float = new JSValue(instance, floatOut, true);
  expect(float.toNumber()).toBe(1.5);

  using nan = instance.evalCode("NaN");
  expect(quickJSNative.qjs_bun_value_is_nan(nan.ptr)).toBe(1);
  expect(Number.isNaN(quickJSNative.qjs_bun_value_get_float64(nan.ptr))).toBe(true);

  const catchOut = valueCell();
  quickJSNative.qjs_bun_new_catch_offset(instance.ctx, 7, catchOut);
  using catchOffset = new JSValue(instance, catchOut, true);
  expect(quickJSNative.qjs_bun_value_get_norm_tag(catchOffset.ptr)).toBe(
    QuickJSValueTag.CATCH_OFFSET,
  );

  const cStringOut = valueCell();
  quickJSNative.qjs_bun_new_string(instance.ctx, encoder.encode("cstring\0"), cStringOut);
  using cString = new JSValue(instance, cStringOut, true);
  expect(cString.toString()).toBe("cstring");

  const ownedStringCell = valueCell();
  quickJSNative.qjs_bun_new_string_len(instance.ctx, encoder.encode("owned"), 5n, ownedStringCell);
  const ownedString = new JSValue(instance, ownedStringCell, true);
  expect(ownedString.toString()).toBe("owned");
  ownedString.dispose();
  ownedString.dispose();

  const bigintOut = valueCell();
  quickJSNative.qjs_bun_new_bigint64(instance.ctx, 123n, bigintOut);
  using bigint = new JSValue(instance, bigintOut, true);
  expect(bigint.toBigInt()).toBe(123n);

  const nameAtom = quickJSNative.JS_NewAtom(instance.ctx, encoder.encode("alpha\0"));
  const atomStringOut = valueCell();
  quickJSNative.qjs_bun_atom_to_string(instance.ctx, nameAtom, atomStringOut);
  using atomString = new JSValue(instance, atomStringOut, true);
  expect(atomString.toString()).toBe("alpha");
  const atomLength = new Uint8Array(8);
  const atomText = quickJSNative.JS_AtomToCStringLen(instance.ctx, ptr(atomLength), nameAtom);
  if (atomText === null) throw new Error("JS_AtomToCString returned null");
  try {
    expect(readU64(atomLength)).toBe(5n);
    expect(String(new CString(atomText, 0, 5))).toBe("alpha");
  } finally {
    quickJSNative.JS_FreeCString(instance.ctx, atomText);
  }
  quickJSNative.JS_FreeAtom(instance.ctx, nameAtom);

  const json = encoder.encode('{"answer":42}\0');
  const plainParsedOut = valueCell();
  quickJSNative.qjs_bun_parse_json(
    instance.ctx,
    plainParsedOut,
    json,
    json.length - 1,
    encoder.encode("<json>\0"),
  );
  using plainParsed = new JSValue(instance, plainParsedOut, true);
  expect(instance.dump(plainParsed)).toEqual({ answer: 42 });

  const parsedOut = valueCell();
  quickJSNative.qjs_bun_parse_json2(
    instance.ctx,
    parsedOut,
    json,
    json.length - 1,
    encoder.encode("<json>\0"),
    QuickJSParseJsonFlags.EXT,
  );
  using parsed = new JSValue(instance, parsedOut, true);
  expect(instance.dump(parsed)).toEqual({ answer: 42 });

  const textLengthCell = new Uint8Array(8);
  const objectText = quickJSNative.qjs_bun_to_cstring_len(instance.ctx, textLengthCell, parsed.ptr);
  if (objectText === null) throw new Error("JS_ToCStringLen returned null");
  try {
    expect(readU64(textLengthCell)).toBe(15n);
    expect(String(new CString(objectText, 0, 15))).toBe("[object Object]");
  } finally {
    quickJSNative.JS_FreeCString(instance.ctx, objectText);
  }

  const bufferBytes = new Uint8Array([1, 2, 3]);
  const bufferOut = valueCell();
  quickJSNative.qjs_bun_new_array_buffer_copy(
    instance.ctx,
    bufferOut,
    bufferBytes,
    bufferBytes.length,
  );
  using buffer = new JSValue(instance, bufferOut, true);
  const byteLengthCell = new Uint8Array(8);
  const data = quickJSNative.qjs_bun_get_array_buffer(instance.ctx, byteLengthCell, buffer.ptr);
  if (data === null) throw new Error("JS_GetArrayBuffer returned null");
  const byteLength = Number(readU64(byteLengthCell));
  expect([...new Uint8Array(toArrayBuffer(data, 0, byteLength))]).toEqual([1, 2, 3]);

  const externalOut = valueCell();
  quickJSNative.qjs_bun_new_array_buffer(
    instance.ctx,
    externalOut,
    ptr(bufferBytes),
    bufferBytes.length,
    null,
    null,
    0,
  );
  using external = new JSValue(instance, externalOut, true);
  instance.setGlobal("buffer", external);
  using externalData = instance.evalCode("new Uint8Array(buffer).join(',')");
  expect(externalData.toString()).toBe("1,2,3");

  using typedArray = instance.evalCode("new Uint8Array([4, 5])");
  const typedBufferOut = valueCell();
  quickJSNative.qjs_bun_get_typed_array_buffer(
    instance.ctx,
    typedArray.ptr,
    null,
    null,
    null,
    typedBufferOut,
  );
  using typedBuffer = new JSValue(instance, typedBufferOut, true);
  const typedByteLength = new Uint8Array(8);
  const typedData = quickJSNative.qjs_bun_get_array_buffer(
    instance.ctx,
    typedByteLength,
    typedBuffer.ptr,
  );
  if (typedData === null) throw new Error("JS_GetArrayBuffer returned null");
  expect([
    ...new Uint8Array(toArrayBuffer(typedData, 0, Number(readU64(typedByteLength)))),
  ]).toEqual([4, 5]);
});

test("evaluates code and exposes raw JSValue objects", () => {
  const instance = vm();
  using result = instance.evalCode("1 + 2");
  expect(result.toNumber()).toBe(3);
  using strict = instance.evalCode("function f(){ return this } f()", {
    flags: QuickJSEvalFlags.TYPE_GLOBAL | QuickJSEvalFlags.STRICT,
  });
  expect(strict.type).toBe("undefined");
  instance
    .evalCode("globalThis.meta = import.meta.url", {
      filename: "/tmp/quickjs-bun-module.js",
      flags: QuickJSEvalFlags.TYPE_MODULE,
    })
    .dispose();
  using meta = instance.getGlobal("meta");
  expect(meta.toString()).toBe("file:///tmp/quickjs-bun-module.js");
  using fn = instance.evalCode("() => 42");
  using called = instance.callFunction(fn);
  expect(called.toNumber()).toBe(42);
  using bytecode = instance.compileCode("40 + 2");
  using bytecodeResult = instance.evalFunction(bytecode);
  expect(bytecodeResult.toNumber()).toBe(42);
  expect(instance.runtime.memoryUsedBytes() > 0n).toBe(true);
});

test("wraps context-level native helpers directly", () => {
  const instance = vm();
  expect(instance.detectModule("export const value = 1;")).toBe(true);
  expect(instance.detectModule("const value = 1;")).toBe(false);
  expect(instance.hasException()).toBe(false);
  quickJSNative.qjs_bun_throw_type_error(instance.ctx, encoder.encode("manual\0"), valueCell());
  expect(instance.hasException()).toBe(true);
  using manualException = instance.getException();
  expect(manualException.name).toBe("TypeError");
  expect(manualException.message).toBe("manual");
  expect(instance.hasException()).toBe(false);

  using atom = instance.newAtom("alpha");
  expect(atom.toString()).toBe("alpha");
  using atomValue = atom.toValue();
  expect(atomValue.toString()).toBe("alpha");
  using atomString = atom.toStringValue();
  expect(atomString.toString()).toBe("alpha");
  using atomCopy = atom.dup();
  expect(atomCopy.toString()).toBe("alpha");
  using numberAtom = instance.newAtom(7);
  expect(numberAtom.toString()).toBe("7");
  using uint32Atom = instance.newAtomUInt32(8);
  expect(uint32Atom.toString()).toBe("8");

  using receiver = instance.newValue({ base: 40 });
  using evalThis = instance.evalThis(receiver, "this.base + 2");
  expect(evalThis.toNumber()).toBe(42);

  using parsed = instance.parseJson('{"answer":42}');
  expect(instance.dump(parsed)).toEqual({ answer: 42 });
  using parsedExt = instance.parseJsonExt('{"answer":42}');
  expect(instance.dump(parsedExt)).toEqual({ answer: 42 });
  using jsonText = instance.jsonStringify(parsed);
  expect(jsonText.toString()).toBe('{"answer":42}');

  using bool = instance.newBoolean(true);
  expect(bool.toBoolean()).toBe(true);
  using int32 = instance.newInt32(-42);
  expect(int32.toNumber()).toBe(-42);
  using int64 = instance.newInt64(42n);
  expect(int64.toNumber()).toBe(42);
  using uint32 = instance.newUint32(0xffffffff);
  expect(uint32.toNumber()).toBe(0xffffffff);
  using float64 = instance.newFloat64(1.5);
  expect(float64.float64Value).toBe(1.5);
  using catchOffset = instance.newCatchOffset(7);
  expect(catchOffset.normTag).toBe(QuickJSValueTag.CATCH_OFFSET);
  using atomized = instance.newAtomString("atomized");
  expect(atomized.toString()).toBe("atomized");
  using date = instance.newDate(0);
  instance.setGlobal("date", date);
  using iso = instance.evalCode("date.toISOString()");
  expect(iso.toString()).toBe("1970-01-01T00:00:00.000Z");

  using buffer = instance.newArrayBufferCopy(new Uint8Array([1, 2, 3]));
  expect([...buffer.arrayBufferBytes()]).toEqual([1, 2, 3]);
  using length = instance.newNumber(3);
  using typedArray = instance.newTypedArray(QuickJSTypedArray.UINT8, length);
  expect(typedArray.length).toBe(3);
});

test("wraps value-level native helpers directly", () => {
  const instance = vm();
  using object = instance.evalCode("({ base: 40, add(value) { return this.base + value } })");
  using two = instance.newNumber(2);
  using sum = object.invoke("add", two);
  expect(sum.toNumber()).toBe(42);
  expect(object.print()).toContain("base: 40");
  using printable = instance.newValue({ nested: { ok: true }, text: "abcdef", values: [1, 2, 3] });
  expect(printable.print({ maxDepth: 1, maxItemCount: 1 })).toContain("... 2 more items");
  using printableText = instance.newString("abcdef");
  expect(printableText.print({ maxStringLength: 3 })).toContain('"abc"... 3 more characters');
  expect(() => printable.print({ maxDepth: -1 })).toThrow("maxDepth");
  expect(object.hasProp("base")).toBe(true);
  expect(object.deleteProp("base")).toBe(true);
  expect(object.hasProp("base")).toBe(false);

  using prototype = instance.newValue({ kind: "proto" });
  object.setPrototype(prototype);
  using objectPrototype = object.getPrototype();
  expect(objectPrototype.strictEquals(prototype)).toBe(true);
  using kind = object.getProp("kind");
  expect(kind.toString()).toBe("proto");
  expect(object.preventExtensions()).toBe(true);
  expect(object.isExtensible()).toBe(false);

  using Box = instance.evalCode("class Box { constructor(value) { this.value = value } } Box");
  expect(Box.isConstructor()).toBe(true);
  using instanceValue = Box.construct(two);
  expect(instanceValue.isInstanceOf(Box)).toBe(true);
  using value = instanceValue.getProp("value");
  expect(value.toNumber()).toBe(2);

  using zero = instance.evalCode("-0");
  using positiveZero = instance.evalCode("0");
  using nanA = instance.evalCode("NaN");
  using nanB = instance.evalCode("NaN");
  expect(zero.strictEquals(positiveZero)).toBe(true);
  expect(zero.sameValue(positiveZero)).toBe(false);
  expect(zero.sameValueZero(positiveZero)).toBe(true);
  expect(nanA.strictEquals(nanB)).toBe(false);
  expect(nanA.sameValue(nanB)).toBe(true);
  expect(nanA.sameValueZero(nanB)).toBe(true);

  using number = instance.newNumber(123);
  expect(number.isNumber()).toBe(true);
  expect(number.isNaN()).toBe(false);
  using text = number.coerceToString();
  expect(text.isString()).toBe(true);
  expect(text.toString()).toBe("123");
  using keySource = instance.evalCode("({ toString() { return 'name' } })");
  expect(keySource.isObject()).toBe(true);
  using key = keySource.toPropertyKey();
  expect(key.toString()).toBe("name");

  using typedArray = instance.evalCode("new Uint8Array([4, 5])");
  using buffer = typedArray.typedArrayBuffer();
  expect([...buffer.arrayBufferBytes()]).toEqual([4, 5]);
  using view = instance.evalCode("new Uint8Array([4, 5]).subarray(1)");
  const viewInfo = view.typedArrayInfo();
  try {
    expect(viewInfo.byteOffset).toBe(1);
    expect(viewInfo.byteLength).toBe(1);
    expect(viewInfo.bytesPerElement).toBe(1);
    expect([...viewInfo.buffer.arrayBufferBytes()]).toEqual([4, 5]);
  } finally {
    viewInfo.buffer.dispose();
  }

  using serializable = instance.newValue({ answer: 42 });
  const encoded = serializable.writeObject(QuickJSWriteObjectFlags.REFERENCE);
  using decoded = instance.readObject(encoded, QuickJSReadObjectFlags.REFERENCE);
  expect(instance.dump(decoded)).toEqual({ answer: 42 });

  using numericString = instance.newString("42");
  expect(numericString.coerceToBoolean()).toBe(true);
  expect(numericString.coerceToNumber()).toBe(42);
  expect(numericString.coerceToInt32()).toBe(42);
  expect(numericString.coerceToUint32()).toBe(42);
  expect(numericString.coerceToInt64()).toBe(42n);
  expect(numericString.coerceToIndex()).toBe(42n);
  using bigint = instance.evalCode("42n");
  expect(bigint.isBigInt()).toBe(true);
  expect(bigint.coerceToBigInt64()).toBe(42n);
  expect(bigint.coerceToInt64Ext()).toBe(42n);
  expect(instance.true.isBoolean()).toBe(true);
  expect(instance.null.isNull()).toBe(true);
  expect(instance.undefined.isUndefined()).toBe(true);
  using symbol = instance.evalCode("Symbol('x')");
  expect(symbol.isSymbol()).toBe(true);
  using nan = instance.evalCode("NaN");
  expect(nan.isNaN()).toBe(true);

  const exceptionCell = valueCell();
  quickJSNative.qjs_bun_throw_type_error(instance.ctx, encoder.encode("boom\0"), exceptionCell);
  using exception = new JSValue(instance, exceptionCell, true);
  expect(exception.isException()).toBe(true);
  const pendingException = valueCell();
  quickJSNative.qjs_bun_get_exception(instance.ctx, pendingException);
  new JSValue(instance, pendingException, true).dispose();
  const uninitializedCell = valueCell();
  new DataView(uninitializedCell.buffer).setBigInt64(
    8,
    BigInt(QuickJSValueTag.UNINITIALIZED),
    true,
  );
  const uninitialized = new JSValue(instance, uninitializedCell, false);
  expect(uninitialized.isUninitialized()).toBe(true);

  using detachable = instance.newArrayBufferCopy(new Uint8Array([1]));
  detachable.detachArrayBuffer();
  instance.setGlobal("detachable", detachable);
  using byteLength = instance.evalCode("detachable.byteLength");
  expect(byteLength.toNumber()).toBe(0);

  using dynamicKey = instance.newString("dynamicKey");
  using atom = dynamicKey.toAtom();
  expect(atom.toString()).toBe("dynamicKey");
  expect(dynamicKey.normTag).toBe(QuickJSValueTag.STRING);

  using descriptorObject = instance.newObject();
  using hidden = instance.newString("secret");
  descriptorObject.defineProp("hidden", hidden, QuickJSPropertyFlags.CONFIGURABLE);
  expect(descriptorObject.keys()).toEqual([]);
  descriptorObject.defineProps({ count: 2, first: "one" });
  using firstProp = descriptorObject.getProp("first");
  expect(firstProp.toString()).toBe("one");
  using countProp = descriptorObject.getProp("count");
  expect(countProp.toNumber()).toBe(2);
  using hiddenValue = descriptorObject.getDataProp("hidden");
  expect(hiddenValue.toString()).toBe("secret");
  using getter = instance.evalCode("(function(){ return this.marker })");
  using setter = instance.evalCode("(function(){})");
  descriptorObject.definePropGetSet(
    "markerValue",
    getter,
    setter,
    QuickJSPropertyFlags.CONFIGURABLE,
  );
  using marker = instance.newNumber(42);
  descriptorObject.defineProp("marker", marker);
  using markerValue = descriptorObject.getPropWithReceiver("markerValue", descriptorObject);
  expect(markerValue.toNumber()).toBe(42);

  using indexed = instance.newArray();
  using first = instance.newString("first");
  using third = instance.newString("third");
  indexed.defineIndex(0, first);
  indexed.setIndex64(2n, third);
  using firstValue = indexed.getIndex(0);
  using thirdValue = indexed.getIndex(2);
  expect(firstValue.toString()).toBe("first");
  expect(thirdValue.toString()).toBe("third");

  using Fn = instance.evalCode("(function Fn() {})");
  using proto = instance.newObject();
  Fn.setConstructor(proto);
  Fn.setConstructorBit(true);
  expect(Fn.isConstructor()).toBe(true);

  using htmlDDA = instance.newObject();
  htmlDDA.setIsHTMLDDA();
  instance.setGlobal("htmlDDA", htmlDDA);
  using htmlDDASemantics = instance.evalCode(
    "({ type: typeof htmlDDA, nullish: htmlDDA == null })",
  );
  expect(instance.dump(htmlDDASemantics)).toEqual({ type: "undefined", nullish: true });
});

test("dumps primitive and JSON values explicitly", () => {
  const instance = vm();
  using string = instance.evalCode("'hello'");
  using emptyString = instance.evalCode("''");
  using nulString = instance.evalCode("'a\\0b'");
  using object = instance.evalCode("({ ok: true, values: [1, 'two', null] })");
  using emptyKeyObject = instance.evalCode("({'': 1})");
  using nulKeyObject = instance.evalCode("({'a\\0b': 1})");
  using empty = instance.evalCode("({})");
  using bigint = instance.evalCode("123n");
  const uint64 = 1n << 63n;
  const hugeBigint = 1n << 100n;
  const negativeHugeBigint = -(1n << 100n);
  using uint64Value = instance.newValue(uint64);
  using hugeBigintValue = instance.newValue(hugeBigint);
  using negativeHugeBigintValue = instance.newValue(negativeHugeBigint);

  expect(instance.dump(string)).toBe("hello");
  expect(emptyString.toString()).toBe("");
  expect(nulString.toString()).toBe("a\0b");
  expect(instance.dump(object)).toEqual({ ok: true, values: [1, "two", null] });
  expect(emptyKeyObject.keys()).toEqual([""]);
  expect(nulKeyObject.keys()).toEqual(["a\0b"]);
  expect(instance.dump(nulKeyObject)).toEqual({ ["a\0b"]: 1 });
  expect(instance.dump(empty)).toEqual({});
  using hostNulKeyObject = instance.newValue({ "": 2, ["a\0b"]: 3 });
  instance.setGlobal("hostNulKeyObject", hostNulKeyObject);
  using hostEmptyKeyValue = instance.evalCode('hostNulKeyObject[""]');
  using hostNulKeyValue = instance.evalCode('hostNulKeyObject["a\\0b"]');
  expect(hostEmptyKeyValue.toNumber()).toBe(2);
  expect(hostNulKeyValue.toNumber()).toBe(3);
  using protoKey = instance.newValue(JSON.parse('{"__proto__":{"polluted":true}}'));
  instance.setGlobal("protoKey", protoKey);
  using protoResult = instance.evalCode(`({
    own: Object.prototype.hasOwnProperty.call(protoKey, "__proto__"),
    protoIsObjectPrototype: Object.getPrototypeOf(protoKey) === Object.prototype,
    polluted: protoKey.__proto__.polluted,
  })`);
  expect(instance.dump(protoResult)).toEqual({
    own: true,
    protoIsObjectPrototype: true,
    polluted: true,
  });
  using quickProtoKey = instance.evalCode('JSON.parse("{\\"__proto__\\":{\\"polluted\\":true}}")');
  const dumpedProtoKey = instance.dump(quickProtoKey) as Record<string, unknown>;
  expect(Object.prototype.hasOwnProperty.call(dumpedProtoKey, "__proto__")).toBe(true);
  expect(Object.getPrototypeOf(dumpedProtoKey)).toBe(Object.prototype);
  expect(dumpedProtoKey["__proto__"]).toEqual({ polluted: true });
  expect(instance.dump(bigint)).toBe(123n);
  expect(instance.dump(uint64Value)).toBe(uint64);
  expect(instance.dump(hugeBigintValue)).toBe(hugeBigint);
  expect(instance.dump(negativeHugeBigintValue)).toBe(negativeHugeBigint);
});

test("dumps cycles by QuickJS object identity", () => {
  const instance = vm();
  using cycle = instance.evalCode("const value = { name: 'cycle' }; value.self = value; value");
  const dumped = instance.dump(cycle) as { name: string; self: unknown };
  expect(dumped.name).toBe("cycle");
  expect(dumped.self).toBe(dumped);

  using arrayCycle = instance.evalCode("{ const value = []; value.push(value); value }");
  const dumpedArray = instance.dump(arrayCycle) as unknown[];
  expect(dumpedArray[0]).toBe(dumpedArray);
});

test("uses explicit value types and refuses lossy conversion", () => {
  const instance = vm();
  using fn = instance.evalCode("() => 1");
  using string = instance.evalCode("'1'");
  using number = instance.evalCode("1");
  using float = instance.evalCode("1.5");
  using negativeZero = instance.evalCode("-0");
  using boolean = instance.evalCode("true");
  using bigint = instance.evalCode("1n");
  expect(fn.type).toBe("function");
  expect(() => instance.dump(fn)).toThrow("Cannot dump QuickJS function");
  expect(float.toNumber()).toBe(1.5);
  expect(Object.is(negativeZero.toNumber(), -0)).toBe(true);
  expect(() => string.toNumber()).toThrow("Cannot convert QuickJS string to number");
  expect(() => number.toString()).toThrow("Cannot convert QuickJS number to string");
  expect(() => boolean.toNumber()).toThrow("Cannot convert QuickJS boolean to number");
  expect(() => bigint.toString()).toThrow("Cannot convert QuickJS bigint to string");
  expect(() => string.toError()).toThrow("Cannot convert QuickJS string to error");
  expect(bigint.toBigInt()).toBe(1n);
  expect(() => instance.newValue(() => {})).toThrow("Cannot convert host function");
  expect(() => instance.newValue(new Date())).toThrow("Only plain objects");
  let getterCalled = false;
  expect(() =>
    instance.newValue({
      get value() {
        getterCalled = true;
        return 1;
      },
    }),
  ).toThrow("Only data properties");
  expect(getterCalled).toBe(false);

  using proxy = instance.evalCode("new Proxy({}, { ownKeys() { throw new Error('boom') } })");
  expect(() => proxy.keys()).toThrow("boom");

  using revokedProxy = instance.evalCode(
    "const item = Proxy.revocable([], {}); item.revoke(); item.proxy",
  );
  expect(() => revokedProxy.type).toThrow("revoked");
});

test("rejects values from other VMs", () => {
  const left = vm();
  const right = vm();
  using foreign = right.newString("foreign");
  using object = left.newObject();
  using fn = left.evalCode("(value) => value");

  expect(() => left.newValue(foreign)).toThrow("another VM");
  expect(() => left.dump(foreign)).toThrow("another VM");
  expect(() => left.setGlobal("foreign", foreign)).toThrow("another VM");
  expect(() => left.callFunction(fn, left.undefined, foreign)).toThrow("another VM");
  expect(() => object.setProp("foreign", foreign)).toThrow("another VM");
});

test("rejects disposed values", () => {
  const instance = vm();
  const value = instance.newString("done");
  value.dispose();
  expect(() => value.toString()).toThrow("disposed");
  expect(() => value.dup()).toThrow("disposed");

  instance.undefined.dispose();
  using undefinedValue = instance.newValue(undefined);
  expect(undefinedValue.type).toBe("undefined");
});

test("rejects host functions returning values from other VMs", () => {
  const left = vm();
  const right = vm();
  using foreign = right.newString("foreign");
  using host = left.newFunction(() => foreign);
  left.setGlobal("host", host);
  expect(() => left.evalCode("host()")).toThrow("another VM");
});

test("does not expose host capabilities by default", () => {
  const instance = vm();
  using result = instance.evalCode(
    "({ bun: typeof Bun, process: typeof process, console: typeof console, std: typeof std, os: typeof os })",
  );
  expect(instance.dump(result)).toEqual({
    bun: "undefined",
    process: "undefined",
    console: "undefined",
    std: "undefined",
    os: "undefined",
  });
});

test("does not include QuickJS std or os modules", () => {
  const instance = vm({ timeoutMs: 5000 });
  expect("enableStd" in instance).toBe(false);
  expect(() =>
    instance.evalCode('import * as std from "std";', {
      flags: QuickJSEvalFlags.TYPE_MODULE,
      timeoutMs: 5000,
    }),
  ).toThrow();
  expect(() =>
    instance.evalCode('import * as os from "os";', {
      flags: QuickJSEvalFlags.TYPE_MODULE,
      timeoutMs: 5000,
    }),
  ).toThrow();
});

test("does not include QuickJS Atomics", () => {
  const instance = vm();
  using result = instance.evalCode(`
    ({
      atomics: typeof Atomics,
      sharedArrayBuffer: typeof SharedArrayBuffer,
    })
  `);
  expect(instance.dump(result)).toEqual({
    atomics: "undefined",
    sharedArrayBuffer: "function",
  });
});

test("throws QuickJS exceptions as host exceptions", () => {
  const instance = vm();
  expect(() => instance.evalCode("throw new TypeError('nope')")).toThrow(JSException);
  try {
    instance.evalCode("throw new TypeError('nope')");
  } catch (error) {
    expect(error).toMatchObject({ name: "TypeError", message: "nope" });
    expect(error).toBeInstanceOf(JSException);
    (error as JSException).dispose();
    expect(() => (error as JSException).value.toString()).toThrow("disposed");
  }
  for (const [source, message] of [
    ["throw null", "null"],
    ["throw undefined", "undefined"],
    ["throw Symbol('x')", "QuickJS symbol was thrown"],
    ["throw ({ get message(){ throw new Error('getter') } })", "QuickJS object was thrown"],
  ]) {
    try {
      instance.evalCode(source);
    } catch (error) {
      expect(error).toMatchObject({ name: "JSException", message });
    }
  }
  try {
    instance.evalCode(`
      globalThis.errorGetterCalled = false;
      const error = new Error("safe");
      Object.defineProperty(error, "message", {
        get() {
          globalThis.errorGetterCalled = true;
          return "unsafe";
        },
      });
      throw error;
    `);
  } catch (error) {
    expect(error).toMatchObject({ name: "Error", message: "Error" });
  }
  using called = instance.getGlobal("errorGetterCalled");
  expect(called.toBoolean()).toBe(false);
  try {
    instance.evalCode(`
      globalThis.errorProtoTrapped = false;
      {
        const error = new Error("safe");
        Object.setPrototypeOf(error, new Proxy({}, {
          getOwnPropertyDescriptor() {
            globalThis.errorProtoTrapped = true;
            return { value: "unsafe", configurable: true };
          },
        }));
        throw error;
      }
    `);
  } catch (error) {
    expect(error).toMatchObject({ name: "Error", message: "safe" });
  }
  using protoTrapped = instance.getGlobal("errorProtoTrapped");
  expect(protoTrapped.toBoolean()).toBe(false);
});

test("enforces execution timeouts", () => {
  const instance = vm({ timeoutMs: 25 });
  expect(() => instance.evalCode("while (true) {}")).toThrow("timed out");
  using fn = instance.evalCode("() => { while (true) {} }");
  expect(() => instance.callFunction(fn)).toThrow("timed out");
  using getter = instance.evalCode("({ get value() { while (true) {} } })");
  expect(() => instance.dump(getter)).toThrow("timed out");
});

test("enforces memory limits", () => {
  const instance = vm({ memoryBytes: 1024 * 1024 });
  expect(() =>
    instance.evalCode(
      "const items = []; while (true) items.push(new Array(1000).fill('x').join(''))",
    ),
  ).toThrow();
});

test("enforces stack limits", () => {
  const instance = vm({ stackBytes: 64 * 1024 });
  expect(() => instance.evalCode("{ function f(){ return f() + 1 } f() }")).toThrow(
    "stack overflow",
  );
});

test("throws constructor exceptions instead of returning exception values", () => {
  const instance = vm({ memoryBytes: 128 * 1024 });
  expect(() => instance.newString("x".repeat(128 * 1024))).toThrow(JSException);
});

test("sets and gets globals with values", () => {
  const instance = vm();
  instance
    .evalCode(
      'Object.defineProperty(globalThis, "config", { set() { throw new Error("setter") }, configurable: true })',
    )
    .dispose();
  using value = instance.newValue({ name: "Ada", retries: 3 });
  instance.setGlobal("config", value);

  using result = instance.evalCode("config.name + ':' + config.retries");
  expect(result.toString()).toBe("Ada:3");
});

test("calls host functions with value arguments", () => {
  const instance = vm();
  using add = instance.newFunction((_left, _right) => {
    return instance.newNumber(_left.toNumber() + _right.toNumber());
  });
  instance.setGlobal("add", add);

  using result = instance.evalCode("add(20, 22)");
  expect(result.toNumber()).toBe(42);

  let returned: JSValue | undefined;
  using makeString = instance.newFunction(() => {
    returned = instance.newString("owned");
    return returned;
  });
  instance.setGlobal("makeString", makeString);
  using stringResult = instance.evalCode("makeString()");
  expect(stringResult.toString()).toBe("owned");
  expect(() => returned!.ptr).toThrow("disposed");

  using object = instance.newObject();
  using readThis = instance.newFunction(function () {
    return this;
  });
  object.setProp("readThis", readThis);
  instance.setGlobal("box", object);
  using sameThis = instance.evalCode("box.readThis() === box");
  expect(sameThis.toBoolean()).toBe(true);
});

test("throws host function exceptions into QuickJS", () => {
  const instance = vm();
  instance
    .evalCode(`
    Object.defineProperty(Error.prototype, "message", { set() { throw new Error("setter") } });
    Object.defineProperty(Error.prototype, "name", { set() { throw new Error("setter") } });
  `)
    .dispose();
  using fail = instance.newFunction(() => {
    throw new TypeError("host boom");
  });
  instance.setGlobal("fail", fail);
  expect(() => instance.evalCode("fail()")).toThrow(JSException);
  using stack = instance.evalCode("try { fail() } catch (error) { error.stack }");
  expect(stack.toString()).not.toContain(import.meta.url);
});

test("creates and resolves deferred promises", () => {
  const instance = vm();
  using deferred = instance.newPromise();
  using global = instance.global;
  global.setProp("pending", deferred.promise);

  using continuation = instance.evalCode("pending.then(value => value + 1)");
  expect(continuation.promiseState).toBe(QuickJSPromiseState.PENDING);
  expect(() => continuation.promiseResult()).toThrow("pending");
  using value = instance.newNumber(41);
  deferred.resolve(value);
  expect(instance.runtime.hasPendingJob()).toBe(true);
  instance.runtime.executePendingJobs();
  expect(continuation.promiseState).toBe(QuickJSPromiseState.FULFILLED);
  expect(instance.runtime.hasPendingJob()).toBe(false);

  using result = continuation.promiseResult();
  expect(result.toNumber()).toBe(42);
});

test("host functions return duplicates for retained values", () => {
  const instance = vm();
  using deferred = instance.newPromise();
  using start = instance.newFunction(() => deferred.promise.dup());
  instance.setGlobal("start", start);

  using continuation = instance.evalCode("start().then(value => value + 1)");
  using value = instance.newNumber(41);
  deferred.resolve(value);
  instance.runtime.executePendingJobs();

  using result = continuation.promiseResult();
  expect(result.toNumber()).toBe(42);
});

test("runs async host promises concurrently", async () => {
  const instance = vm({ timeoutMs: 5_000 });
  let active = 0;
  let maxActive = 0;
  const tasks = new Set<{
    deferred: Deferred;
    settled: Promise<void>;
    timeout: ReturnType<typeof setTimeout>;
  }>();

  using delay = instance.newFunction((msValue) => {
    const ms = msValue.toNumber();
    const deferred = instance.newPromise();
    const promise = deferred.promise.dup();
    let settleTask!: () => void;
    let task: {
      deferred: Deferred;
      settled: Promise<void>;
      timeout: ReturnType<typeof setTimeout>;
    };
    active++;
    maxActive = Math.max(maxActive, active);
    const timeout = setTimeout(() => {
      tasks.delete(task);
      active--;
      using value = instance.newNumber(ms);
      deferred.resolve(value);
      deferred.dispose();
      settleTask();
    }, ms);
    task = {
      deferred,
      settled: new Promise<void>((resolve) => {
        settleTask = resolve;
      }),
      timeout,
    };
    tasks.add(task);
    return promise;
  });
  instance.setGlobal("delay", delay);

  try {
    using promise = instance.evalCode(
      "await Promise.all([delay(50), delay(50)]).then(values => values.join(','))",
      {
        flags: QuickJSEvalFlags.TYPE_GLOBAL | QuickJSEvalFlags.ASYNC,
      },
    );
    while (promise.promiseState === QuickJSPromiseState.PENDING) {
      if (instance.runtime.executePendingJob(5_000)) continue;
      const pendingTasks = [...tasks];
      expect(pendingTasks.length).toBeGreaterThan(0);
      await Promise.race(pendingTasks.map((task) => task.settled));
    }
    using result = promise.promiseResult();
    if (promise.promiseState === QuickJSPromiseState.REJECTED) throw new JSException(result.dup());
    expect(instance.dump(result)).toEqual({ value: "50,50" });
    expect(maxActive).toBe(2);
  } finally {
    for (const task of tasks) {
      clearTimeout(task.timeout);
      task.deferred.dispose();
    }
    tasks.clear();
  }
});

test("rejects reading non-promise results", () => {
  const instance = vm();
  using value = instance.newNumber(1);
  expect(value.promiseState).toBe(QuickJSPromiseState.NOT_PROMISE);
  expect(() => value.promiseResult()).toThrow("not a promise");
});

test("new VMs start with isolated sandbox state", () => {
  const first = vm();
  first.evalCode("globalThis.secret = 123").dispose();

  const second = vm();
  using result = second.evalCode("typeof globalThis.secret");
  expect(result.toString()).toBe("undefined");
});

test("rejects invalid runtime limits", () => {
  expect(() => new JSRuntime({ library, memoryBytes: Number.POSITIVE_INFINITY })).toThrow(
    "memoryBytes",
  );
  expect(() => new JSRuntime({ library, stackBytes: 1.5 })).toThrow("stackBytes");
  const instance = vm();
  expect(() => instance.evalCode("1", { timeoutMs: Number.NaN })).toThrow("timeoutMs");
});

test("keeps the outer timeout armed across re-entrant host calls", () => {
  const instance = vm({ timeoutMs: 50 });
  using reenter = instance.newFunction(() => {
    instance.evalCode("1 + 1").dispose();
    return instance.undefined;
  });
  instance.setGlobal("reenter", reenter);
  expect(() => instance.evalCode("reenter(); while (true) {}")).toThrow("timed out");
});

test("rejects a zero stack size that would disable the guest stack guard", () => {
  expect(() => new JSRuntime({ library, stackBytes: 0 })).toThrow("stackBytes");
});

test("detects modules without reading past the source buffer", () => {
  const instance = vm();
  for (const code of ["", "/", "/*", "\\", "import", "export", "//"]) {
    expect(typeof instance.detectModule(code)).toBe("boolean");
  }
  expect(instance.detectModule("export const value = 1;")).toBe(true);
  expect(instance.detectModule("const value = 1;")).toBe(false);
});

test("disposes host argument handles after the call returns", () => {
  const instance = vm();
  let saved: JSValue | undefined;
  using capture = instance.newFunction((arg) => {
    saved = arg;
    return instance.newNumber(arg.toNumber());
  });
  instance.setGlobal("capture", capture);
  using result = instance.evalCode("capture(42)");
  expect(result.toNumber()).toBe(42);
  expect(saved).toBeDefined();
  expect(() => saved!.ptr).toThrow("disposed");
});

test("bounds dump recursion depth instead of overflowing the host stack", () => {
  const instance = vm({ timeoutMs: 5000 });
  using deep = instance.evalCode("let o = {}; for (let i = 0; i < 5000; i++) o = { a: o }; o");
  expect(() => instance.dump(deep)).toThrow("depth");
  expect(() => instance.dump(deep, { maxDepth: 3 })).toThrow("depth");
});

test("bounds dump node count for huge collections", () => {
  const instance = vm({ timeoutMs: 5000 });
  using wide = instance.evalCode("const a = []; a.length = 5_000_000; a");
  expect(() => instance.dump(wide, { maxNodes: 1000 })).toThrow("values");
});

test("times out direct JSValue.dump on malicious getters", () => {
  const instance = vm({ timeoutMs: 25 });
  using getter = instance.evalCode("({ get value() { while (true) {} } })");
  expect(() => getter.dump()).toThrow("timed out");
});

test("rejects NUL characters in names and filenames", () => {
  const instance = vm();
  expect(() => instance.evalCode("1", { filename: "a\0b" })).toThrow("NUL");
  expect(() => instance.newAtomString("a\0b")).toThrow("NUL");
});

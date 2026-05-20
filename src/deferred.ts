import { JSValue } from "./value";

export class Deferred {
  constructor(
    readonly promise: JSValue,
    readonly resolveFunction: JSValue,
    readonly rejectFunction: JSValue,
  ) {
    promise.vm.assertSameVM(resolveFunction, rejectFunction);
  }

  resolve(value: JSValue): void {
    this.promise.vm.callFunction(this.resolveFunction, this.promise.vm.undefined, value).dispose();
  }

  reject(value: JSValue): void {
    this.promise.vm.callFunction(this.rejectFunction, this.promise.vm.undefined, value).dispose();
  }

  dispose(): void {
    this.promise.dispose();
    this.resolveFunction.dispose();
    this.rejectFunction.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

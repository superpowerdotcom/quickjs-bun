import { JSValue } from "./value";

export class JSException extends Error {
  readonly value: JSValue;

  constructor(value: JSValue) {
    const isError = value.type === "error";
    const name = isError ? (value.errorProperty("name") ?? "Error") : "JSException";
    const message = isError ? (value.errorProperty("message") ?? "Error") : value.thrownMessage();
    super(message);
    this.name = name;
    if (isError) this.stack = value.errorProperty("stack") ?? this.stack;
    this.value = value;
  }

  dispose(): void {
    this.value.dispose();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}

import { describe, expect, it } from "vitest";
import * as entry from "../src/index";

describe("the entry module", () => {
  // workerd refuses to start a Worker whose main module exports anything
  // but handlers, which the tests' runtime doesn't check.
  it("exports only the Worker", () => {
    expect(Object.keys(entry)).toEqual(["default"]);
  });
});

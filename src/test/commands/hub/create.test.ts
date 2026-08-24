import { afterEach, describe, expect, it } from "vitest";
import { BaselineFileState } from "@itwin/imodels-client-authoring";
import { Constants } from "@itwin/imodels-client-management";
import {
  applyInitializationTimeout,
  DEFAULT_INIT_TIMEOUT_MINUTES,
  interpretBaselineState,
} from "../../../commands/hub/create";

const libraryDefaultMs = Constants.time.iModelInitializationTimeOutInMs;

afterEach(() => {
  applyInitializationTimeout(libraryDefaultMs / 60_000);
});

describe("applyInitializationTimeout", () => {
  it("raises the client's baseline initialization timeout", () => {
    expect(applyInitializationTimeout(30)).toBe(30 * 60_000);
    expect(Constants.time.iModelInitializationTimeOutInMs).toBe(30 * 60_000);
  });

  it("accepts fractional minutes", () => {
    expect(applyInitializationTimeout(1.5)).toBe(90_000);
  });

  it("rejects values that are not a positive number of minutes", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => applyInitializationTimeout(bad)).toThrow(/init-timeout-minutes/);
  });

  it("defaults to more than the client's own 5 minute default", () => {
    // The whole point of the option: 5 minutes is not enough for a large baseline file.
    expect(DEFAULT_INIT_TIMEOUT_MINUTES * 60_000).toBeGreaterThan(libraryDefaultMs);
  });
});

describe("interpretBaselineState", () => {
  it("reports an initialized baseline as done", () => {
    expect(interpretBaselineState(BaselineFileState.Initialized)).toBe("initialized");
  });

  it("keeps waiting while the hub is still working", () => {
    expect(interpretBaselineState(BaselineFileState.InitializationScheduled)).toBe("pending");
    expect(interpretBaselineState(BaselineFileState.WaitingForFile)).toBe("pending");
  });

  it("treats terminal states as unrecoverable", () => {
    expect(() => interpretBaselineState(BaselineFileState.InitializationFailed))
      .toThrow(/initializationFailed/);
    expect(() => interpretBaselineState(BaselineFileState.FileIsBriefcase))
      .toThrow(/fileIsBriefcase/);
  });
});

import { afterAll, describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { evaluate } from "./admin-fixtures.ts";

const themeScript = readFileSync(join(import.meta.dirname, "../site/src/theme.js"), "utf8");

describe("theme.js", () => {
  const opened: Window[] = [];
  afterAll(async () => {
    await Promise.all(opened.map((w) => w.happyDOM.close()));
  });

  const makeWindow = (prefersColorScheme: "light" | "dark") => {
    const window = new Window({
      url: "http://admin.localhost/index",
      settings: { device: { prefersColorScheme } },
    });
    opened.push(window);
    return window;
  };

  test.each([
    {
      label: "dark system with site data blocked applies dark theme",
      prefersColorScheme: "dark" as const,
      expected: "dark",
    },
    {
      label: "light system with site data blocked leaves theme unset",
      prefersColorScheme: "light" as const,
      expected: undefined,
    },
  ])("$label", ({ prefersColorScheme, expected }) => {
    const window = makeWindow(prefersColorScheme);
    Object.defineProperty(window, "localStorage", {
      get: () => {
        throw new window.DOMException("site data blocked", "SecurityError");
      },
    });
    evaluate(window, themeScript);
    expect(window.document.documentElement.dataset.theme).toBe(expected);
  });

  test("propagates unexpected storage errors without mutating the document theme", () => {
    const window = makeWindow("dark");
    Object.defineProperty(window, "localStorage", {
      get: () => {
        throw new window.TypeError("storage getter broken");
      },
    });
    expect(() => evaluate(window, themeScript)).toThrow("storage getter broken");
    expect(window.document.documentElement.dataset.theme).toBeUndefined();
  });

  test("stored light choice on a dark system never writes data-theme", () => {
    const window = makeWindow("dark");
    window.localStorage.setItem("theme", "light");
    const observer = new window.MutationObserver(() => {});
    observer.observe(window.document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    evaluate(window, themeScript);
    expect(observer.takeRecords()).toEqual([]);
    expect(window.document.documentElement.dataset.theme).toBeUndefined();
    observer.disconnect();
  });
});
